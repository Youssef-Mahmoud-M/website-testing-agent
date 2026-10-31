// Google Gemini via the public REST API (free tier). The key travels in a
// header, not the query string, so it never lands in URL logs.
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

class GeminiProvider {
  constructor({ apiKey, model, timeoutMs = 60_000 }) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.name = 'gemini';
  }

  async chat({ system, messages, json = false, temperature = 0.2 }) {
    const body = {
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        temperature,
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const { fetchWithTimeout } = require('./provider');
    const started = Date.now();
    const res = await fetchWithTimeout(
      `${ENDPOINT}/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
      },
      { timeoutMs: this.timeoutMs, label: `Gemini (${this.model})` },
    );
    const latencyMs = Date.now() - started;

    if (!res.ok) {
      const raw = await res.text();
      let detail = raw.slice(0, 300);
      try {
        detail = JSON.parse(raw).error?.message ?? detail;
      } catch {
        /* keep raw */
      }
      const { LlmError } = require('./provider');
      throw new LlmError(`Gemini ${res.status}: ${detail}`, { status: res.status, retryable: res.status === 429 });
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const usage = data.usageMetadata ?? {};
    const inputTokens = usage.promptTokenCount ?? 0;
    const outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
    return {
      text,
      usage: { inputTokens, outputTokens, totalTokens: usage.totalTokenCount ?? inputTokens + outputTokens },
      latencyMs,
      model: this.model,
      finishReason: candidate?.finishReason ?? null,
    };
  }
}

module.exports = { GeminiProvider };
