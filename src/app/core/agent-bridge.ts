/**
 * The contract between the UI and the agent backend. On the website it is
 * implemented by HttpAgentApi over the server's JSON API; the desktop edition
 * (branch `main`) exposes the same shape on `window.agent` from its preload.
 */
export interface OpenResult {
  url: string;
  title: string;
  elapsedMs: number;
}

export interface BrowserStatus {
  running: boolean;
  url: string | null;
}

export type BrowserEvent =
  | { type: 'navigated'; url: string }
  | { type: 'loaded'; url: string; title: string }
  /** Live-view frame: base64 JPEG of the agent's browser. */
  | { type: 'frame'; data: string; url: string | null; width: number | null; height: number | null }
  | { type: 'frame-error'; message: string }
  | { type: 'install-progress'; percent: number | null; message: string }
  | { type: 'page-closed' }
  | { type: 'closed' }
  | { type: 'reset' };

export type MessageRole = 'user' | 'assistant';

export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  error?: boolean;
  /** Token usage and time of the iteration that produced this reply. */
  usage?: MessageUsage;
  /** Present on error messages whose step can be re-run. */
  retry?: { action: 'explore' | 'chat' | 'design' | 'generate'; args: Record<string, unknown> };
}

export interface Screenshot {
  id: string;
  dataUrl: string;
  label: string;
  url: string | null;
  takenAt: string;
}

export interface Locator {
  strategy: string;
  /** Playwright locator in JavaScript/TypeScript syntax. */
  code: string;
  /** The same locator in Python syntax. */
  python: string;
  verified: boolean;
}

export interface PageElement {
  ref: string;
  tag: string;
  type: string | null;
  role: string | null;
  name: string;
  id: string | null;
  testId: string | null;
  placeholder: string | null;
  href: string | null;
  text: string;
  disabled: boolean;
  required: boolean;
  locator: Locator;
  alternatives: Pick<Locator, 'strategy' | 'code' | 'python'>[];
  description?: string;
  expectedBehavior?: string;
}

export interface PageModelStats {
  elementTotal: number;
  extracted: number;
  verifiedUnique: number;
  describedByModel: number;
  droppedReferences: number;
  extractMs: number;
  verifyMs: number;
  llmMs: number;
  totalMs: number;
}

export interface PageModel {
  url: string;
  title: string;
  exploredAt: string;
  summary: string;
  purpose: string;
  sections: { name: string; description: string; elementRefs: string[] }[];
  forms: { name: string; fieldRefs: string[]; submitRef: string | null; validationHints: string[] }[];
  navigation: { ref: string; destination: string }[];
  risks: string[];
  suggestedTestAreas: string[];
  headings: { level: number; text: string }[];
  elements: PageElement[];
  stats: PageModelStats;
}

export type Phase = 'explore' | 'chat' | 'design' | 'implement' | 'verify';

export type StepAction = 'goto' | 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'press' | 'hover';
export type Assertion = 'visible' | 'hidden' | 'text' | 'value' | 'url' | 'title' | 'enabled' | 'disabled' | 'checked' | 'count';

export interface TestStep {
  action: StepAction;
  ref: string | null;
  value: string | null;
}

export interface TestExpectation {
  assert: Assertion;
  ref: string | null;
  value: string | null;
}

export interface TestCase {
  id: string;
  title: string;
  priority: 'high' | 'medium' | 'low';
  category: 'functional' | 'validation' | 'navigation' | 'negative' | 'ui' | 'accessibility';
  preconditions: string[];
  steps: TestStep[];
  expected: TestExpectation[];
  /** Reviewer's choice: include this case when generating code. */
  selected: boolean;
}

export interface TestPlan {
  url: string;
  title: string;
  designedAt: string;
  revision: number;
  feedbackHistory: string[];
  cases: TestCase[];
  stats: { proposed: number; kept: number; droppedItems: number; llmMs: number };
}

export interface GeneratedTests {
  language: 'python';
  framework: string;
  fileName: string;
  code: string;
  caseIds: string[];
  generatedAt: string;
  validation: {
    syntaxOk: boolean;
    syntaxError: string | null;
    pythonAvailable: boolean;
    unknownLocators: { line: number; expr: string }[];
    repaired: boolean;
    clean: boolean;
  };
}

export interface MetricRecord {
  id: string;
  at: string;
  phase: Phase;
  label: string;
  url: string | null;
  provider: string;
  model: string;
  latencyMs: number;
  llmLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  extra?: Record<string, number>;
}

