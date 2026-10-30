import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AgentService } from '../../core/agent.service';

@Component({
  selector: 'app-code-panel',
  imports: [DatePipe],
  templateUrl: './code.html',
  styleUrl: './code.scss',
})
export class CodePanel {
  protected readonly agent = inject(AgentService);
  protected readonly message = signal<{ kind: 'ok' | 'error'; text: string } | null>(null);

  protected lines(code: string): { n: number; text: string; flagged: boolean }[] {
    const flagged = new Set(this.agent.generatedTests()?.validation.unknownLocators.map((u) => u.line) ?? []);
    return code.replace(/\n$/, '').split('\n').map((text, i) => ({ n: i + 1, text, flagged: flagged.has(i + 1) }));
  }

  protected async copy(): Promise<void> {
    await this.attempt(async () => {
      const result = await this.agent.copyTests();
      this.message.set({ kind: 'ok', text: result.via === 'electron' ? 'Copied to the clipboard.' : `Copied to the clipboard via ${result.via}.` });
    });
  }

  protected async save(): Promise<void> {
    await this.attempt(async () => {
      const result = await this.agent.saveTests();
      this.message.set(result.saved ? { kind: 'ok', text: `Saved to ${result.path}` } : { kind: 'ok', text: 'Save cancelled.' });
    });
  }

  protected regenerate(): void {
    this.message.set(null);
    void this.agent.generate();
  }

  private async attempt(work: () => Promise<void>): Promise<void> {
    this.message.set(null);
    try {
      await work();
    } catch (err) {
      this.message.set({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }
}
