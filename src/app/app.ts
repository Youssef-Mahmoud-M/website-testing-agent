import { Component, inject, signal } from '@angular/core';
import { AgentService } from './core/agent.service';
import { BrowserService } from './core/browser.service';
import { compact, formatMs } from './core/format';
import { Tab } from './core/tabs';
import { ChatPanel } from './features/chat/chat';
import { CodePanel } from './features/code/code';
import { LiveViewPanel } from './features/live-view/live-view';
import { MetricsPanel } from './features/metrics/metrics';
import { PageModelPanel } from './features/page-model/page-model';
import { ScreenshotsPanel } from './features/screenshots/screenshots';
import { SettingsPanel } from './features/settings/settings';
import { TestPlanPanel } from './features/test-plan/test-plan';

@Component({
  imports: [ChatPanel, TestPlanPanel, CodePanel, ScreenshotsPanel, PageModelPanel, MetricsPanel, SettingsPanel, LiveViewPanel],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly agent = inject(AgentService);
  protected readonly browser = inject(BrowserService);
  protected readonly tab = signal<Tab>('chat');

  protected readonly compact = compact;
  protected readonly ms = formatMs;

  protected readonly tabs: { id: Tab; label: string }[] = [
    { id: 'chat', label: 'Chat' },
    { id: 'plan', label: 'Test Plan' },
    { id: 'code', label: 'Code' },
    { id: 'screenshots', label: 'Screenshots' },
    { id: 'page', label: 'Page Model' },
    { id: 'metrics', label: 'Metrics' },
    { id: 'settings', label: 'Settings' },
  ];

  protected reset(): void {
    void this.agent.reset();
  }
}
