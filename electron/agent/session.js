// Holds the conversation, the page model, screenshots and metrics for one
// agent session, and runs the phases. Lives in the main process only.
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createProvider, LlmError } = require('../llm/provider');
const { explorePage } = require('./explorer');
const { designTests } = require('./designer');
const { generateTests } = require('./generator');
const { CHAT_SYSTEM, pageModelContext } = require('./prompts');

const MAX_SCREENSHOTS = 40;
const MAX_HISTORY = 20;
const URL_IN_TEXT = /^(?:(?:please\s+)?(?:explore|open|visit|go to|load)\s+)?(https?:\/\/\S+)\s*$/i;

class AgentSession extends EventEmitter {
  /**
   * @param {{ controller: import('../browser-controller').BrowserController, getConfig: () => object }} deps
   */
  constructor({ controller, getConfig }) {
    super();
    this.controller = controller;
    this.getConfig = getConfig;
    this.controller.on('event', (event) => {
      if (event.type === 'install-progress' && this.busy) this.setStatus(this.status.status === 'idle' ? 'exploring' : this.status.status, event.message);
    });
    this.messages = [];
    this.pageModel = null;
    this.testPlan = null;
    this.generatedTests = null;
    this.metrics = [];
    this.screenshots = [];
    this.status = { status: 'idle', detail: '' };
    this.busy = false;
  }

  /** Token usage attached to an assistant message, for the per-iteration counter. */
  static usageOf(llm, latencyMs = llm.latencyMs) {
    return { inputTokens: llm.usage.inputTokens, outputTokens: llm.usage.outputTokens, totalTokens: llm.usage.totalTokens, latencyMs };
  }

  emitEvent(event) {
    this.emit('event', event);
  }

  setStatus(status, detail = '') {
    this.status = { status, detail };
    this.emitEvent({ type: 'status', status, detail });
  }

  addMessage(role, content, extra = {}) {
    const message = { id: randomUUID(), role, content, createdAt: new Date().toISOString(), ...extra };
    this.messages.push(message);
    this.emitEvent({ type: 'message', message });
    return message;
  }

  /** An assistant error message that remembers how to retry the failed step. */
  failure(content, retry) {
    return this.addMessage('assistant', content, { error: true, retry });
  }

  /** Re-run the step behind a failed message, without repeating the user's message. */
  async retry(messageId) {
    const failed = this.messages.find((m) => m.id === messageId && m.error && m.retry);
    if (!failed) throw new Error('This message cannot be retried.');
    if (this.busy) throw new Error('The agent is still working on the previous request.');
    this.messages = this.messages.filter((m) => m.id !== messageId);
    this.emitEvent({ type: 'messageRemoved', id: messageId });
    const { action, args } = failed.retry;
    switch (action) {
      case 'explore':
        return this.explore(args.url, { announce: false });
      case 'chat':
        return this.chat(args.text, { announce: false });
      case 'design':
        return this.design(args.feedback ?? null, { announce: false });
      case 'generate':
        return this.generate({ announce: false });
      default:
        throw new Error(`Unknown retry action ${action}`);
    }
  }

  recordMetric(metric) {
    const entry = { id: randomUUID(), at: new Date().toISOString(), ...metric };
    this.metrics.push(entry);
    this.emitEvent({ type: 'metric', metric: entry });
    return entry;
  }

  async captureScreenshot(label) {
    const dataUrl = await this.controller.screenshot();
    const status = this.controller.status();
    const shot = { id: randomUUID(), dataUrl, label, url: status.url, takenAt: new Date().toISOString() };
    this.screenshots.push(shot);
    if (this.screenshots.length > MAX_SCREENSHOTS) this.screenshots.shift();
    this.emitEvent({ type: 'screenshot', screenshot: shot });
    return shot;
  }

  getState() {
    return {
      messages: this.messages,
      pageModel: this.pageModel,
      testPlan: this.testPlan,
      generatedTests: this.generatedTests,
      metrics: this.metrics,
      screenshots: this.screenshots,
      status: this.status,
      browser: this.controller.status(),
    };
  }

  provider() {
    return createProvider(this.getConfig());
  }

  async guard(work) {
    if (this.busy) throw new Error('The agent is still working on the previous request.');
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }

