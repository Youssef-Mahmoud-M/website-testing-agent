// Phase 2: Collaborative test design.
// The model proposes structured test cases that reference page elements by
// id; anything it invents is dropped and counted. The reviewer toggles cases
// and sends feedback, and the plan is revised while keeping stable ids.
const { parseJson } = require('../llm/provider');
const { DESIGN_SYSTEM, STEP_ACTIONS, ASSERTIONS, designUserPrompt } = require('./prompts');

const PRIORITIES = ['high', 'medium', 'low'];
const CATEGORIES = ['functional', 'validation', 'navigation', 'negative', 'ui', 'accessibility'];
const REF_FREE_ACTIONS = new Set(['goto']);
const REF_FREE_ASSERTS = new Set(['url', 'title']);
const VALUE_ACTIONS = new Set(['fill', 'select', 'press', 'goto']);
const VALUE_ASSERTS = new Set(['text', 'value', 'url', 'title', 'count']);

const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * @param {object} pageModel
 * @param {{ chat: Function, name: string }} provider
 * @param {{ feedback?: string|null, previousPlan?: object|null }} options
 */
async function designTests(pageModel, provider, { feedback = null, previousPlan = null } = {}) {
  const result = await provider.chat({
    system: DESIGN_SYSTEM,
    messages: [{ role: 'user', content: designUserPrompt(pageModel, { feedback, previousPlan }) }],
    json: true,
    temperature: 0.2,
  });
  const raw = parseJson(result.text);
  const known = new Set(pageModel.elements.map((el) => el.ref));
  const previousSelection = new Map((previousPlan?.cases ?? []).map((c) => [c.id, c.selected]));

  let dropped = 0;
  const cases = [];
  const rawCases = Array.isArray(raw.cases) ? raw.cases : [];
  rawCases.forEach((c, index) => {
    if (!c || typeof c !== 'object') return;
    const steps = [];
    for (const s of Array.isArray(c.steps) ? c.steps : []) {
      const action = str(s?.action, 20).toLowerCase();
      if (!STEP_ACTIONS.includes(action)) {
        dropped += 1;
        continue;
      }
      const ref = str(s?.ref, 10);
      if (!REF_FREE_ACTIONS.has(action) && !known.has(ref)) {
        dropped += 1;
        continue;
      }
      const value = str(s?.value, 500);
      if (VALUE_ACTIONS.has(action) && !value) {
        dropped += 1;
        continue;
      }
      steps.push({ action, ref: REF_FREE_ACTIONS.has(action) ? null : ref, value: value || null });
    }
    const expected = [];
    for (const e of Array.isArray(c.expected) ? c.expected : []) {
      const assert = str(e?.assert, 20).toLowerCase();
      if (!ASSERTIONS.includes(assert)) {
        dropped += 1;
        continue;
      }
      const ref = str(e?.ref, 10);
      if (!REF_FREE_ASSERTS.has(assert) && !known.has(ref)) {
        dropped += 1;
        continue;
      }
      const value = str(e?.value, 500);
      if (VALUE_ASSERTS.has(assert) && !value) {
        dropped += 1;
        continue;
      }
      expected.push({ assert, ref: REF_FREE_ASSERTS.has(assert) ? null : ref, value: value || null });
    }
    if (!steps.length && !expected.length) {
      dropped += 1;
      return;
    }
    const id = /^TC-\d{2,3}$/.test(str(c.id, 10)) ? str(c.id, 10) : `TC-${String(index + 1).padStart(2, '0')}`;
    const priority = PRIORITIES.includes(str(c.priority, 10).toLowerCase()) ? str(c.priority, 10).toLowerCase() : 'medium';
    const category = CATEGORIES.includes(str(c.category, 20).toLowerCase()) ? str(c.category, 20).toLowerCase() : 'functional';
    cases.push({
      id,
      title: str(c.title, 120) || `Test case ${index + 1}`,
      priority,
      category,
      preconditions: (Array.isArray(c.preconditions) ? c.preconditions : []).map((p) => str(p, 200)).filter(Boolean),
      steps,
      expected,
      selected: previousSelection.get(id) ?? true,
    });
  });

  // Ids must be unique; renumber duplicates.
  const seen = new Set();
  for (const c of cases) {
    let id = c.id;
    let n = cases.length;
    while (seen.has(id)) id = `TC-${String(++n).padStart(2, '0')}`;
    c.id = id;
    seen.add(id);
  }

  const plan = {
    url: pageModel.url,
    title: pageModel.title,
    designedAt: new Date().toISOString(),
    revision: (previousPlan?.revision ?? 0) + 1,
    feedbackHistory: [...(previousPlan?.feedbackHistory ?? []), ...(feedback ? [feedback] : [])],
    cases,
    stats: { proposed: rawCases.length, kept: cases.length, droppedItems: dropped, llmMs: result.latencyMs },
  };
  return { plan, llm: result };
}

module.exports = { designTests };
