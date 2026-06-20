import { describe, it, expect } from 'vitest';
import {
  cleanBody,
  stripSignature,
  removeQuotedReplies,
  stripDisclaimers,
  isAutoReply,
  filterThread,
} from '../src/pipeline/noise-filter.js';
import type { Thread } from '../src/pipeline/thread-reconstructor.js';
import type { RawMessage } from '../src/pipeline/connector.js';
import {
  WITH_SIGNATURE,
  WITH_DISCLAIMER,
  WITH_QUOTED_REPLY,
  OOO_REPLY,
  DASH_SIGNATURE,
  CLEAN_NO_NOISE,
} from './fixtures/emails.js';

describe('noise-filter', () => {
  it('strips a "--" delimited signature block', () => {
    const out = stripSignature(DASH_SIGNATURE);
    expect(out).toContain('CSV button');
    expect(out).not.toContain('Carlos Ruiz');
  });

  it('strips a sign-off style signature', () => {
    const out = stripSignature(WITH_SIGNATURE);
    expect(out).toContain('Reset Password');
    expect(out).not.toContain('jane@acme.example');
  });

  it('removes confidentiality disclaimers', () => {
    const out = stripDisclaimers(WITH_DISCLAIMER);
    expect(out).toContain('clear the cache');
    expect(out).not.toMatch(/CONFIDENTIALITY NOTICE/i);
  });

  it('removes quoted reply chains', () => {
    const out = removeQuotedReplies(WITH_QUOTED_REPLY);
    expect(out).toContain('systemctl restart acme');
    expect(out).not.toContain('keeps crashing after the upgrade');
  });

  it('detects OOO / auto-reply messages via subject text', () => {
    const msg: RawMessage = { author: 'x', body: OOO_REPLY, timestamp: new Date() };
    expect(isAutoReply(msg, {})).toBe(true);
  });

  it('detects auto-reply via the X-Auto-Response-Suppress header signal', () => {
    const msg: RawMessage = { author: 'x', body: 'hello', timestamp: new Date() };
    expect(isAutoReply(msg, { autoResponseSuppress: 'All' })).toBe(true);
  });

  it('leaves clean content essentially intact', () => {
    const out = cleanBody(CLEAN_NO_NOISE);
    expect(out).toContain('two-factor authentication');
    expect(out).toContain('scan the QR code');
  });

  it('drops auto-reply messages from a thread but never empties it', () => {
    const base: Omit<Thread, 'messages'> = {
      externalId: 't1',
      subject: 'Help',
      participants: ['a@x.com'],
      dateRange: { start: new Date(), end: new Date() },
      metadata: {},
    };
    const thread: Thread = {
      ...base,
      messages: [
        { author: 'bot', body: OOO_REPLY, timestamp: new Date() },
        { author: 'jane', body: CLEAN_NO_NOISE, timestamp: new Date() },
      ],
    };
    const cleaned = filterThread(thread);
    expect(cleaned.cleanedContent).toContain('two-factor');
    expect(cleaned.cleanedContent).not.toContain('out of office');
  });
});
