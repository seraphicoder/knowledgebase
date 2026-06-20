import { randomUUID } from 'node:crypto';

// Minimal in-memory Supabase stand-in for tests. It actually applies eq/in
// predicates to seeded rows, so it can faithfully test the approval gate:
// a SELECT filtered by approval_status='approved' must NOT return staged rows,
// and UPDATEs keyed by id can only touch rows the gate query surfaced.

type Row = Record<string, unknown>;
type Predicate = { col: string; vals: unknown[] };
type RpcHandler = (args: Record<string, unknown>) => { data: unknown; error: null } | { data: null; error: { message: string } };

export class FakeSupabase {
  readonly tables = new Map<string, Row[]>();
  private rpcs = new Map<string, RpcHandler>();

  seed(table: string, rows: Row[]): void {
    this.tables.set(table, rows.map((r) => ({ ...r })));
  }
  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }
  registerRpc(name: string, handler: RpcHandler): void {
    this.rpcs.set(name, handler);
  }

  from(table: string): FakeQuery {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return new FakeQuery(this.tables.get(table)!);
  }

  rpc(name: string, args: Record<string, unknown>) {
    const handler = this.rpcs.get(name);
    const result = handler ? handler(args) : { data: [], error: null };
    return Promise.resolve(result);
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: null; count: number | null }> {
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' | null = null;
  private predicates: Predicate[] = [];
  private patch: Row = {};
  private writeRows: Row[] = [];
  private conflictCols: string[] = [];
  private ignoreDuplicates = false;
  private isSingle = false;

  constructor(private store: Row[]) {}

  select(_cols?: string, _opts?: { count?: string }): this {
    this.op ??= 'select';
    return this;
  }
  insert(rows: Row | Row[]): this {
    this.op = 'insert';
    this.writeRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  update(patch: Row): this {
    this.op = 'update';
    this.patch = patch;
    return this;
  }
  upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.op = 'upsert';
    this.writeRows = Array.isArray(rows) ? rows : [rows];
    this.conflictCols = opts?.onConflict?.split(',').map((s) => s.trim()) ?? [];
    this.ignoreDuplicates = opts?.ignoreDuplicates ?? false;
    return this;
  }
  delete(): this {
    this.op = 'delete';
    return this;
  }
  eq(col: string, val: unknown): this {
    this.predicates.push({ col, vals: [val] });
    return this;
  }
  in(col: string, vals: unknown[]): this {
    this.predicates.push({ col, vals });
    return this;
  }
  // No-op chain helpers (not exercised by the predicate logic in these tests).
  gte(): this { return this; }
  lte(): this { return this; }
  ilike(): this { return this; }
  order(): this { return this; }
  range(): this { return this; }
  single(): this {
    this.isSingle = true;
    return this;
  }

  private matches(row: Row): boolean {
    return this.predicates.every((p) => p.vals.includes(row[p.col]));
  }

  private resolve(): { data: unknown; error: null; count: number | null } {
    let data: unknown = null;
    if (this.op === 'select') {
      const matched = this.store.filter((r) => this.matches(r));
      data = this.isSingle ? (matched[0] ?? null) : matched;
      return { data, error: null, count: matched.length };
    }
    if (this.op === 'update') {
      const matched = this.store.filter((r) => this.matches(r));
      for (const row of matched) Object.assign(row, this.patch);
      data = matched.map((r) => ({ ...r }));
      return { data, error: null, count: matched.length };
    }
    if (this.op === 'insert' || this.op === 'upsert') {
      const inserted: Row[] = [];
      for (const r of this.writeRows) {
        if (this.op === 'upsert' && this.ignoreDuplicates && this.conflictCols.length) {
          const dup = this.store.some((e) => this.conflictCols.every((c) => e[c] === r[c]));
          if (dup) continue;
        }
        const withId = { id: r.id ?? randomUUID(), ...r };
        this.store.push(withId);
        inserted.push(withId);
      }
      data = this.isSingle ? (inserted[0] ?? null) : inserted;
      return { data, error: null, count: inserted.length };
    }
    if (this.op === 'delete') {
      const remaining = this.store.filter((r) => !this.matches(r));
      const removed = this.store.length - remaining.length;
      this.store.splice(0, this.store.length, ...remaining);
      return { data: null, error: null, count: removed };
    }
    return { data: null, error: null, count: null };
  }

  then<TResult1 = { data: unknown; error: null; count: number | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null; count: number | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    try {
      return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
    } catch (err) {
      return Promise.reject(err).then(onfulfilled, onrejected) as PromiseLike<TResult2>;
    }
  }
}
