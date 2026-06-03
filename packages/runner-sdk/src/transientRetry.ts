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
  const msg = errorMessage(err).toLowerCase();
  return TRANSIENT_MARKERS.some((m) => msg.includes(m));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (
    typeof err === 'number' ||
    typeof err === 'boolean' ||
    typeof err === 'bigint' ||
    typeof err === 'symbol'
  ) {
    return String(err);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

export interface RetryOpts {
  attempts?: number;
  backoffMs?: number[];
  signal?: AbortSignal;
  log?: (msg: string) => void;
  label?: string;
  isTransient?: (err: unknown) => boolean;
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
      if (!classify(err)) throw err;
    }
  }

  const tail = errorMessage(lastErr);
  throw new Error(
    `${label}: transient upstream error after ${attempts} attempts — final: ${tail}`,
  );
}
