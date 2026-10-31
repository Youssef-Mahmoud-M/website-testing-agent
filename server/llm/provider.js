// Provider factory. Every provider implements:
//   chat({ system, messages, json, temperature }) ->
//     { text, usage: { inputTokens, outputTokens, totalTokens }, latencyMs, model }
// Only free-tier or local providers are offered, per the project constraints.
const { GeminiProvider } = require('./gemini');
const { OllamaProvider } = require('./ollama');
const { MockProvider } = require('./mock');

class LlmError extends Error {
  constructor(message, { status, retryable = false, timeout = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
    this.timeout = timeout;
  }
}

/** @param {ReturnType<import('../config-store').resolve>} config */
function createProvider(config) {
  const timeoutMs = Math.round((config.requestTimeoutSec ?? 60) * 1000);
  switch (config.provider) {
    case 'gemini':
      if (!config.apiKey) {
        throw new LlmError('No Gemini API key configured. Enter one in Settings, or set GEMINI_API_KEY in the server environment.');
      }
      return new GeminiProvider({ apiKey: config.apiKey, model: config.geminiModel, timeoutMs });
    case 'ollama':
      return new OllamaProvider({ baseUrl: config.ollamaUrl, model: config.ollamaModel, timeoutMs });
    case 'mock':
      // Development only: reachable through LLM_PROVIDER=mock, never from the UI.
      return Object.assign(new MockProvider(), { timeoutMs });
    default:
      throw new LlmError(`Unknown LLM provider "${config.provider}"`);
  }
}

/** Strip ```json fences and parse. Throws a readable error on failure. */
function parseJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new LlmError('The model did not return valid JSON.');
  }
}

/**
 * fetch() with a hard deadline. Converts the abort into a readable LlmError
 * that tells the user where to change the limit.
 */
async function fetchWithTimeout(url, init, { timeoutMs, label }) {
  const started = Date.now();
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      const secs = Math.round((Date.now() - started) / 1000);
      throw new LlmError(
        `Timed out after ${secs} s waiting for ${label}. Raise the request timeout in Settings or pick a faster model.`,
        { retryable: true, timeout: true },
      );
    }
    throw err;
  }
}

module.exports = { createProvider, LlmError, parseJson, fetchWithTimeout };