  /** Phase 1. */
  async explore(url, { announce = true } = {}) {
    const retry = { action: 'explore', args: { url } };
    return this.guard(async () => {
      if (announce) this.addMessage('user', `Explore ${url}`);
      let provider;
      try {
        provider = this.provider();
      } catch (err) {
        this.failure(err.message, retry);
        this.setStatus('idle');
        return null;
      }
      try {
        this.setStatus('exploring', `Opening ${url}`);
        const opened = await this.controller.open(url);
        await this.captureScreenshot(`Loaded ${opened.title || url}`);

        const { pageModel, llm } = await explorePage(this.controller.page, provider, (e) => this.emitEvent(e));
        this.pageModel = pageModel;
        // A new page invalidates the plan and the code built on the old one.
        this.testPlan = null;
        this.generatedTests = null;
        this.emitEvent({ type: 'pageModel', pageModel });
        this.emitEvent({ type: 'testPlan', testPlan: null });
        this.emitEvent({ type: 'generatedTests', generatedTests: null });

        this.recordMetric({
          phase: 'explore',
          label: 'Page exploration',
          url: pageModel.url,
          provider: provider.name,
          model: llm.model,
          latencyMs: pageModel.stats.totalMs,
          llmLatencyMs: llm.latencyMs,
          inputTokens: llm.usage.inputTokens,
          outputTokens: llm.usage.outputTokens,
          totalTokens: llm.usage.totalTokens,
          extra: { ...pageModel.stats, navigationMs: opened.elapsedMs },
        });

        const s = pageModel.stats;
        this.addMessage(
          'assistant',
          [
            `**${pageModel.title || pageModel.url}**`,
            '',
            pageModel.summary,
            '',
            `Found ${s.elementTotal} interactive elements, kept ${s.extracted}, verified unique locators for ${s.verifiedUnique}.` +
              (s.droppedReferences ? ` Dropped ${s.droppedReferences} invented reference(s) from the model.` : ''),
            '',
            pageModel.suggestedTestAreas.length ? 'Suggested test areas:\n' + pageModel.suggestedTestAreas.map((a) => `- ${a}`).join('\n') : '',
            '',
            'See the Page Model tab for the full inventory. Open the Test Plan tab, or ask me to design test cases, when you are ready.',
          ].join('\n'),
          { usage: AgentSession.usageOf(llm, pageModel.stats.totalMs) },
        );
        return pageModel;
      } catch (err) {
        this.failure(`Exploration failed: ${err.message}`, retry);
        return null;
      } finally {
        this.setStatus('idle');
      }
    });
  }

  /** Free-form chat with the page model as context. URLs trigger exploration. */
  async chat(text, { announce = true } = {}) {
    const match = text.match(URL_IN_TEXT);
    if (match) return this.explore(match[1], { announce });
    if (this.pageModel && !this.testPlan && /^(design|propose|create|plan)\b.*\btest (cases?|plan)\b/i.test(text)) return this.design(null, { announce });
    if (this.testPlan && /^(generate|write|create|implement)\b.*\b(tests?|code)\b/i.test(text)) return this.generate({ announce });

    const retry = { action: 'chat', args: { text } };
    return this.guard(async () => {
      if (announce) this.addMessage('user', text);
      let provider;
      try {
        provider = this.provider();
      } catch (err) {
        this.failure(err.message, retry);
        return null;
      }
      this.setStatus('thinking', `Waiting for ${provider.name}`);
      try {
        const history = this.messages
          .filter((m) => !m.error && (m.role === 'user' || m.role === 'assistant'))
          .slice(-MAX_HISTORY)
          .map(({ role, content }) => ({ role, content }));
        const result = await provider.chat({
          system: `${CHAT_SYSTEM}\n\n${pageModelContext(this.pageModel)}`,
          messages: history,
          temperature: 0.3,
        });
        this.recordMetric({
          phase: 'chat',
          label: text.slice(0, 60),
          url: this.pageModel?.url ?? null,
          provider: provider.name,
          model: result.model,
          latencyMs: result.latencyMs,
          llmLatencyMs: result.latencyMs,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        });
        return this.addMessage('assistant', result.text || '(empty response)', { usage: AgentSession.usageOf(result) });
      } catch (err) {
        const hint = err instanceof LlmError && err.retryable && !err.timeout ? ' Free-tier rate limit hit; wait a moment and retry.' : '';
        return this.failure(`${err.message}${hint}`, retry);
      } finally {
        this.setStatus('idle');
      }
    });
  }

  /** Phase 2: propose or revise the structured test plan. */
  async design(feedback = null, { announce = true } = {}) {
    const retry = { action: 'design', args: { feedback } };
    return this.guard(async () => {
      if (!this.pageModel) {
        this.addMessage('assistant', 'Explore a page first, then I can design test cases for it.', { error: true });
        return null;
      }
      if (announce) this.addMessage('user', feedback ? `Refine the test plan: ${feedback}` : 'Design test cases for this page');
      let provider;
      try {
        provider = this.provider();
      } catch (err) {
        this.failure(err.message, retry);
        return null;
      }
      this.setStatus('thinking', feedback ? 'Revising the test plan' : 'Designing test cases');
      try {
        const { plan, llm } = await designTests(this.pageModel, provider, { feedback, previousPlan: this.testPlan });
        this.testPlan = plan;
        this.generatedTests = null;
        this.emitEvent({ type: 'testPlan', testPlan: plan });
        this.emitEvent({ type: 'generatedTests', generatedTests: null });
        this.recordMetric({
          phase: 'design',
          label: feedback ? 'Revise test plan' : 'Design test plan',
          url: this.pageModel.url,
          provider: provider.name,
          model: llm.model,
          latencyMs: llm.latencyMs,
          llmLatencyMs: llm.latencyMs,
          inputTokens: llm.usage.inputTokens,
          outputTokens: llm.usage.outputTokens,
          totalTokens: llm.usage.totalTokens,
          extra: plan.stats,
        });
        const byPriority = ['high', 'medium', 'low'].map((p) => `${plan.cases.filter((c) => c.priority === p).length} ${p}`).join(', ');
        this.addMessage(
          'assistant',
          [
            `**Test plan, revision ${plan.revision}: ${plan.cases.length} case(s)** (${byPriority})`,
            '',
            ...plan.cases.map((c) => `- **${c.id}** ${c.title} (${c.priority}, ${c.category})`),
            '',
            plan.stats.droppedItems ? `Dropped ${plan.stats.droppedItems} step(s), expectation(s) or case(s) that referenced elements not on the page.` : '',
            'Review it in the Test Plan tab: untick cases you do not want, send feedback to revise, then generate the Python tests.',
          ].join('\n'),
          { usage: AgentSession.usageOf(llm) },
        );
        return plan;
      } catch (err) {
        this.failure(`Test design failed: ${err.message}`, retry);
        return null;
      } finally {
        this.setStatus('idle');
      }
    });
  }

