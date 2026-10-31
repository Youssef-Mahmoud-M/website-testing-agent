import { computed, Injectable, NgZone, OnDestroy, signal } from '@angular/core';
import {
  AgentEvent,
  AgentStatus,
  ChatMessage,
  GeneratedTests,
  getAgentApi,
  LlmConfigInput,
  LlmConfigView,
  LlmTestResult,
  MetricRecord,
  PageModel,
  Screenshot,
  TestPlan,
} from './agent-bridge';

export interface MetricsGroup {
  key: string;
  calls: number;
  avgLatencyMs: number;
  totalTokens: number;
}

export interface MetricsSummary {
  calls: number;
  avgLatencyMs: number;
  avgLlmLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgTokensPerCall: number;
  byPhase: MetricsGroup[];
  byPage: MetricsGroup[];
}

const URL_ONLY = /^(?:(?:please\s+)?(?:explore|open|visit|go to|load)\s+)?(https?:\/\/\S+)\s*$/i;

/** Renderer-side mirror of the agent session that lives in the main process. */
@Injectable({ providedIn: 'root' })
export class AgentService implements OnDestroy {
  private readonly api = getAgentApi();
  private readonly unsubscribe: (() => void) | null;

  readonly available = signal(this.api !== null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly pageModel = signal<PageModel | null>(null);
  readonly testPlan = signal<TestPlan | null>(null);
  readonly generatedTests = signal<GeneratedTests | null>(null);
  readonly selectedCaseCount = computed(() => this.testPlan()?.cases.filter((c) => c.selected).length ?? 0);
  readonly metrics = signal<MetricRecord[]>([]);
  readonly screenshots = signal<Screenshot[]>([]);
  readonly status = signal<AgentStatus>({ status: 'idle', detail: '' });
  readonly busy = computed(() => this.status().status !== 'idle');
  /** Seconds since the agent became busy; 0 when idle. */
  readonly elapsedSec = signal(0);
  private busySince: number | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  readonly error = signal<string | null>(null);
  readonly config = signal<LlmConfigView | null>(null);
  /** 'web' on the website, an OS name on the desktop edition, null without a backend. */
  readonly platform = signal<string | null>(null);
  readonly summary = computed(() => summarise(this.metrics()));

  constructor(private readonly zone: NgZone) {
    this.unsubscribe = this.api?.agent.onEvent((event) => this.zone.run(() => this.onEvent(event))) ?? null;
    void this.loadState();
    void this.loadConfig();
    void this.api?.app.info().then((info) => this.platform.set(info.platform)).catch(() => undefined);
  }

  isUrl(text: string): boolean {
    return URL_ONLY.test(text.trim());
  }

  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    await this.run(async (api) => {
      const match = trimmed.match(URL_ONLY);
      if (match) await api.agent.explore(match[1]);
      else await api.agent.chat(trimmed);
    });
  }

  async explore(url: string): Promise<void> {
    await this.run((api) => api.agent.explore(url));
  }

  async screenshot(label = 'Manual screenshot'): Promise<void> {
    await this.run((api) => api.agent.screenshot(label));
  }

  /** Phase 2: design a plan, or revise the current one with reviewer feedback. */
  async design(feedback: string | null = null): Promise<void> {
    await this.run((api) => api.agent.design(feedback?.trim() || null));
  }

  async setCaseSelected(id: string, selected: boolean): Promise<void> {
    await this.run((api) => api.agent.selectCase(id, selected));
  }

  /** Phase 3: generate the Python test file for the selected cases. */
  async generate(): Promise<GeneratedTests | null> {
    return this.run((api) => api.agent.generate());
  }

  /** Re-run the step behind a failed message. */
  async retry(messageId: string): Promise<void> {
    await this.run((api) => api.agent.retry(messageId));
  }

  /** Opens the OS save dialog in the main process; throws so the Code panel can report in place. */
  async saveTests(): Promise<{ saved: boolean; path: string | null }> {
    return this.call((api) => api.tests.save());
  }

  async copyTests(): Promise<{ copied: boolean; via: string }> {
    return this.call((api) => api.tests.copy());
  }

  async reset(): Promise<void> {
    await this.run(async (api) => {
      await api.session.reset();
      await this.loadState();
    });
  }

  async loadState(): Promise<void> {
    if (!this.api) return;
    const state = await this.api.agent.state();
    this.messages.set(state.messages);
    this.pageModel.set(state.pageModel);
    this.testPlan.set(state.testPlan);
    this.generatedTests.set(state.generatedTests);
    this.metrics.set(state.metrics);
    this.screenshots.set(state.screenshots);
    this.status.set(state.status);
  }

