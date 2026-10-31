// Local models through Ollama's /api/chat endpoint.
class OllamaProvider {
  constructor({ baseUrl, model, timeoutMs = 60_000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.name = 'ollama';
  }

  async chat({ system, messages, json = false, temperature = 0.2 }) {
    const body = {
      model: this.model,
      stream: false,
      options: { temperature },
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
      ...(json ? { format: 'json' } : {}),
    };

    const { LlmError, fetchWithTimeout } = require('./provider');
    const started = Date.now();
    let res;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/api/chat`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
        { timeoutMs: this.timeoutMs, label: `Ollama (${this.model})` },
      );
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw new LlmError(`Cannot reach Ollama at ${this.baseUrl}: ${err.message}`);
    }
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const { LlmError } = require('./provider');
      throw new LlmError(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`, { status: res.status });
    }
    const data = await res.json();
    const inputTokens = data.prompt_eval_count ?? 0;
    const outputTokens = data.eval_count ?? 0;
    return {
      text: data.message?.content ?? '',
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      latencyMs,
      model: this.model,
      finishReason: data.done_reason ?? null,
    };
  }
}

module.exports = { OllamaProvider };
