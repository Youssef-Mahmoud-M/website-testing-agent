// Prompt templates. Element references (e1, e2, ...) come from the DOM
// extraction, so the model can only describe elements that really exist.

const EXPLORE_SYSTEM = `You are a senior QA engineer exploring a web page to prepare for test design.
You receive a structured inventory of the page: metadata, an accessibility snapshot,
and a numbered table of interactive elements with verified Playwright locators.

Rules:
- Refer to elements ONLY by their reference ids from the table (e1, e2, ...).
- Never invent elements, locators, or behaviour you cannot infer from the inventory.
- Be concrete and concise. Descriptions are for other QA engineers.
- Respond with a single JSON object and nothing else, using exactly this shape:
{
  "summary": "2-3 sentences describing what the page is and does",
  "purpose": "the user goal this page serves",
  "sections": [{ "name": "...", "description": "...", "elementRefs": ["e1"] }],
  "interactiveElements": [{ "ref": "e1", "description": "what it is", "expectedBehavior": "what should happen when used" }],
  "forms": [{ "name": "...", "fieldRefs": ["e2"], "submitRef": "e3", "validationHints": ["..."] }],
  "navigation": [{ "ref": "e4", "destination": "where it likely leads" }],
  "risks": ["areas likely to hide defects"],
  "suggestedTestAreas": ["high-level areas worth covering"]
}`;

const CHAT_SYSTEM = `You are a web testing agent working with a human QA engineer in a chat.
You help them explore pages, design test cases, and reason about Playwright tests.
Be direct and practical. Use short paragraphs or bullet lists. When you mention page
elements, use their reference ids and verified locators from the page model; never
invent locators. If no page has been explored yet, ask for a URL to explore.`;

/** @param {object} inventory from explorer.extract */
function exploreUserPrompt(inventory, ariaSnapshot) {
  const lines = inventory.elements.map((el) => {
    const bits = [el.ref, el.role || el.tag, JSON.stringify(el.name || el.text || ''), el.locator?.code ?? 'n/a'];
    if (el.type) bits.splice(2, 0, `type=${el.type}`);
    if (el.href) bits.push(`href=${el.href.slice(0, 80)}`);
    if (el.disabled) bits.push('disabled');
    if (el.required) bits.push('required');
    return bits.join(' | ');
  });
  return [
    `URL: ${inventory.url}`,
    `Title: ${inventory.title}`,
    `Language: ${inventory.lang || 'unknown'}`,
    `Headings: ${inventory.headings.map((h) => `h${h.level} ${JSON.stringify(h.text)}`).join('; ') || 'none'}`,
    `Forms: ${inventory.forms.length}`,
    `Interactive elements found: ${inventory.elementTotal} (showing ${inventory.elements.length} visible)`,
    '',
    'Visible text preview:',
    inventory.textPreview,
    '',
    'Accessibility snapshot (truncated):',
    ariaSnapshot,
    '',
    'Interactive elements (ref | role | "name" | locator | extras):',
    ...lines,
  ].join('\n');
}

/** Compact page model for chat context, bounded in size. */
function pageModelContext(pageModel, maxElements = 80) {
  if (!pageModel) return 'No page has been explored yet.';
  const elements = pageModel.elements
    .slice(0, maxElements)
    .map((el) => `${el.ref} | ${el.role || el.tag} | ${JSON.stringify(el.name || el.text || '')} | ${el.locator.code}${el.description ? ` | ${el.description}` : ''}`);
  return [
    `Explored page: ${pageModel.url}`,
    `Title: ${pageModel.title}`,
    `Summary: ${pageModel.summary}`,
    `Purpose: ${pageModel.purpose}`,
    `Sections: ${pageModel.sections.map((s) => `${s.name} (${s.elementRefs.join(', ')})`).join('; ')}`,
    `Risks: ${pageModel.risks.join('; ')}`,
    `Suggested test areas: ${pageModel.suggestedTestAreas.join('; ')}`,
    'Elements (ref | role | "name" | locator | description):',
    ...elements,
  ].join('\n');
}

const STEP_ACTIONS = ['goto', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'hover'];
const ASSERTIONS = ['visible', 'hidden', 'text', 'value', 'url', 'title', 'enabled', 'disabled', 'checked', 'count'];

const DESIGN_SYSTEM = `You are a senior QA engineer designing test cases for a web page together with a human reviewer.
You receive the page model: summary, sections, forms, risks and a table of interactive elements with reference ids.

Rules:
- Refer to elements ONLY by their reference ids (e1, e2, ...). Never invent elements.
- Cover the main user goal, form validation (valid and invalid input), navigation, and risky areas.
- Prefer fewer, meaningful cases over many trivial ones. 4 to 12 cases is typical.
- Steps use only these actions: ${STEP_ACTIONS.join(', ')}. "goto" takes a URL in "value" and no ref.
  "fill", "select" and "press" need a "value". "press" uses Playwright key names such as "Enter".
- Expectations use only these assertions: ${ASSERTIONS.join(', ')}. "url" and "title" take no ref and
  put the expected substring in "value". "text", "value" and "count" put the expected value in "value".
- Respond with a single JSON object and nothing else, using exactly this shape:
{
  "cases": [
    {
      "id": "TC-01",
      "title": "short imperative title",
      "priority": "high" | "medium" | "low",
      "category": "functional" | "validation" | "navigation" | "negative" | "ui" | "accessibility",
      "preconditions": ["..."],
      "steps": [{ "action": "fill", "ref": "e4", "value": "user@example.com" }],
      "expected": [{ "assert": "visible", "ref": "e9" }]
    }
  ]
}`;