  async loadConfig(): Promise<void> {
    if (!this.api) return;
    this.config.set(await this.api.llm.getConfig());
  }

  /** Throws on failure so the Settings panel can show the error in place. */
  async saveConfig(input: LlmConfigInput): Promise<LlmConfigView> {
    const view = await this.call((api) => api.llm.setConfig(input));
    this.config.set(view);
    return view;
  }

  /** Throws on failure so the Settings panel can show the error in place. */
  async testConfig(): Promise<LlmTestResult> {
    return this.call((api) => api.llm.test());
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
    this.trackElapsed(false);
  }

  private trackElapsed(busy: boolean): void {
    if (busy) {
      if (this.busySince === null) {
        this.busySince = Date.now();
        this.elapsedSec.set(0);
        this.ticker = setInterval(() => this.elapsedSec.set(Math.floor((Date.now() - (this.busySince ?? Date.now())) / 1000)), 1000);
      }
      return;
    }
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.busySince = null;
    this.elapsedSec.set(0);
  }

  private onEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'status':
        this.status.set({ status: event.status, detail: event.detail });
        this.trackElapsed(event.status !== 'idle');
        break;
      case 'message':
        this.messages.update((list) => [...list, event.message]);
        break;
      case 'messageRemoved':
        this.messages.update((list) => list.filter((m) => m.id !== event.id));
        break;
      case 'screenshot':
        this.screenshots.update((list) => [...list, event.screenshot].slice(-40));
        break;
      case 'pageModel':
        this.pageModel.set(event.pageModel);
        break;
      case 'testPlan':
        this.testPlan.set(event.testPlan);
        break;
      case 'generatedTests':
        this.generatedTests.set(event.generatedTests);
        break;
      case 'metric':
        this.metrics.update((list) => [...list, event.metric]);
        break;
      case 'reset':
        this.messages.set([]);
        this.pageModel.set(null);
        this.testPlan.set(null);
        this.generatedTests.set(null);
        this.metrics.set([]);
        this.screenshots.set([]);
        break;
    }
  }

  /** Runs a backend call and rethrows failures with transport prefixes removed. */
  private async call<T>(work: (api: NonNullable<typeof this.api>) => Promise<T>): Promise<T> {
    if (!this.api) throw new Error('Agent backend unavailable.');
    try {
      return await work(this.api);
    } catch (err) {
      throw new Error(cleanError(err));
    }
  }

  /** Runs an IPC call and surfaces failures through the global error notice. */
  private async run<T>(work: (api: NonNullable<typeof this.api>) => Promise<T>): Promise<T | null> {
    this.error.set(null);
    try {
      return await this.call(work);
    } catch (err) {
      this.error.set(cleanError(err));
      return null;
    }
  }
}

function cleanError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': /, '').replace(/^[A-Za-z]*Error: /, '');
}

function group(metrics: MetricRecord[], keyOf: (m: MetricRecord) => string | null): MetricsGroup[] {
  const map = new Map<string, MetricRecord[]>();
  for (const m of metrics) {
    const key = keyOf(m);
    if (!key) continue;
    map.set(key, [...(map.get(key) ?? []), m]);
  }
  return [...map.entries()].map(([key, list]) => ({
    key,
    calls: list.length,
    avgLatencyMs: Math.round(list.reduce((n, m) => n + m.latencyMs, 0) / list.length),
    totalTokens: list.reduce((n, m) => n + m.totalTokens, 0),
  }));
}

export function summarise(metrics: MetricRecord[]): MetricsSummary {
  const calls = metrics.length;
  const sum = (pick: (m: MetricRecord) => number) => metrics.reduce((n, m) => n + pick(m), 0);
  const totalTokens = sum((m) => m.totalTokens);
  return {
    calls,
    avgLatencyMs: calls ? Math.round(sum((m) => m.latencyMs) / calls) : 0,
    avgLlmLatencyMs: calls ? Math.round(sum((m) => m.llmLatencyMs) / calls) : 0,
    inputTokens: sum((m) => m.inputTokens),
    outputTokens: sum((m) => m.outputTokens),
    totalTokens,
    avgTokensPerCall: calls ? Math.round(totalTokens / calls) : 0,
    byPhase: group(metrics, (m) => m.phase),
    byPage: group(metrics, (m) => m.url),
  };
}
