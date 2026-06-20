import { describe, it, expect } from 'vitest';
import { buildArticleBody } from '../src/pipeline/kb-publish.js';

describe('buildArticleBody', () => {
  it('renders question and answer as markdown', () => {
    const body = buildArticleBody({
      question: 'How do I fix banding?',
      answer: 'Lower the print speed and re-purge the head.',
      caveats: null,
    });
    expect(body).toContain('**Question**');
    expect(body).toContain('How do I fix banding?');
    expect(body).toContain('**Answer**');
    expect(body).toContain('Lower the print speed');
    expect(body).not.toContain('**Caveats**');
  });

  it('includes caveats only when present', () => {
    const body = buildArticleBody({
      question: 'q',
      answer: 'a',
      caveats: 'Applies to the 3000 series only.',
    });
    expect(body).toContain('**Caveats**');
    expect(body).toContain('3000 series');
  });

  it('falls back to a placeholder for empty fields', () => {
    const body = buildArticleBody({ question: null, answer: '   ', caveats: null });
    expect(body).toContain('_(none)_');
  });
});
