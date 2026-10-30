// Phase 3: Implementation. Generates a pytest + Playwright (Python) file for
// the selected test cases, then self-checks it:
//   1. every locator in the code must be one of the verified Python locators
//   2. the file must compile (python3 -m py_compile) when Python is available
// Problems trigger one repair round with the model; anything left is reported.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { GENERATE_SYSTEM, generateUserPrompt, repairUserPrompt } = require('./prompts');

const LOCATOR_CALL = /page\.(get_by_[a-z_]+|locator)\(/g;

function stripFences(text) {
  return text.trim().replace(/^```(?:python)?\s*/i, '').replace(/\s*```$/, '') + '\n';
}

/** Extract every `page.get_by_*(...)` / `page.locator(...)` expression, respecting nested parentheses and strings. */
function extractLocatorCalls(code) {
  const calls = [];
  let match;
  while ((match = LOCATOR_CALL.exec(code)) !== null) {
    let i = match.index + match[0].length;
    let depth = 1;
    let quote = null;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    const line = code.slice(0, match.index).split('\n').length;
    calls.push({ expr: code.slice(match.index, i), line });
    LOCATOR_CALL.lastIndex = i;
  }
  return calls;
}

/** Normalise quoting differences so "x" and 'x' compare equal. */
function normalise(expr) {
  return expr.replace(/\s+/g, '').replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, s) => JSON.stringify(s));
}

function allowedLocators(pageModel) {
  const set = new Set();
  for (const el of pageModel.elements) {
    if (el.locator?.python) set.add(normalise(el.locator.python));
    for (const alt of el.alternatives ?? []) if (alt.python) set.add(normalise(alt.python));
  }
  return set;
}

function findUnknownLocators(code, pageModel) {
  const allowed = allowedLocators(pageModel);
  return extractLocatorCalls(code)
    .filter(({ expr }) => !allowed.has(normalise(expr)))
    .map(({ expr, line }) => ({ line, expr }));
}

/** Interpreter candidates: Linux/macOS name first, then the Windows names. */
const PYTHON_CANDIDATES =
  process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];

function runPython(args) {
  return new Promise((resolve) => {
    const tryNext = (i) => {
      if (i >= PYTHON_CANDIDATES.length) return resolve({ available: false });
      const [cmd, pre] = PYTHON_CANDIDATES[i];
      execFile(cmd, [...pre, ...args], { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
        if (err && (err.code === 'ENOENT' || /not found|is not recognized/i.test(String(stderr)))) return tryNext(i + 1);
        resolve({ available: true, err, stdout, stderr });
      });
    };
    tryNext(0);
  });
}

/** @returns {Promise<{available: boolean, ok: boolean, error: string|null}>} */
async function compileCheck(code) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wta-py-'));
  const file = path.join(dir, 'test_generated.py');
  try {
    await fs.writeFile(file, code, 'utf8');
    const result = await runPython(['-I', '-m', 'py_compile', file]);
    if (!result.available) return { available: false, ok: true, error: null };
    if (result.err) {
      const text = String(result.stderr || result.err.message)
        .replace(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'test_generated.py')
        .trim();
      return { available: true, ok: false, error: text.slice(0, 1200) };
    }
    return { available: true, ok: true, error: null };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function validate(code, pageModel) {
  const unknownLocators = findUnknownLocators(code, pageModel);
  const compile = await compileCheck(code);
  const problems = [
    ...unknownLocators.map((u) => `Line ${u.line}: locator is not in the verified table: ${u.expr}`),
    ...(compile.ok ? [] : [`Python syntax error:\n${compile.error}`]),
  ];
  return { unknownLocators, pythonAvailable: compile.available, syntaxOk: compile.ok, syntaxError: compile.error, problems };
}

function fileNameFor(pageModel) {
  let host = 'page';
  try {
    host = new URL(pageModel.url).hostname.replace(/^www\./, '');
  } catch {
    /* keep default */
  }
  const slug = host.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'page';
  return `test_${slug}.py`;
}

/**
 * @param {object} pageModel
 * @param {object[]} cases selected test cases
 * @param {{ chat: Function, name: string }} provider
 * @param {(event: object) => void} emit
 */
async function generateTests(pageModel, cases, provider, emit) {
  const calls = [];
  emit({ type: 'status', status: 'thinking', detail: `Writing Python tests for ${cases.length} case(s)` });
  let result = await provider.chat({
    system: GENERATE_SYSTEM,
    messages: [{ role: 'user', content: generateUserPrompt(pageModel, cases) }],
    temperature: 0.1,
  });
  calls.push(result);
  let code = stripFences(result.text);

  emit({ type: 'status', status: 'thinking', detail: 'Checking locators and syntax' });
  let validation = await validate(code, pageModel);
  let repaired = false;

  if (validation.problems.length) {
    emit({ type: 'status', status: 'thinking', detail: `Repairing ${validation.problems.length} problem(s)` });
    result = await provider.chat({
      system: GENERATE_SYSTEM,
      messages: [
        { role: 'user', content: generateUserPrompt(pageModel, cases) },
        { role: 'assistant', content: code },
        { role: 'user', content: repairUserPrompt(code, validation.problems) },
      ],
      temperature: 0.1,
    });
    calls.push(result);
    const candidate = stripFences(result.text);
    const revalidated = await validate(candidate, pageModel);
    // Keep the repair only when it actually reduces the problems.
    if (revalidated.problems.length < validation.problems.length) {
      code = candidate;
      validation = revalidated;
      repaired = true;
    }
  }

  return {
    generated: {
      language: 'python',
      framework: 'pytest + playwright',
      fileName: fileNameFor(pageModel),
      code,
      caseIds: cases.map((c) => c.id),
      generatedAt: new Date().toISOString(),
      validation: {
        syntaxOk: validation.syntaxOk,
        syntaxError: validation.syntaxError,
        pythonAvailable: validation.pythonAvailable,
        unknownLocators: validation.unknownLocators,
        repaired,
        clean: validation.problems.length === 0,
      },
    },
    calls,
  };
}

module.exports = { generateTests, extractLocatorCalls, findUnknownLocators, normalise };
