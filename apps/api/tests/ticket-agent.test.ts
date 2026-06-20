import { describe, it, expect } from 'vitest';
import { composeConfidence } from '../src/pipeline/ticket-agent.js';

describe('composeConfidence', () => {
  it('blends model confidence with retrieval strength', () => {
    // Strong coverage: high claude conf + high similarity.
    const s = composeConfidence(90, [0.9, 0.85], false);
    expect(s).toBeGreaterThan(80);
    expect(s).toBeLessThanOrEqual(100);
  });

  it('caps low when the best match is weak (<0.60)', () => {
    // Even a cocky model gets capped if the KB barely matches.
    const s = composeConfidence(95, [0.4, 0.3], false);
    expect(s).toBeLessThanOrEqual(40);
  });

  it('gives a bonus when a verified pair backs it', () => {
    const without = composeConfidence(70, [0.8], false);
    const withVerified = composeConfidence(70, [0.8], true);
    expect(withVerified).toBeGreaterThan(without);
  });

  it('handles no retrieved context (zero similarity)', () => {
    const s = composeConfidence(80, [], false);
    expect(s).toBeLessThanOrEqual(40); // best match 0 -> capped
  });
});
