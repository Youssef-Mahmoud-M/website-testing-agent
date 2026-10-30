import { Component, effect, ElementRef, inject, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AgentService } from '../../core/agent.service';
import { ChatMessage } from '../../core/agent-bridge';
import { compact, formatMs } from '../../core/format';
import { Tab } from '../../core/tabs';
import { SimpleMarkdownPipe } from '../../core/simple-markdown.pipe';

@Component({
  selector: 'app-chat-panel',
  imports: [FormsModule, SimpleMarkdownPipe],
  templateUrl: './chat.html',
  styleUrl: './chat.scss',
})
export class ChatPanel {
  protected readonly agent = inject(AgentService);
  protected readonly draft = signal('');
  protected readonly compact = compact;
  protected readonly ms = formatMs;
  private readonly log = viewChild<ElementRef<HTMLElement>>('log');
  /** Asks the shell to show a tab, e.g. the Code tab after generation. */
  readonly openTab = output<Tab>();

  constructor() {
    // Keep the newest message in view.
    effect(() => {
      this.agent.messages();
      this.agent.status();
      const el = this.log()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
  }

  protected get isUrl(): boolean {
    return this.agent.isUrl(this.draft());
  }

  protected send(): void {
    const text = this.draft().trim();
    if (!text || this.agent.busy()) return;
    this.draft.set('');
    void this.agent.send(text);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  protected quick(text: string): void {
    if (this.agent.busy()) return;
    void this.agent.send(text);
  }

  protected retry(m: ChatMessage): void {
    if (this.agent.busy()) return;
    void this.agent.retry(m.id);
  }

  protected isTimeout(m: ChatMessage): boolean {
    return /timed out/i.test(m.content);
  }

  protected needsKey(m: ChatMessage): boolean {
    return /API key/i.test(m.content);
  }

  protected design(): void {
    if (this.agent.busy()) return;
    void this.agent.design();
  }

  protected generate(): void {
    if (this.agent.busy()) return;
    void this.agent.generate();
  }
}
