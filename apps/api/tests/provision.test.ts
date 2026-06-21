import { describe, it, expect } from 'vitest';
import { generateTempPassword } from '../src/lib/provision.js';

describe('generateTempPassword', () => {
  it('returns a URL-safe string long enough for Supabase Auth', () => {
    const pw = generateTempPassword();
    expect(pw.length).toBeGreaterThanOrEqual(16);
    expect(pw).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet, no padding
  });

  it('is unique across calls', () => {
    const set = new Set(Array.from({ length: 100 }, () => generateTempPassword()));
    expect(set.size).toBe(100);
  });
});
