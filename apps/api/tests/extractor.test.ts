import { describe, it, expect } from 'vitest';
import { parseExtraction, ExtractionParseError } from '../src/pipeline/extractor.js';

describe('extractor JSON parsing', () => {
  it('parses clean JSON output', () => {
    const raw = JSON.stringify({
      question: 'How do I reset my password?',
      answer: 'Use Settings > Security > Reset.',
      title: 'Password Reset',
      category: 'Account',
      tags: ['password', 'account'],
      confidence: 0.91,
      caveats: null,
    });
    const out = parseExtraction(raw);
    expect(out.title).toBe('Password Reset');
    expect(out.tags).toEqual(['password', 'account']);
    expect(out.confidence).toBeCloseTo(0.91);
    expect(out.caveats).toBeNull();
  });

  it('parses JSON wrapped in markdown fences', () => {
    const raw = '```json\n{"question":"q","answer":"a","title":"t","category":"c","tags":[],"confidence":0.5,"caveats":"note"}\n```';
    const out = parseExtraction(raw);
    expect(out.answer).toBe('a');
    expect(out.caveats).toBe('note');
  });

  it('clamps out-of-range confidence and coerces bad tags', () => {
    const raw = '{"question":"q","answer":"a","title":"t","category":"c","tags":["ok",3,null],"confidence":5,"caveats":""}';
    const out = parseExtraction(raw);
    expect(out.confidence).toBe(1);
    expect(out.tags).toEqual(['ok']);
    expect(out.caveats).toBeNull(); // empty string normalized to null
  });

  it('throws ExtractionParseError on unparseable output', () => {
    expect(() => parseExtraction('I could not extract anything useful.')).toThrow(ExtractionParseError);
  });
});
