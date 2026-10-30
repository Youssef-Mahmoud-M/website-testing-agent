import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AgentService } from '../../core/agent.service';

@Component({
  selector: 'app-screenshots-panel',
  imports: [DatePipe],
  templateUrl: './screenshots.html',
  styleUrl: './screenshots.scss',
})
export class ScreenshotsPanel {
  protected readonly agent = inject(AgentService);
  protected readonly fit = signal(true);
  protected readonly newestFirst = computed(() => [...this.agent.screenshots()].reverse());

  protected capture(): void {
    void this.agent.screenshot('Manual screenshot');
  }
}
