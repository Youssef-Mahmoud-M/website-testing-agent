import { Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AgentService } from '../../core/agent.service';

@Component({
  selector: 'app-page-model-panel',
  imports: [DatePipe],
  templateUrl: './page-model.html',
  styleUrl: './page-model.scss',
})
export class PageModelPanel {
  protected readonly agent = inject(AgentService);
}
