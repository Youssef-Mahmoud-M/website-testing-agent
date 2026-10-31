// Phase 1: Exploration.
// 1. Extract interactive elements from the live DOM (deterministic, no LLM).
// 2. Generate locator candidates per element and VERIFY each against the page
//    until one uniquely matches that exact element.
// 3. Ask the LLM to describe the page using only those element references.
// 4. Drop any reference the model invented and count it as a hallucination.
const { parseJson } = require('../llm/provider');
const { EXPLORE_SYSTEM, exploreUserPrompt } = require('./prompts');

const MAX_ELEMENTS = 120;
const ARIA_SNAPSHOT_CHARS = 10_000;
const REF_ATTR = 'data-wta-ref';

const ROLE_SET = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'tab', 'menuitem',
  'switch', 'slider', 'spinbutton', 'searchbox', 'heading', 'img', 'dialog', 'menu', 'navigation', 'main',
  'banner', 'contentinfo', 'form', 'region', 'list', 'listitem', 'table', 'row', 'cell', 'columnheader',
]);

/* Runs inside the page. Must stay self-contained: no closures over Node scope. */
function extractInPage({ maxElements, refAttr }) {
  const SELECTOR =
    'a[href], button, input, select, textarea, summary, [role], [onclick], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const text = (el) => clean(el.innerText || el.textContent).slice(0, 80);
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return text(l);
    }
    const wrap = el.closest('label');
    return wrap ? text(wrap) : '';
  };
  const labelledBy = (el) => {
    const ids = el.getAttribute('aria-labelledby');
    if (!ids) return '';
    return ids.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(text).join(' ');
  };
  const implicitRole = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'input') {
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (['hidden'].includes(type)) return null;
      return 'textbox';
    }
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    const landmarks = { nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', form: 'form' };
    return landmarks[tag] || null;
  };
  const accName = (el) => {
    const tag = el.tagName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const isField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
    return clean(
      el.getAttribute('aria-label') ||
        labelledBy(el) ||
        (isField ? labelFor(el) : '') ||
        (tag === 'IMG' ? el.getAttribute('alt') : '') ||
        (tag === 'INPUT' && ['submit', 'button', 'reset'].includes(type) ? el.value : '') ||
        (!isField ? text(el) : '') ||
        el.getAttribute('title') ||
        el.getAttribute('placeholder') ||
        '',
    ).slice(0, 120);
  };
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      const tag = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
      node = parent;
    }
    return parts.join(' > ');
  };

  const all = Array.from(document.querySelectorAll(SELECTOR));
  const visible = all.filter(isVisible).filter((el) => implicitRole(el) !== null || el.hasAttribute('role'));
  const elements = visible.slice(0, maxElements).map((el, i) => {
    const ref = `e${i + 1}`;
    el.setAttribute(refAttr, ref);
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : null;
    return {
      ref,
      tag,
      type,
      role: el.getAttribute('role') || implicitRole(el),
      name: accName(el),
      id: el.id || null,
      testId:
        el.getAttribute('data-testid') ||
        el.getAttribute('data-test-id') ||
        el.getAttribute('data-test') ||
        el.getAttribute('data-cy') ||
        el.getAttribute('data-qa') ||
        null,
      testIdAttr: ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'].find((a) => el.hasAttribute(a)) || null,
      nameAttr: el.getAttribute('name'),
      placeholder: el.getAttribute('placeholder'),
      href: tag === 'a' ? el.getAttribute('href') : null,
      text: text(el),
      value: tag === 'input' && type !== 'password' ? clean(el.value).slice(0, 40) : null,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      required: el.required === true || el.getAttribute('aria-required') === 'true',
      labelText: ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ? labelFor(el) : '',
      cssPath: cssPath(el),
      bbox: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    };
  });

  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || null,
    viewport: { width: innerWidth, height: innerHeight },
    textPreview: clean(document.body ? document.body.innerText : '').slice(0, 3000),
    headings: Array.from(document.querySelectorAll('h1,h2,h3'))
      .filter(isVisible)
      .slice(0, 40)
      .map((h) => ({ level: Number(h.tagName[1]), text: text(h) })),
    forms: Array.from(document.forms).map((f, i) => ({
      index: i,
      id: f.id || null,
      name: f.getAttribute('name'),
      action: f.getAttribute('action'),
      method: (f.getAttribute('method') || 'get').toLowerCase(),
      fieldCount: f.elements.length,
    })),
    elementTotal: visible.length,
    elements,
  };
}

