import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TestCase, TestExpectation, TestStep } from '../../core/agent-bridge';
import { AgentService } from '../../core/agent.service';

@Component({
  selector: 'app-test-plan-panel',
  imports: [FormsModule],
  templateUrl: './test-plan.html',
  styleUrl: './test-plan.scss',
})
export class TestPlanPanel {
  protected readonly agent = inject(AgentService);
  protected readonly feedback = signal('');
  protected readonly expanded = signal<Set<string>>(new Set());
  /** Emitted after code generation so the shell can switch to the Code tab. */
  readonly generated = output<void>();

  protected toggle(id: string): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected select(c: TestCase, event: Event): void {
    void this.agent.setCaseSelected(c.id, (event.target as HTMLInputElement).checked);
  }

  protected selectAll(selected: boolean): void {
    for (const c of this.agent.testPlan()?.cases ?? []) {
      if (c.selected !== selected) void this.agent.setCaseSelected(c.id, selected);
    }
  }

  protected design(): void {
    void this.agent.design();
  }

  protected refine(): void {
    const text = this.feedback().trim();
    if (!text) return;
    this.feedback.set('');
    void this.agent.design(text);
  }

  protected async generate(): Promise<void> {
    const result = await this.agent.generate();
    if (result) this.generated.emit();
  }

  protected elementName(ref: string | null): string {
    if (!ref) return '';
    const el = this.agent.pageModel()?.elements.find((e) => e.ref === ref);
    return el ? `${ref} ${el.role || el.tag} "${el.name || el.text}"` : ref;
  }

  protected describeStep(s: TestStep): string {
    switch (s.action) {
      case 'goto':
        return `Go to ${s.value}`;
      case 'fill':
        return `Fill ${this.elementName(s.ref)} with "${s.value}"`;
      case 'select':
        return `Select "${s.value}" in ${this.elementName(s.ref)}`;
      case 'press':
        return `Press ${s.value} on ${this.elementName(s.ref)}`;
      default:
        return `${s.action[0].toUpperCase()}${s.action.slice(1)} ${this.elementName(s.ref)}`;
    }
  }

  protected describeExpectation(e: TestExpectation): string {
    switch (e.assert) {
      case 'url':
        return `URL contains "${e.value}"`;
      case 'title':
        return `Title contains "${e.value}"`;
      case 'text':
        return `${this.elementName(e.ref)} contains text "${e.value}"`;
      case 'value':
        return `${this.elementName(e.ref)} has value "${e.value}"`;
      case 'count':
        return `${this.elementName(e.ref)} matches ${e.value} element(s)`;
      default:
        return `${this.elementName(e.ref)} is ${e.assert}`;
    }
  }
}
