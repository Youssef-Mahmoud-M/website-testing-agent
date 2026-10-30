import { summarise } from './agent.service';
import { MetricRecord } from './agent-bridge';

const metric = (over: Partial<MetricRecord>): MetricRecord => ({
  id: Math.random().toString(36),
  at: new Date().toISOString(),
  phase: 'chat',
  label: '',
  url: null,
  provider: 'mock',
  model: 'mock-1',
  latencyMs: 100,
  llmLatencyMs: 80,
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  ...over,
});

describe('summarise', () => {
  it('returns zeros for no metrics', () => {
    const s = summarise([]);
    expect(s.calls).toBe(0);
    expect(s.avgLatencyMs).toBe(0);
    expect(s.byPhase).toEqual([]);
  });

  it('aggregates per phase and per page', () => {
    const s = summarise([
      metric({ phase: 'explore', url: 'https://a.test/', latencyMs: 1000, totalTokens: 100 }),
      metric({ phase: 'chat', url: 'https://a.test/', latencyMs: 500, totalTokens: 50 }),
      metric({ phase: 'chat', url: null, latencyMs: 300, totalTokens: 30 }),
    ]);
    expect(s.calls).toBe(3);
    expect(s.avgLatencyMs).toBe(600);
    expect(s.totalTokens).toBe(180);
    expect(s.byPhase).toEqual([
      { key: 'explore', calls: 1, avgLatencyMs: 1000, totalTokens: 100 },
      { key: 'chat', calls: 2, avgLatencyMs: 400, totalTokens: 80 },
    ]);
    expect(s.byPage).toEqual([{ key: 'https://a.test/', calls: 2, avgLatencyMs: 750, totalTokens: 150 }]);
  });
});