  /** Reviewer toggles a case on or off. */
  setCaseSelected(id, selected) {
    if (!this.testPlan) throw new Error('No test plan yet');
    const found = this.testPlan.cases.find((c) => c.id === id);
    if (!found) throw new Error(`Unknown test case ${id}`);
    found.selected = Boolean(selected);
    this.emitEvent({ type: 'testPlan', testPlan: this.testPlan });
    return this.testPlan;
  }

  /** Phase 3: generate the Python test file for the selected cases. */
  async generate({ announce = true } = {}) {
    const retry = { action: 'generate', args: {} };
    return this.guard(async () => {
      const cases = this.testPlan?.cases.filter((c) => c.selected) ?? [];
      if (!this.pageModel || !cases.length) {
        this.addMessage('assistant', 'Design a test plan and select at least one case before generating tests.', { error: true });
        return null;
      }
      if (announce) this.addMessage('user', `Generate Python Playwright tests for ${cases.length} selected case(s)`);
      let provider;
      try {
        provider = this.provider();
      } catch (err) {
        this.failure(err.message, retry);
        return null;
      }
      const started = Date.now();
      try {
        const { generated, calls } = await generateTests(this.pageModel, cases, provider, (e) => this.emitEvent(e));
        this.generatedTests = generated;
        this.emitEvent({ type: 'generatedTests', generatedTests: generated });
        const usage = calls.reduce(
          (acc, c) => ({
            inputTokens: acc.inputTokens + c.usage.inputTokens,
            outputTokens: acc.outputTokens + c.usage.outputTokens,
            totalTokens: acc.totalTokens + c.usage.totalTokens,
          }),
          { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        );
        const llmLatencyMs = calls.reduce((n, c) => n + c.latencyMs, 0);
        this.recordMetric({
          phase: 'implement',
          label: `Generate ${cases.length} test(s)`,
          url: this.pageModel.url,
          provider: provider.name,
          model: calls[0].model,
          latencyMs: Date.now() - started,
          llmLatencyMs,
          ...usage,
          extra: { llmCalls: calls.length, repaired: generated.validation.repaired ? 1 : 0, unknownLocators: generated.validation.unknownLocators.length },
        });
        const v = generated.validation;
        this.addMessage(
          'assistant',
          [
            `**Generated ${generated.fileName}** for ${cases.map((c) => c.id).join(', ')}.`,
            '',
            v.pythonAvailable ? (v.syntaxOk ? 'Syntax check passed.' : 'Syntax check FAILED, see the Code tab.') : 'Python was not found, so the syntax check was skipped.',
            v.unknownLocators.length
              ? `${v.unknownLocators.length} locator(s) are not in the verified table and are flagged in the Code tab.`
              : 'Every locator in the file is one of the verified locators.',
            v.repaired ? 'One automatic repair round was applied.' : '',
            '',
            'Open the Code tab to review, copy or save the file.',
          ].join('\n'),
          { usage: { ...usage, latencyMs: Date.now() - started } },
        );
        return generated;
      } catch (err) {
        this.failure(`Test generation failed: ${err.message}`, retry);
        return null;
      } finally {
        this.setStatus('idle');
      }
    });
  }

  async testProvider() {
    const provider = this.provider();
    const result = await provider.chat({ messages: [{ role: 'user', content: 'Reply with the single word OK.' }], temperature: 0 });
    return { ok: true, provider: provider.name, model: result.model, latencyMs: result.latencyMs, reply: result.text.slice(0, 80) };
  }

  /** Clean slate: conversation, page model, metrics, screenshots and browser. */
  async reset() {
    this.messages = [];
    this.pageModel = null;
    this.testPlan = null;
    this.generatedTests = null;
    this.metrics = [];
    this.screenshots = [];
    this.busy = false;
    await this.controller.reset();
    this.setStatus('idle');
    this.emitEvent({ type: 'reset' });
    return { ok: true };
  }
}

module.exports = { AgentSession };
