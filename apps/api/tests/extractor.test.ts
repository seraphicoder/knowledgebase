import { describe, it, expect } from 'vitest';
import { parseExtractions, ExtractionParseError } from '../src/pipeline/extractor.js';

describe('extractor JSON parsing (multi-Q&A)', () => {
  it('parses the wrapper object with multiple entries', () => {
    const raw = JSON.stringify({
      extractions: [
        { question: 'Fix banding?', answer: 'Lower print speed.', title: 'Banding', category: 'Print quality', tags: ['banding'], confidence: 0.8, caveats: null },
        { question: 'Tray drainage?', answer: 'Clear the line.', title: 'Drainage', category: 'Maintenance', tags: ['tray'], confidence: 0.7, caveats: 'model X only' },
      ],
    });
    const out = parseExtractions(raw);
    expect(out).toHaveLength(2);
    expect(out[0]!.title).toBe('Banding');
    expect(out[1]!.caveats).toBe('model X only');
  });

  it('accepts a single object (back-compat) as a one-element array', () => {
    const raw = JSON.stringify({
      question: 'How do I reset my password?',
      answer: 'Use Settings > Security > Reset.',
      title: 'Password Reset',
      category: 'Account',
      tags: ['password', 'account'],
      confidence: 0.91,
      caveats: null,
    });
    const out = parseExtractions(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('Password Reset');
    expect(out[0]!.confidence).toBeCloseTo(0.91);
  });

  it('parses a bare array wrapped in markdown fences', () => {
    const raw = '```json\n[{"question":"q","answer":"a","title":"t","category":"c","tags":[],"confidence":0.5,"caveats":"note"}]\n```';
    const out = parseExtractions(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.answer).toBe('a');
    expect(out[0]!.caveats).toBe('note');
  });

  it('returns an empty array when there is no reusable knowledge', () => {
    expect(parseExtractions('{"extractions":[]}')).toEqual([]);
  });

  it('clamps confidence, coerces bad tags, and drops empty entries', () => {
    const raw = JSON.stringify({
      extractions: [
        { question: 'q', answer: 'a', title: 't', category: 'c', tags: ['ok', 3, null], confidence: 5, caveats: '' },
        { question: '', answer: '', title: 'empty', category: 'c', tags: [], confidence: 0.2, caveats: null },
      ],
    });
    const out = parseExtractions(raw);
    expect(out).toHaveLength(1); // empty-content entry dropped
    expect(out[0]!.confidence).toBe(1);
    expect(out[0]!.tags).toEqual(['ok']);
    expect(out[0]!.caveats).toBeNull();
  });

  it('throws ExtractionParseError on unparseable output', () => {
    expect(() => parseExtractions('I could not extract anything useful.')).toThrow(ExtractionParseError);
  });
});
