// Persists LLM settings in the Electron userData folder.
//
// API key storage, most secure option that works first:
//   1. encrypted with Electron safeStorage (OS keychain backed)
//   2. in memory for this session only, when no keychain is available
//   3. unencrypted on disk (0600), only when the user explicitly opts in
// Environment variables remain a fallback for all of them. The renderer only
// ever learns whether a key exists and where it came from, never the key.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const PROVIDERS = ['gemini', 'ollama'];

const DEFAULTS = Object.freeze({
  provider: 'gemini',
  geminiModel: 'gemini-3.8-flash',
  ollamaModel: 'llama3.1',
  ollamaUrl: 'http://127.0.0.1:11434',
  /** Per-request LLM timeout in seconds. */
  requestTimeoutSec: 60,
});
const TIMEOUT_RANGE = Object.freeze({ min: 5, max: 600 });

/** Key kept only in this process's memory; gone when the app exits. */
let sessionKey = null;

function filePath() {
  return path.join(app.getPath('userData'), 'llm-config.json');
}

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeFile(data) {
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(filePath(), 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
}

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function storageBackend() {
  if (process.platform !== 'linux') return 'os-keychain';
  try {
    return safeStorage.getSelectedStorageBackend();
  } catch {
    return 'unknown';
  }
}

function decrypt(encryptedKey) {
  try {
    return safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'));
  } catch {
    return null;
  }
}

/** Settings plus the resolved key and where it came from. */
function resolve() {
  const stored = readFile();
  const settings = { ...DEFAULTS, ...(stored.settings ?? {}) };
  let apiKey = null;
  let keySource = null;

  if (stored.encryptedKey && encryptionAvailable()) {
    apiKey = decrypt(stored.encryptedKey);
    if (apiKey) keySource = 'encrypted';
  }
  if (!apiKey && stored.plaintextKey) {
    apiKey = stored.plaintextKey;
    keySource = 'plaintext';
  }
  if (!apiKey && sessionKey) {
    apiKey = sessionKey;
    keySource = 'session';
  }
  if (!apiKey && process.env.GEMINI_API_KEY) {
    apiKey = process.env.GEMINI_API_KEY;
    keySource = 'env';
  }

  if (process.env.LLM_PROVIDER) settings.provider = process.env.LLM_PROVIDER;
  if (process.env.GEMINI_MODEL) settings.geminiModel = process.env.GEMINI_MODEL;
  if (process.env.OLLAMA_MODEL) settings.ollamaModel = process.env.OLLAMA_MODEL;
  if (process.env.OLLAMA_URL) settings.ollamaUrl = process.env.OLLAMA_URL;
  if (process.env.LLM_TIMEOUT_SEC) {
    const n = Number(process.env.LLM_TIMEOUT_SEC);
    if (Number.isFinite(n) && n >= TIMEOUT_RANGE.min && n <= TIMEOUT_RANGE.max) settings.requestTimeoutSec = n;
  }
  return { ...settings, apiKey, keySource };
}

const ENV_OVERRIDES = Object.freeze({
  LLM_PROVIDER: 'provider',
  GEMINI_MODEL: 'geminiModel',
  OLLAMA_MODEL: 'ollamaModel',
  OLLAMA_URL: 'ollamaUrl',
  LLM_TIMEOUT_SEC: 'requestTimeoutSec',
});

/**
 * What the renderer is allowed to see: the STORED settings (what the form
 * edits), the effective provider, and which environment overrides are active.
 */
function publicView() {
  const stored = readFile();
  const effective = resolve();
  const envOverrides = Object.entries(ENV_OVERRIDES)
    .filter(([name]) => process.env[name])
    .map(([name, field]) => ({ name, field, value: process.env[name] }));
  return {
    ...DEFAULTS,
    ...(stored.settings ?? {}),
    activeProvider: effective.provider,
    envOverrides,
    hasApiKey: Boolean(effective.apiKey),
    keySource: effective.keySource,
    encryptionAvailable: encryptionAvailable(),
    storageBackend: storageBackend(),
  };
}

/**
 * If a key was saved unencrypted while no keychain was available and one is
 * available now, re-encrypt it and remove the plaintext copy. Runs at startup.
 */
function migrate() {
  const stored = readFile();
  if (stored.plaintextKey && encryptionAvailable()) {
    writeFile({
      settings: stored.settings ?? {},
      encryptedKey: safeStorage.encryptString(stored.plaintextKey).toString('base64'),
      plaintextKey: null,
    });
    return true;
  }
  return false;
}

/**
 * @param {Record<string, unknown>} input validated settings from the renderer
 *   `apiKey`: undefined keeps the current key, '' removes it, a string replaces it.
 *   `persistPlaintext`: true allows an unencrypted on-disk copy when no keychain exists.
 */
function save(input) {
  if (!input || typeof input !== 'object') throw new Error('Settings must be an object');
  const current = readFile();
  const settings = { ...DEFAULTS, ...(current.settings ?? {}) };

  if (input.provider !== undefined) {
    if (!PROVIDERS.includes(input.provider)) throw new Error(`Unknown provider ${input.provider}`);
    settings.provider = input.provider;
  }
  for (const key of ['geminiModel', 'ollamaModel']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || !/^[\w.:/-]{1,80}$/.test(input[key])) {
        throw new Error(`Invalid model name for ${key}`);
      }
      settings[key] = input[key];
    }
  }
  if (input.ollamaUrl !== undefined) {
    const url = new URL(String(input.ollamaUrl));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Ollama URL must be http or https');
    settings.ollamaUrl = url.origin;
  }

  if (input.requestTimeoutSec !== undefined) {
    const n = Number(input.requestTimeoutSec);
    if (!Number.isInteger(n) || n < TIMEOUT_RANGE.min || n > TIMEOUT_RANGE.max) {
      throw new Error(`Request timeout must be a whole number between ${TIMEOUT_RANGE.min} and ${TIMEOUT_RANGE.max} seconds`);
    }
    settings.requestTimeoutSec = n;
  }

  let encryptedKey = current.encryptedKey ?? null;
  let plaintextKey = current.plaintextKey ?? null;

  if (input.apiKey !== undefined) {
    if (input.apiKey === '' || input.apiKey === null) {
      encryptedKey = null;
      plaintextKey = null;
      sessionKey = null;
    } else {
      if (typeof input.apiKey !== 'string' || input.apiKey.length > 512) throw new Error('Invalid API key');
      const key = input.apiKey.trim();
      encryptedKey = null;
      plaintextKey = null;
      sessionKey = null;
      if (encryptionAvailable()) {
        encryptedKey = safeStorage.encryptString(key).toString('base64');
      } else if (input.persistPlaintext === true) {
        plaintextKey = key;
      } else {
        sessionKey = key;
      }
    }
  }

  writeFile({ settings, encryptedKey, plaintextKey });
  return publicView();
}

module.exports = { resolve, publicView, save, migrate, DEFAULTS, PROVIDERS };