export interface AgentStatus {
  status: 'idle' | 'exploring' | 'thinking';
  detail: string;
}

export type AgentEvent =
  | ({ type: 'status' } & AgentStatus)
  | { type: 'message'; message: ChatMessage }
  | { type: 'messageRemoved'; id: string }
  | { type: 'screenshot'; screenshot: Screenshot }
  | { type: 'pageModel'; pageModel: PageModel }
  | { type: 'testPlan'; testPlan: TestPlan | null }
  | { type: 'generatedTests'; generatedTests: GeneratedTests | null }
  | { type: 'metric'; metric: MetricRecord }
  | { type: 'reset' }
  /** Event stream (re)connected: state may have changed meanwhile. */
  | { type: 'connected' };

export interface AgentState {
  messages: ChatMessage[];
  pageModel: PageModel | null;
  testPlan: TestPlan | null;
  generatedTests: GeneratedTests | null;
  metrics: MetricRecord[];
  screenshots: Screenshot[];
  status: AgentStatus;
  browser: BrowserStatus;
}

export type LlmProvider = 'gemini' | 'ollama';

/** Where the active API key comes from. */
export type KeySource = 'encrypted' | 'plaintext' | 'session' | 'env' | null;

export interface EnvOverride {
  name: string;
  field: 'provider' | 'geminiModel' | 'ollamaModel' | 'ollamaUrl' | 'requestTimeoutSec';
  value: string;
}

export interface LlmConfigView {
  /** Stored values, which the Settings form edits. */
  provider: LlmProvider;
  geminiModel: string;
  ollamaModel: string;
  ollamaUrl: string;
  /** Per-request LLM timeout in seconds. */
  requestTimeoutSec: number;
  /** Provider actually in use once environment overrides are applied. */
  activeProvider: string;
  envOverrides: EnvOverride[];
  hasApiKey: boolean;
  keySource: KeySource;
  encryptionAvailable: boolean;
  storageBackend: string;
}

export interface LlmConfigInput {
  provider?: LlmProvider;
  geminiModel?: string;
  ollamaModel?: string;
  ollamaUrl?: string;
  requestTimeoutSec?: number;
  /** undefined keeps the stored key, '' removes it. */
  apiKey?: string;
  /** Allow an unencrypted on-disk copy when the OS keychain is unavailable. */
  persistPlaintext?: boolean;
}

export interface LlmTestResult {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  reply: string;
}

export interface AgentApi {
  browser: {
    open(url: string): Promise<OpenResult>;
    screenshot(): Promise<string>;
    status(): Promise<BrowserStatus>;
    close(): Promise<void>;
    onEvent(callback: (event: BrowserEvent) => void): () => void;
  };
  session: {
    reset(): Promise<{ ok: boolean }>;
  };
  agent: {
    chat(text: string): Promise<ChatMessage | PageModel | null>;
    explore(url: string): Promise<PageModel | null>;
    state(): Promise<AgentState>;
    screenshot(label?: string): Promise<Screenshot>;
    design(feedback?: string | null): Promise<TestPlan | null>;
    selectCase(id: string, selected: boolean): Promise<TestPlan>;
    generate(): Promise<GeneratedTests | null>;
    retry(messageId: string): Promise<unknown>;
    onEvent(callback: (event: AgentEvent) => void): () => void;
  };
  app: {
    info(): Promise<{ platform: string; packaged: boolean; version: string }>;
  };
  tests: {
    save(): Promise<{ saved: boolean; path: string | null }>;
    copy(): Promise<{ copied: boolean; via: string }>;
  };
  llm: {
    getConfig(): Promise<LlmConfigView>;
    setConfig(input: LlmConfigInput): Promise<LlmConfigView>;
    test(): Promise<LlmTestResult>;
  };
}

declare global {
  interface Window {
    agent?: AgentApi;
  }
}

import { HttpAgentApi } from './http-agent-api';

let httpApi: AgentApi | null = null;

/**
 * Returns the bridge: a desktop preload's `window.agent` when present,
 * otherwise an HTTP client for the server API. Null only where neither
 * exists, such as unit tests without EventSource.
 */
export function getAgentApi(): AgentApi | null {
  if (typeof window === 'undefined') return null;
  if (window.agent) return window.agent;
  if (typeof EventSource === 'undefined' || typeof fetch === 'undefined') return null;
  if (!httpApi) httpApi = new HttpAgentApi();
  return httpApi;
}
