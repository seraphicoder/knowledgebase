import type { Thread } from './thread-reconstructor.js';
import type { RawMessage } from './connector.js';

// Source-agnostic noise filtering. It never branches on source type — instead it
// reacts to signals present on the thread (e.g. an auto-response header in
// metadata). Zendesk comments simply arrive cleaner, so less gets stripped.

export interface CleanThread extends Thread {
  /** Noise-filtered plain text, ready for AI processing (M2). */
  cleanedContent: string;
}

const OOO_SUBJECT = /\b(out of office|automatic reply|auto[- ]?reply|away from (the|my) (office|desk))\b/i;

const DISCLAIMER_PATTERNS: RegExp[] = [
  /this (e-?mail|message)( and any attachments)? (is|are|may be) (confidential|privileged)[\s\S]*/i,
  /confidentiality notice[\s\S]*/i,
  /the information (contained )?in this (e-?mail|message)[\s\S]*confidential[\s\S]*/i,
  /if you are not the intended recipient[\s\S]*/i,
  /please consider the environment before printing[\s\S]*/i,
];

export function filterThread(thread: Thread): CleanThread {
  const kept = thread.messages.filter((m) => !isAutoReply(m, thread.metadata));
  const messages = kept.length > 0 ? kept : thread.messages; // never drop everything

  const cleanedContent = messages
    .map((m) => `${m.author}:\n${cleanBody(m.body)}`)
    .join('\n\n---\n\n')
    .trim();

  return { ...thread, cleanedContent };
}

/** Full single-body cleaner: quotes -> signature -> disclaimers -> whitespace. */
export function cleanBody(body: string): string {
  let text = body ?? '';
  text = removeQuotedReplies(text);
  text = stripSignature(text);
  text = stripDisclaimers(text);
  return collapseWhitespace(text);
}

/** Strip an email signature block (RFC 3676 "-- " delimiter or common patterns). */
export function stripSignature(text: string): string {
  const lines = text.split(/\r?\n/);
  // Standard delimiter: a line that is exactly "--" or "-- ".
  const delim = lines.findIndex((l) => /^--\s?$/.test(l));
  if (delim !== -1) return lines.slice(0, delim).join('\n').trimEnd();

  // Heuristic: cut at common sign-off lines if followed by short contact-ish lines.
  const signoff = lines.findIndex((l) =>
    /^\s*(best( regards)?|regards|thanks|thank you|cheers|sincerely|sent from my)\b/i.test(l),
  );
  if (signoff !== -1 && signoff >= lines.length - 8) {
    return lines.slice(0, signoff).join('\n').trimEnd();
  }
  return text;
}

/** Remove quoted reply chains, keeping only the most recent exchange. */
export function removeQuotedReplies(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    // "On <date>, <person> wrote:" attribution line marks the start of a quote.
    if (/^\s*on .+wrote:\s*$/i.test(line)) break;
    // Outlook-style header block.
    if (/^\s*-{2,}\s*original message\s*-{2,}/i.test(line)) break;
    if (/^\s*from:\s.+/i.test(line) && out.length > 0) break;
    // Classic ">" quote prefix.
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

export function stripDisclaimers(text: string): string {
  let result = text;
  for (const pattern of DISCLAIMER_PATTERNS) result = result.replace(pattern, '');
  return result.trim();
}

/** Detect OOO / auto-reply. Uses the header signal when present (IMAP). */
export function isAutoReply(message: RawMessage, metadata: Record<string, unknown>): boolean {
  if (metadata.autoResponseSuppress) return true;
  // Some IMAP messages carry the subject into the body's first line; also guard
  // on body content for safety.
  return OOO_SUBJECT.test((message.body ?? '').slice(0, 200));
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
