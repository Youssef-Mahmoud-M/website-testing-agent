import { Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AgentService } from '../../core/agent.service';
import { compact, formatMs, shortUrl } from '../../core/format';

@Component({
  selector: 'app-metrics-panel',
  imports: [DatePipe],
  templateUrl: './metrics.html',
  styleUrl: './metrics.scss',
})
export class MetricsPanel {
  protected readonly agent = inject(AgentService);
  protected readonly summary = this.agent.summary;
  protected readonly newestFirst = computed(() => [...this.agent.metrics()].reverse());

  protected readonly ms = formatMs;
  protected readonly compact = compact;
  protected readonly shortUrl = shortUrl;
}