const q = (s) => JSON.stringify(s);
// JSON string literals are valid Python string literals too.
const py = (s) => JSON.stringify(s);
const looksGenerated = (id) => !/^[A-Za-z][\w-]{0,40}$/.test(id) || /\d{3,}/.test(id) || /^(ember|react|radix|mui|headlessui|:)/i.test(id);

/** Ordered locator candidates for one element; each has `code` and a builder. */
function candidatesFor(el) {
  const list = [];
  if (el.testId) {
    if (el.testIdAttr === 'data-testid') {
      list.push({ strategy: 'testId', code: `page.getByTestId(${q(el.testId)})`, python: `page.get_by_test_id(${py(el.testId)})`, build: (p) => p.getByTestId(el.testId) });
    } else {
      const css = `[${el.testIdAttr}=${q(el.testId)}]`;
      list.push({ strategy: 'testId', code: `page.locator(${q(css)})`, python: `page.locator(${py(css)})`, build: (p) => p.locator(css) });
    }
  }
  if (el.role && ROLE_SET.has(el.role) && el.name && el.name.length <= 80) {
    list.push({
      strategy: 'role',
      code: `page.getByRole(${q(el.role)}, { name: ${q(el.name)}, exact: true })`,
      python: `page.get_by_role(${py(el.role)}, name=${py(el.name)}, exact=True)`,
      build: (p) => p.getByRole(el.role, { name: el.name, exact: true }),
    });
  }
  if (el.labelText && el.labelText.length <= 80) {
    list.push({ strategy: 'label', code: `page.getByLabel(${q(el.labelText)}, { exact: true })`, python: `page.get_by_label(${py(el.labelText)}, exact=True)`, build: (p) => p.getByLabel(el.labelText, { exact: true }) });
  }
  if (el.placeholder && el.placeholder.length <= 80) {
    list.push({ strategy: 'placeholder', code: `page.getByPlaceholder(${q(el.placeholder)}, { exact: true })`, python: `page.get_by_placeholder(${py(el.placeholder)}, exact=True)`, build: (p) => p.getByPlaceholder(el.placeholder, { exact: true }) });
  }
  if (el.id && !looksGenerated(el.id)) {
    const css = `#${el.id}`;
    list.push({ strategy: 'id', code: `page.locator(${q(css)})`, python: `page.locator(${py(css)})`, build: (p) => p.locator(css) });
  }
  if (el.text && el.text.length <= 50 && ['link', 'button', 'tab', 'menuitem', 'heading'].includes(el.role)) {
    list.push({ strategy: 'text', code: `page.getByText(${q(el.text)}, { exact: true })`, python: `page.get_by_text(${py(el.text)}, exact=True)`, build: (p) => p.getByText(el.text, { exact: true }) });
  }
  if (el.nameAttr && ['input', 'select', 'textarea'].includes(el.tag)) {
    const css = `${el.tag}[name=${q(el.nameAttr)}]`;
    list.push({ strategy: 'nameAttr', code: `page.locator(${q(css)})`, python: `page.locator(${py(css)})`, build: (p) => p.locator(css) });
  }
  if (el.href && el.tag === 'a' && el.href.length <= 120) {
    const css = `a[href=${q(el.href)}]`;
    list.push({ strategy: 'href', code: `page.locator(${q(css)})`, python: `page.locator(${py(css)})`, build: (p) => p.locator(css) });
  }
  list.push({ strategy: 'css', code: `page.locator(${q(el.cssPath)})`, python: `page.locator(${py(el.cssPath)})`, build: (p) => p.locator(el.cssPath) });
  return list;
}

/** Try candidates in order; accept the first that matches exactly this element. */
async function verifyLocators(page, elements) {
  let verified = 0;
  for (const el of elements) {
    const candidates = candidatesFor(el);
    const tried = [];
    let chosen = null;
    for (const candidate of candidates) {
      let count = -1;
      let matchesRef = false;
      try {
        const locator = candidate.build(page);
        count = await locator.count();
        if (count === 1) {
          matchesRef = (await locator.first().getAttribute(REF_ATTR)) === el.ref;
        }
      } catch {
        count = -1;
      }
      tried.push({ strategy: candidate.strategy, code: candidate.code, python: candidate.python, count, unique: count === 1 && matchesRef });
      if (count === 1 && matchesRef) {
        chosen = { strategy: candidate.strategy, code: candidate.code, python: candidate.python, verified: true };
        break;
      }
    }
    if (!chosen) {
      const fallback = candidates[candidates.length - 1];
      chosen = { strategy: fallback.strategy, code: fallback.code, python: fallback.python, verified: false };
    } else {
      verified += 1;
    }
    el.locator = chosen;
    el.alternatives = tried.filter((t) => t.unique && t.code !== chosen.code).map(({ strategy, code, python }) => ({ strategy, code, python }));
    el.locatorAttempts = tried.length;
  }
  return verified;
}

