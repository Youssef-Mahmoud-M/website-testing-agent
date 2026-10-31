// LLM settings for one browser session, kept in server memory only.
//
// A website has no per-user keychain, so API keys entered in the UI live in
// the session and vanish when it expires. Permanent configuration belongs in
// the server's environment (GEMINI_API_KEY, LLM_PROVIDER, ...), which every
// session starts from. Nothing is written to disk and the key is never sent
// back to the browser.
const PROVIDERS = ['gemini', 'ollama'];
const TIMEOUT_RANGE = Object.freeze({ min: 5, max: 600 });

const DEFAULTS = Object.freeze({
  provider: 'gemini',
  geminiModel: 'gemini-3.8-flash',
  ollamaModel: 'llama3.1',
  ollamaUrl: 'http://127.0.0.1:11434',
  requestTimeoutSec: 60,
});

const ENV_OVERRIDES = Object.freeze({
  LLM_PROVIDER: 'provider',
  GEMINI_MODEL: 'geminiModel',
  OLLAMA_MODEL: 'ollamaModel',
  OLLAMA_URL: 'ollamaUrl',
  LLM_TIMEOUT_SEC: 'requestTimeoutSec',
});

function envOverrides() {
  return Object.entries(ENV_OVERRIDES)
    .filter(([name]) => process.env[name])
    .map(([name, field]) => ({ name, field, value: process.env[name] }));
}

function applyEnv(settings) {
  const out = { ...settings };
  for (const { field, value } of envOverrides()) {
    if (field === 'requestTimeoutSec') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= TIMEOUT_RANGE.min && n <= TIMEOUT_RANGE.max) out.requestTimeoutSec = n;
    } else {
      out[field] = value;
    }
  }
  return out;
}

class SessionConfig {
  constructor() {
    this.settings = { ...DEFAULTS };
    this.sessionKey = null;
  }

  /** Effective settings plus the key and where it came from. */
  resolve() {
    const settings = applyEnv(this.settings);
    let apiKey = null;
    let keySource = null;
    if (this.sessionKey) {
      apiKey = this.sessionKey;
      keySource = 'session';
    } else if (process.env.GEMINI_API_KEY) {
      apiKey = process.env.GEMINI_API_KEY;
      keySource = 'env';
    }
    return { ...settings, apiKey, keySource };
  }

  /** What the browser is allowed to see. */
  publicView() {
    const effective = this.resolve();
    return {
      ...this.settings,
      activeProvider: effective.provider,
      envOverrides: envOverrides(),
      hasApiKey: Boolean(effective.apiKey),
      keySource: effective.keySource,
      encryptionAvailable: false,
      storageBackend: 'session-memory',
    };
  }

  /** @param {Record<string, unknown>} input validated settings from the browser */
  save(input) {
    if (!input || typeof input !== 'object') throw new Error('Settings must be an object');
    const settings = { ...this.settings };
    if (input.provider !== undefined) {
      if (!PROVIDERS.includes(input.provider)) throw new Error(`Unknown provider ${input.provider}`);
      settings.provider = input.provider;
    }
    for (const key of ['geminiModel', 'ollamaModel']) {
      if (input[key] !== undefined) {
        if (typeof input[key] !== 'string' || !/^[\w.:/-]{1,80}$/.test(input[key])) throw new Error(`Invalid model name for ${key}`);
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
    if (input.apiKey !== undefined) {
      if (input.apiKey === '' || input.apiKey === null) this.sessionKey = null;
      else {
        if (typeof input.apiKey !== 'string' || input.apiKey.length > 512) throw new Error('Invalid API key');
        this.sessionKey = input.apiKey.trim();
      }
    }
    this.settings = settings;
    return this.publicView();
  }
}

module.exports = { SessionConfig, DEFAULTS, PROVIDERS };
