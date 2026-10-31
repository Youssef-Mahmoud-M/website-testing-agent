import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { KeySource, LlmConfigInput, LlmProvider } from '../../core/agent-bridge';
import { AgentService } from '../../core/agent.service';

@Component({
  selector: 'app-settings-panel',
  imports: [FormsModule],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class SettingsPanel {
  protected readonly agent = inject(AgentService);
  protected readonly provider = signal<LlmProvider>('gemini');
  protected readonly geminiModel = signal('gemini-3.8-flash');
  protected readonly ollamaModel = signal('llama3.1');
  protected readonly ollamaUrl = signal('http://127.0.0.1:11434');
  protected readonly requestTimeoutSec = signal(60);
  protected readonly apiKey = signal('');
  protected readonly message = signal<{ kind: 'ok' | 'error'; text: string } | null>(null);
  protected readonly working = signal(false);

  /** True when the form differs from what the main process has stored. */
  protected readonly dirty = computed(() => {
    const c = this.agent.config();
    if (!c) return false;
    if (this.apiKey().trim()) return true;
    return (
      this.provider() !== c.provider ||
      this.geminiModel().trim() !== c.geminiModel ||
      this.ollamaModel().trim() !== c.ollamaModel ||
      this.ollamaUrl().trim().replace(/\/$/, '') !== c.ollamaUrl ||
      Number(this.requestTimeoutSec()) !== c.requestTimeoutSec
    );
  });

  constructor() {
    effect(() => {
      const c = this.agent.config();
      if (!c) return;
      if (c.provider === 'gemini' || c.provider === 'ollama') this.provider.set(c.provider);
      this.geminiModel.set(c.geminiModel);
      this.ollamaModel.set(c.ollamaModel);
      this.ollamaUrl.set(c.ollamaUrl);
      this.requestTimeoutSec.set(c.requestTimeoutSec);
    });
  }

  protected async save(): Promise<void> {
    await this.withStatus(async () => this.ok(await this.persist()));
  }

  protected async clearKey(): Promise<void> {
    await this.withStatus(async () => {
      await this.agent.saveConfig({ apiKey: '' });
      this.ok('API key forgotten for this session.');
    });
  }

  /** Saves pending changes first so the test runs against what is on screen. */
  protected async test(): Promise<void> {
    await this.withStatus(async () => {
      const saved = this.dirty() ? await this.persist() : null;
      const result = await this.agent.testConfig();
      const outcome = `${result.provider} / ${result.model} answered in ${result.latencyMs} ms: "${result.reply}"`;
      this.ok(saved ? `${saved} ${outcome}` : outcome);
    });
  }

  /** Writes the form to the main process and returns a human-readable summary. */
  private async persist(): Promise<string> {
    const input: LlmConfigInput = {
      provider: this.provider(),
      geminiModel: this.geminiModel().trim(),
      ollamaModel: this.ollamaModel().trim(),
      ollamaUrl: this.ollamaUrl().trim(),
      requestTimeoutSec: Number(this.requestTimeoutSec()),
    };
    if (this.apiKey().trim()) input.apiKey = this.apiKey().trim();
    const view = await this.agent.saveConfig(input);
    this.apiKey.set('');
    return input.apiKey ? `Settings saved. ${this.describeKey(view.keySource)}` : 'Settings saved.';
  }

  protected describeKey(source: KeySource): string {
    switch (source) {
      case 'session':
        return 'The API key is held in server memory for this browser session. It is forgotten when the session ends (after 30 minutes without activity) or when the server restarts.';
      case 'env':
        return 'Using the GEMINI_API_KEY configured in the server environment.';
      case 'encrypted':
      case 'plaintext':
        return 'The API key is stored on the server.';
      default:
        return 'No API key configured yet.';
    }
  }

  private ok(text: string): void {
    this.message.set({ kind: 'ok', text });
  }

  private async withStatus(work: () => Promise<void>): Promise<void> {
    this.working.set(true);
    this.message.set(null);
    try {
      await work();
    } catch (err) {
      this.message.set({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.working.set(false);
    }
  }
}
