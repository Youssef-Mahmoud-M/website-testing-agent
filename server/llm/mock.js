// Deterministic offline provider for development and automated smoke tests.
// Selected only via LLM_PROVIDER=mock; it is not offered in the Settings UI.
// MOCK_FAIL_TIMES=n makes the first n calls in this process fail, to exercise
// the retry UX. Process-wide because a provider instance is created per call.
let failuresLeft = Number(process.env.MOCK_FAIL_TIMES) || 0;

class MockProvider {

  constructor() {
    this.name = 'mock';
    this.model = 'mock-1';
    this.delayMs = Number(process.env.MOCK_DELAY_MS) || 30;
    this.timeoutMs = Number(process.env.MOCK_TIMEOUT_MS) || 0;
  }

  async chat({ system = '', messages, json = false }) {
    const last = messages[messages.length - 1]?.content ?? '';
    const started = Date.now();
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      await new Promise((r) => setTimeout(r, 30));
      const { LlmError } = require('./provider');
      throw new LlmError('Mock failure 503: service unavailable', { status: 503, retryable: true });
    }
    if (this.timeoutMs && this.delayMs > this.timeoutMs) {
      await new Promise((r) => setTimeout(r, this.timeoutMs));
      const { LlmError } = require('./provider');
      throw new LlmError(
        `Timed out after ${Math.round(this.timeoutMs / 1000)} s waiting for mock (mock-1). Raise the request timeout in Settings or pick a faster model.`,
        { retryable: true, timeout: true },
      );
    }
    await new Promise((r) => setTimeout(r, this.delayMs));
    let text;
    // The element table lives in the first user message; repair prompts come later.
    const table = messages.find((m) => /^e\d+ \|/m.test(m.content))?.content ?? last;
    const refs = [...table.matchAll(/^(e\d+) \|/gm)].map((m) => m[1]);
    const rowOf = (ref) => table.split('\n').find((l) => l.startsWith(`${ref} |`)) || '';
    if (json && /Design the test plan|Reviewer feedback/.test(last)) {
      const fields = refs.filter((r) => /\| textbox/.test(rowOf(r)));
      const buttons = refs.filter((r) => /\| button/.test(rowOf(r)));
      const links = refs.filter((r) => /\| link/.test(rowOf(r)));
      const revising = /Reviewer feedback/.test(last);
      text = JSON.stringify({
        cases: [
          {
            id: 'TC-01',
            title: revising ? 'Submit the form with valid input (revised)' : 'Submit the form with valid input',
            priority: 'high',
            category: 'functional',
            preconditions: ['Page is open'],
            steps: [
              ...fields.slice(0, 2).map((ref) => ({ action: 'fill', ref, value: 'value' })),
              ...(buttons[0] ? [{ action: 'click', ref: buttons[0] }] : []),
              // Invented reference, must be dropped by validation:
              { action: 'click', ref: 'e9999' },
            ],
            expected: [{ assert: 'url', value: '/' }, ...(buttons[0] ? [{ assert: 'visible', ref: buttons[0] }] : [])],
          },
          {
            id: 'TC-02',
            title: 'Navigation links are visible',
            priority: 'low',
            category: 'navigation',
            preconditions: [],
            steps: [],
            expected: links.slice(0, 3).map((ref) => ({ assert: 'visible', ref })),
          },
          // Nonsense case: no valid steps or expectations, must be dropped.
          { id: 'TC-03', title: 'Ghost', priority: 'high', category: 'functional', steps: [{ action: 'teleport', ref: 'e1' }], expected: [] },
        ],
      });
    } else if (!json && /pytest and Playwright/.test(system)) {
      const pyLocators = refs.map((r) => (rowOf(r).match(/\| (page\.[^|]+?)(?: \||$)/) || [])[1]).filter(Boolean).map((s) => s.trim());
      const repairing = /has problems/.test(last);
      const DQ = String.fromCharCode(34).repeat(3);
      const lines = [
        'import re',
        'import pytest',
        'from playwright.sync_api import Page, expect',
        '',
        `BASE_URL = ${JSON.stringify((table.match(/^BASE_URL: (.*)$/m) || [])[1] || 'http://localhost')}`,
        '',
        '',
        '@pytest.fixture(autouse=True)',
        'def open_page(page: Page):',
        '    page.goto(BASE_URL)',
        '',
        '',
        'def test_tc_01_submit_the_form(page: Page):',
        `    ${DQ}TC-01: Submit the form with valid input${DQ}`,
        ...pyLocators.slice(0, 2).map((l) => `    ${l}.fill("value")`),
        ...(pyLocators[2] ? [`    expect(${pyLocators[2]}).to_be_visible()`] : []),
        // The first attempt sneaks in an invented locator and a syntax error; the repair round removes them.
        ...(repairing ? [] : ['    page.get_by_role("button", name="Imaginary").click()', '    expect(page).to_have_url(re.compile("/")']),
        '    expect(page).to_have_url(re.compile(re.escape("/")))',
        '',
      ];
      text = lines.join('\n');
    } else if (json) {
      text = JSON.stringify({
        summary: 'Mock exploration summary.',
        purpose: 'Mock purpose.',
        // 'e9999' never exists: it exercises the hallucination filter.
        sections: [{ name: 'Main', description: 'Everything on the page.', elementRefs: [...refs.slice(0, 5), 'e9999'] }],
        interactiveElements: [
          ...refs.slice(0, 5).map((ref) => ({
            ref,
            description: `Mock description for ${ref}`,
            expectedBehavior: 'Does something.',
          })),
          { ref: 'e9999', description: 'Invented element', expectedBehavior: 'n/a' },
        ],
        forms: [],
        navigation: [],
        risks: ['Mock risk'],
        suggestedTestAreas: ['Mock area'],
      });
    } else {
      text = `Mock reply to: ${last.slice(0, 120)}`;
    }
    const inputTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
    const outputTokens = Math.ceil(text.length / 4);
    return {
      text,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      latencyMs: Date.now() - started,
      model: this.model,
      finishReason: 'STOP',
    };
  }
}

module.exports = { MockProvider };
