import { log } from './logger.js';

export interface RetryOptions {
  maxAttempts?: number;       // default 3
  baseDelayMs?: number;       // default 500
  /** Decide whether an error is worth retrying (default: always). */
  isRetryable?: (err: unknown) => boolean;
  label?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const isRetryable = opts.isRetryable ?? (() => true);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isRetryable(err)) break;
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const delay = Math.random() * backoff;
      log.warn('retrying after error', {
        label: opts.label,
        attempt,
        maxAttempts,
        delayMs: Math.round(delay),
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** True for HTTP 429 and 5xx — the standard "retry this" set for AI/REST APIs. */
export function isRetryableHttpStatus(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500 && status < 600);
}