/**
 * @param {import('playwright').Page} page already navigated to the target
 * @param {{ chat: Function, name: string }} provider
 * @param {(event: object) => void} emit progress callback
 */
async function explorePage(page, provider, emit) {
  const started = Date.now();
  emit({ type: 'status', status: 'exploring', detail: 'Extracting interactive elements' });
  const inventory = await page.evaluate(extractInPage, { maxElements: MAX_ELEMENTS, refAttr: REF_ATTR });
  const extractMs = Date.now() - started;

  emit({ type: 'status', status: 'exploring', detail: `Verifying locators for ${inventory.elements.length} elements` });
  const verifyStart = Date.now();
  const verifiedUnique = await verifyLocators(page, inventory.elements);
  const verifyMs = Date.now() - verifyStart;

  let ariaSnapshot = '';
  try {
    ariaSnapshot = (await page.locator('body').ariaSnapshot()).slice(0, ARIA_SNAPSHOT_CHARS);
  } catch {
    ariaSnapshot = '(unavailable)';
  }

  emit({ type: 'status', status: 'exploring', detail: `Asking ${provider.name} to describe the page` });
  const result = await provider.chat({
    system: EXPLORE_SYSTEM,
    messages: [{ role: 'user', content: exploreUserPrompt(inventory, ariaSnapshot) }],
    json: true,
    temperature: 0.1,
  });

  const raw = parseJson(result.text);
  const known = new Set(inventory.elements.map((el) => el.ref));
  let dropped = 0;
  const keepRef = (ref) => {
    if (typeof ref === 'string' && known.has(ref)) return true;
    dropped += 1;
    return false;
  };
  const strList = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string').map((s) => s.slice(0, 300)) : []);
  const refList = (v) => (Array.isArray(v) ? v.filter(keepRef) : []);

  const described = new Map();
  for (const item of Array.isArray(raw.interactiveElements) ? raw.interactiveElements : []) {
    if (item && keepRef(item.ref)) {
      described.set(item.ref, {
        description: String(item.description ?? '').slice(0, 300),
        expectedBehavior: String(item.expectedBehavior ?? '').slice(0, 300),
      });
    }
  }
  const elements = inventory.elements.map((el) => ({ ...el, ...(described.get(el.ref) ?? {}) }));

  const pageModel = {
    url: inventory.url,
    title: inventory.title,
    exploredAt: new Date().toISOString(),
    summary: String(raw.summary ?? '').slice(0, 1000),
    purpose: String(raw.purpose ?? '').slice(0, 500),
    sections: (Array.isArray(raw.sections) ? raw.sections : [])
      .filter((s) => s && typeof s.name === 'string')
      .map((s) => ({ name: s.name.slice(0, 100), description: String(s.description ?? '').slice(0, 400), elementRefs: refList(s.elementRefs) })),
    forms: (Array.isArray(raw.forms) ? raw.forms : [])
      .filter((f) => f && typeof f.name === 'string')
      .map((f) => ({
        name: f.name.slice(0, 100),
        fieldRefs: refList(f.fieldRefs),
        submitRef: f.submitRef && keepRef(f.submitRef) ? f.submitRef : null,
        validationHints: strList(f.validationHints),
      })),
    navigation: (Array.isArray(raw.navigation) ? raw.navigation : [])
      .filter((n) => n && keepRef(n.ref))
      .map((n) => ({ ref: n.ref, destination: String(n.destination ?? '').slice(0, 200) })),
    risks: strList(raw.risks),
    suggestedTestAreas: strList(raw.suggestedTestAreas),
    headings: inventory.headings,
    elements,
    stats: {
      elementTotal: inventory.elementTotal,
      extracted: inventory.elements.length,
      verifiedUnique,
      describedByModel: described.size,
      droppedReferences: dropped,
      extractMs,
      verifyMs,
      llmMs: result.latencyMs,
      totalMs: Date.now() - started,
    },
  };

  return { pageModel, llm: result };
}

module.exports = { explorePage, candidatesFor, MAX_ELEMENTS };