const GENERATE_SYSTEM = `You are a senior test automation engineer writing Python tests with pytest and Playwright (sync API).
You receive a page URL, a table of elements with VERIFIED Python locators, and a structured list of test cases.

Rules:
- Use ONLY the Python locator expressions given in the table, copied verbatim. Never invent or modify a locator.
- One test function per test case, named test_<id>_<snake_case_title>, with a docstring "<id>: <title>".
- Use the pytest-playwright "page" fixture and "expect" from playwright.sync_api for every assertion.
- Start with: import re, import pytest, from playwright.sync_api import Page, expect. A BASE_URL constant,
  and an autouse fixture that calls page.goto(BASE_URL) before each test.
- No sleeps, no try/except around assertions, no network stubs, no extra imports, no comments about the rules.
- Map assertions: visible -> expect(loc).to_be_visible(); hidden -> to_be_hidden(); text -> to_contain_text(value);
  value -> to_have_value(value); enabled/disabled/checked -> to_be_enabled()/to_be_disabled()/to_be_checked();
  url -> expect(page).to_have_url(re.compile(re.escape(value))); title -> expect(page).to_have_title(re.compile(re.escape(value)));
  count -> expect(loc).to_have_count(int(value)).
- Respond with the complete Python file only. No markdown fences, no explanations.`;

function elementTable(pageModel, { python = false } = {}) {
  return pageModel.elements
    .map((el) => {
      const loc = python ? el.locator.python : el.locator.code;
      const desc = el.description ? ` | ${el.description}` : '';
      return `${el.ref} | ${el.role || el.tag}${el.type ? ` (${el.type})` : ''} | ${JSON.stringify(el.name || el.text || '')} | ${loc}${desc}`;
    })
    .join('\n');
}

function designUserPrompt(pageModel, { feedback = null, previousPlan = null } = {}) {
  const parts = [
    `URL: ${pageModel.url}`,
    `Title: ${pageModel.title}`,
    `Summary: ${pageModel.summary}`,
    `Purpose: ${pageModel.purpose}`,
    `Sections: ${pageModel.sections.map((s) => `${s.name} [${s.elementRefs.join(', ')}]: ${s.description}`).join(' | ') || 'none'}`,
    `Forms: ${pageModel.forms.map((f) => `${f.name} fields [${f.fieldRefs.join(', ')}] submit ${f.submitRef || 'n/a'}`).join(' | ') || 'none'}`,
    `Risks: ${pageModel.risks.join('; ') || 'none'}`,
    `Suggested test areas: ${pageModel.suggestedTestAreas.join('; ') || 'none'}`,
    '',
    'Elements (ref | role | "name" | locator | description):',
    elementTable(pageModel),
  ];
  if (previousPlan) {
    parts.push('', 'Current test plan (JSON):', JSON.stringify({ cases: previousPlan.cases.map(stripCase) }));
  }
  if (feedback) {
    parts.push('', 'Reviewer feedback. Revise the plan accordingly, keep the ids of unchanged cases stable, and return the FULL plan:', feedback);
  } else {
    parts.push('', 'Design the test plan.');
  }
  return parts.join('\n');
}

function stripCase(c) {
  const { selected, dropped, ...rest } = c;
  return rest;
}

function generateUserPrompt(pageModel, cases) {
  return [
    `BASE_URL: ${pageModel.url}`,
    `Page title: ${pageModel.title}`,
    '',
    'Elements (ref | role | "name" | PYTHON LOCATOR | description):',
    elementTable(pageModel, { python: true }),
    '',
    'Test cases (JSON):',
    JSON.stringify({ cases: cases.map(stripCase) }, null, 1),
  ].join('\n');
}

function repairUserPrompt(code, problems) {
  return [
    'The following Python test file has problems. Fix them and return the complete corrected file only.',
    'Problems:',
    ...problems.map((p) => `- ${p}`),
    '',
    'File:',
    code,
  ].join('\n');
}

module.exports = {
  EXPLORE_SYSTEM,
  CHAT_SYSTEM,
  DESIGN_SYSTEM,
  GENERATE_SYSTEM,
  STEP_ACTIONS,
  ASSERTIONS,
  exploreUserPrompt,
  pageModelContext,
  designUserPrompt,
  generateUserPrompt,
  repairUserPrompt,
};
