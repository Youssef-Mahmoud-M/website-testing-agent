import { Injectable, NgZone, OnDestroy, signal } from '@angular/core';
import { BrowserEvent, BrowserStatus, getAgentApi, OpenResult } from './agent-bridge';

/**
 * Angular-side handle on the Playwright browser that the agent backend
 * main process controls. All state is exposed as signals.
 */
@Injectable({ providedIn: 'root' })
export class BrowserService implements OnDestroy {
  private readonly api = getAgentApi();
  private readonly unsubscribe: (() => void) | null;

  readonly available = signal(this.api !== null);
  readonly status = signal<BrowserStatus>({ running: false, url: null });
  readonly title = signal<string>('');
  readonly screenshot = signal<string | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly events = signal<BrowserEvent[]>([]);
  /** Latest live-view frame of the agent's browser (data URL), if streaming. */
  readonly frame = signal<{ src: string; url: string | null; width: number | null; height: number | null; at: number } | null>(null);
  readonly frameError = signal<string | null>(null);

  constructor(private readonly zone: NgZone) {
    this.unsubscribe = this.api?.browser.onEvent((event) => this.zone.run(() => this.onEvent(event))) ?? null;
    void this.refreshStatus();
  }

  async open(url: string): Promise<OpenResult | null> {
    return this.run(async (api) => {
      const result = await api.browser.open(url);
      this.title.set(result.title);
      await this.refreshStatus();
      await this.captureScreenshot();
      return result;
    });
  }

  async captureScreenshot(): Promise<void> {
    if (!this.api) return;
    this.screenshot.set(await this.api.browser.screenshot());
  }

  async reset(): Promise<void> {
    await this.run(async (api) => {
      await api.session.reset();
      this.screenshot.set(null);
      this.title.set('');
      this.events.set([]);
      await this.refreshStatus();
    });
  }

  async refreshStatus(): Promise<void> {
    if (!this.api) return;
    this.status.set(await this.api.browser.status());
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
  }

  private onEvent(event: BrowserEvent): void {
    if (event.type === 'frame') {
      this.frame.set({ src: `data:image/jpeg;base64,${event.data}`, url: event.url, width: event.width, height: event.height, at: Date.now() });
      return;
    }
    if (event.type === 'frame-error') {
      this.frameError.set(event.message);
      return;
    }
    if (event.type === 'install-progress') return;
    this.events.update((list) => [...list.slice(-49), event]);
    if (event.type === 'loaded') this.title.set(event.title);
    if (event.type === 'closed' || event.type === 'page-closed' || event.type === 'reset') {
      this.status.set({ running: false, url: null });
      this.frame.set(null);
    } else {
      void this.refreshStatus();
    }
  }

  private async run<T>(work: (api: NonNullable<typeof this.api>) => Promise<T>): Promise<T | null> {
    if (!this.api) {
      this.error.set('Agent backend unavailable: browser control is not possible.');
      return null;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      return await work(this.api);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      this.busy.set(false);
    }
  }
}
