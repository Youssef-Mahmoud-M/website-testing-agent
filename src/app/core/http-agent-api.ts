import {
  AgentApi,
  AgentEvent,
  AgentState,
  BrowserEvent,
  BrowserStatus,
  ChatMessage,
  GeneratedTests,
  LlmConfigInput,
  LlmConfigView,
  LlmTestResult,
  OpenResult,
  PageModel,
  Screenshot,
  TestPlan,
} from './agent-bridge';

/**
 * The website flavour of the agent bridge: the same AgentApi surface the
 * desktop edition exposes, implemented over the server's JSON API and one
 * server-sent-events stream. The rest of the app does not know which one it
 * talks to.
 */
export class HttpAgentApi implements AgentApi {
  private stream: EventSource | null = null;
  private readonly agentListeners = new Set<(event: AgentEvent) => void>();
  private readonly browserListeners = new Set<(event: BrowserEvent) => void>();
  /**
   * The session cookie is issued by the first API response. Several requests
   * are fired at start-up, so without this handshake each would create its
   * own session and the event stream could end up bound to a different session
   * than the one later requests use. Everything waits for this once.
   */
  private ready: Promise<void> | null = null;

  constructor(private readonly base = '/api') {}

  private handshake(): Promise<void> {
    if (!this.ready) {
      this.ready = fetch(`${this.base}/app/info`, { credentials: 'same-origin' })
        .then(() => undefined)
        .catch(() => {
          this.ready = null; // retry on the next call
        });
    }
    return this.ready;
  }

  readonly browser: AgentApi['browser'] = {
    open: (url: string) => this.post<OpenResult>('/browser/open', { url }),
    screenshot: () => this.post<string>('/browser/screenshot'),
    status: () => this.get<BrowserStatus>('/browser/status'),
    close: () => this.post<void>('/browser/close'),
    onEvent: (callback) => this.subscribe(this.browserListeners, callback),
  };

  readonly session: AgentApi['session'] = {
    reset: () => this.post<{ ok: boolean }>('/session/reset'),
  };

  readonly agent: AgentApi['agent'] = {
    chat: (text: string) => this.post<ChatMessage | PageModel | null>('/agent/chat', { text }),
    explore: (url: string) => this.post<PageModel | null>('/agent/explore', { url }),
    state: () => this.get<AgentState>('/agent/state'),
    screenshot: (label?: string) => this.post<Screenshot>('/agent/screenshot', { label }),
    design: (feedback?: string | null) => this.post<TestPlan | null>('/agent/design', { feedback: feedback ?? null }),
    selectCase: (id: string, selected: boolean) => this.post<TestPlan>('/agent/select-case', { id, selected }),
    generate: () => this.post<GeneratedTests | null>('/agent/generate'),
    retry: (messageId: string) => this.post<unknown>('/agent/retry', { messageId }),
    onEvent: (callback) => this.subscribe(this.agentListeners, callback),
  };

  readonly app: AgentApi['app'] = {
    info: () => this.get<{ platform: string; packaged: boolean; version: string }>('/app/info'),
  };

  readonly llm: AgentApi['llm'] = {
    getConfig: () => this.get<LlmConfigView>('/llm/config'),
    setConfig: (input: LlmConfigInput) => this.request<LlmConfigView>('/llm/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
    test: () => this.post<LlmTestResult>('/llm/test'),
  };

  readonly tests: AgentApi['tests'] = {
    /** In the browser, "save" is a download of the generated file. */
    save: async () => {
      const state = await this.get<AgentState>('/agent/state');
      if (!state.generatedTests) throw new Error('No generated tests to save');
      const link = document.createElement('a');
      link.href = `${this.base}/tests/file?t=${Date.now()}`;
      link.download = state.generatedTests.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      return { saved: true, path: state.generatedTests.fileName };
    },
    copy: async () => {
      const state = await this.get<AgentState>('/agent/state');
      if (!state.generatedTests) throw new Error('No generated tests to copy');
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this browser; use Save instead.');
      await navigator.clipboard.writeText(state.generatedTests.code);
      return { copied: true, via: 'browser' };
    },
  };

  private subscribe<T>(set: Set<(event: T) => void>, callback: (event: T) => void): () => void {
    set.add(callback);
    this.ensureStream();
    return () => {
      set.delete(callback);
      if (!this.agentListeners.size && !this.browserListeners.size) {
        this.stream?.close();
        this.stream = null;
      }
    };
  }

  private opening = false;

  private ensureStream(): void {
    if (this.stream || this.opening) return;
    this.opening = true;
    void this.handshake().then(() => {
      this.opening = false;
      if (this.stream || (!this.agentListeners.size && !this.browserListeners.size)) return;
      const stream = new EventSource(`${this.base}/events`);
      stream.addEventListener('agent', (e) => this.dispatch(this.agentListeners, (e as MessageEvent).data));
      stream.addEventListener('browser', (e) => this.dispatch(this.browserListeners, (e as MessageEvent).data));
      // On every (re)connection, tell listeners to reload state: events sent
      // while the stream was down are not replayed by the server.
      stream.addEventListener('open', () => {
        for (const listener of this.agentListeners) listener({ type: 'connected' });
      });
      this.stream = stream;
    });
  }

  private dispatch<T>(set: Set<(event: T) => void>, raw: string): void {
    let event: T;
    try {
      event = JSON.parse(raw) as T;
    } catch {
      return;
    }
    for (const listener of set) listener(event);
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    await this.handshake();
    const res = await fetch(`${this.base}${path}`, { ...init, credentials: 'same-origin' });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
    return data as T;
  }
}
