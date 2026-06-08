/**
 * Retry helper for transient upstream errors on the Comfy tunnel.
 *
 * Why: the user's local Comfy sits behind a zrok tunnel; the tunnel
 * intermittently returns 502/504 Bad Gateway / Gateway Time-out or
 * drops the underlying socket (ECONNRESET, fetch failed). One such
 * blip used to cascade to:
 *
 *   - the runner returning `ok:false` with the raw HTTP error string
 *   - the agent reading that string, deciding "ComfyUI endpoint is
 *     down," and parking — *even though Comfy itself was fine*.
 *
 * Wrapping every upload / queue / download call in this helper turns
 * one tunnel blip into a 1.5s pause and a retry. After N attempts the
 * helper throws with a message that explicitly names the retry budget
 * — distinguishable from "actually down."
 *
 * Permanent failures (4xx other than 502/504, HTTP 401, malformed
 * workflow, missing node) are NOT retried — they bubble through after
 * the first attempt so the agent gets actionable feedback fast.
 */

const DEFAULT_BACKOFF_MS = [0, 1500, 4000];

const TRANSIENT_MARKERS = [
  '502',
  '503',
  '504',
  'bad gateway',
  'gateway time-out',
  'gateway timeout',
  'econnreset',
  'econnaborted',
  'etimedout',
  'enetunreach',
  'socket hang up',
  'socket disconnected',
  'fetch failed',
  'network error',
];

export function isTransientError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return TRANSIENT_MARKERS.some((m) => msg.includes(m));
}

export interface RetryOpts {
  /** Total attempts including the first one. Default 3. */
  attempts?: number;
  /** Backoff per attempt index in ms; the 0th entry is the delay
   *  BEFORE the first retry (so attempt 0 is immediate). Default
   *  `[0, 1500, 4000]`. */
  backoffMs?: number[];
  /** Optional cancellation. Aborted between attempts ⇒ throws. */
  signal?: AbortSignal;
  /** Optional logger for the runner's own logs. */
  log?: (msg: string) => void;
  /** Human label for the operation; appears in logs + final error message. */
  label?: string;
  /** Override the classifier for tests. */
  isTransient?: (err: unknown) => boolean;
  /** Override the delay function (tests inject a fake). */
  sleep?: (ms: number) => Promise<void>;
}

export async function retryTransient<T>(
  op: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const classify = opts.isTransient ?? isTransientError;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const label = opts.label ?? 'op';

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      if (opts.signal?.aborted) {
        throw new Error(`${label}: aborted during retry backoff after ${i} attempt(s)`);
      }
      const delay = backoff[i] ?? backoff[backoff.length - 1] ?? 4000;
      opts.log?.(`${label}: transient error, retrying in ${delay}ms (attempt ${i + 1}/${attempts})`);
      await sleep(delay);
    }
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!classify(err)) {
        // Permanent — bubble up immediately, don't burn the budget.
        throw err;
      }
    }
  }
  const tail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `${label}: transient upstream error after ${attempts} attempts — final: ${tail}`,
  );
}
