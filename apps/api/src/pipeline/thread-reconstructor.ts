import type { RawConversation, RawMessage } from './connector.js';

// Groups RawConversations into unified Thread objects. This is the ONLY place
// allowed to be source-aware (the `sourceType` arg). Everything downstream —
// noise filter, store, embedder, extractor — operates on Thread, source-blind.

export interface Thread {
  /** Stable external id for dedup: original message/conversation id. */
  externalId: string;
  subject: string;
  participants: string[];
  messages: RawMessage[];
  dateRange: { start: Date; end: Date };
  metadata: Record<string, unknown>;
}

export function reconstructThreads(
  conversations: RawConversation[],
  sourceType: string,
): Thread[] {
  // Zendesk (and other ticketing sources): each RawConversation is already one
  // complete thread — pass through, just normalize into Thread.
  if (sourceType !== 'imap') {
    return conversations.map(toThread);
  }
  // IMAP: individual emails must be stitched into threads via Message-ID /
  // In-Reply-To / References headers, falling back to normalized subject.
  return groupImapConversations(conversations);
}

function toThread(c: RawConversation): Thread {
  return {
    externalId: c.externalId,
    subject: c.subject,
    participants: c.participants,
    messages: [...c.messages].sort(byTime),
    dateRange: dateRangeOf(c.messages),
    metadata: c.metadata,
  };
}

// ─── IMAP threading ─────────────────────────────────────────

function groupImapConversations(conversations: RawConversation[]): Thread[] {
  const uf = new UnionFind();
  const byMessageId = new Map<string, RawConversation>();

  for (const c of conversations) {
    uf.add(c.externalId);
    const mid = c.messages[0]?.messageId;
    if (mid) byMessageId.set(mid, c);
  }

  // Link by header references first (most reliable).
  for (const c of conversations) {
    const msg = c.messages[0];
    if (!msg) continue;
    const refs = collectRefs(msg, c.metadata);
    for (const ref of refs) {
      const parent = byMessageId.get(ref);
      if (parent) uf.union(c.externalId, parent.externalId);
    }
  }

  // Fallback: link any still-singleton conversations sharing a normalized subject.
  const bySubject = new Map<string, string>(); // normalized subject -> representative externalId
  for (const c of conversations) {
    const key = normalizeSubject(c.subject);
    if (!key) continue;
    const existing = bySubject.get(key);
    if (existing) uf.union(c.externalId, existing);
    else bySubject.set(key, c.externalId);
  }

  // Assemble groups.
  const groups = new Map<string, RawConversation[]>();
  for (const c of conversations) {
    const root = uf.find(c.externalId);
    const arr = groups.get(root) ?? [];
    arr.push(c);
    groups.set(root, arr);
  }

  const threads: Thread[] = [];
  for (const group of groups.values()) {
    const messages = group.flatMap((c) => c.messages).sort(byTime);
    const earliest = group.slice().sort((a, b) => byTime(a.messages[0]!, b.messages[0]!))[0]!;
    threads.push({
      externalId: earliest.externalId, // earliest message id anchors the thread
      subject: earliest.subject,
      participants: [...new Set(group.flatMap((c) => c.participants))],
      messages,
      dateRange: dateRangeOf(messages),
      metadata: mergeMetadata(group),
    });
  }
  return threads;
}

function collectRefs(msg: RawMessage, metadata: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  if (msg.inReplyTo) refs.add(msg.inReplyTo);
  const raw = metadata.references;
  if (typeof raw === 'string') for (const r of raw.split(/\s+/)) if (r) refs.add(r);
  else if (Array.isArray(raw)) for (const r of raw) if (typeof r === 'string') refs.add(r);
  return [...refs];
}

export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|fwd|fw|aw|wg)\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
}

function mergeMetadata(group: RawConversation[]): Record<string, unknown> {
  return { messageCount: group.length, ...group[0]?.metadata };
}

function byTime(a: RawMessage, b: RawMessage): number {
  return a.timestamp.getTime() - b.timestamp.getTime();
}

function dateRangeOf(messages: RawMessage[]): { start: Date; end: Date } {
  const times = messages.map((m) => m.timestamp.getTime());
  const start = times.length ? Math.min(...times) : Date.now();
  const end = times.length ? Math.max(...times) : Date.now();
  return { start: new Date(start), end: new Date(end) };
}

// ─── Union-Find ─────────────────────────────────────────────

class UnionFind {
  private parent = new Map<string, string>();

  add(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }

  find(x: string): string {
    this.add(x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression.
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}
