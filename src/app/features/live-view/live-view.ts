import { Component, inject } from '@angular/core';
import { AgentService } from '../../core/agent.service';
import { BrowserService } from '../../core/browser.service';

/** Live picture of the agent's browser, streamed from the server. */
@Component({
  selector: 'app-live-view',
  templateUrl: './live-view.html',
  styleUrl: './live-view.scss',
})
export class LiveViewPanel {
  protected readonly browser = inject(BrowserService);
  protected readonly agent = inject(AgentService);

  protected screenshot(): void {
    void this.agent.screenshot('Manual screenshot');
  }
}
