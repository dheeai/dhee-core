/**
 * Wire an AbortSignal to a stop function (typically ExecutorAgent.stop()).
 *
 *   - Signal undefined → no-op, returns a noop cleanup.
 *   - Signal already aborted → call stopFn() immediately, return noop cleanup.
 *   - Otherwise → register a 'once' listener that calls stopFn() on abort,
 *     return a cleanup that removes the listener.
 *
 * Cleanup is idempotent — calling it twice is safe. Used by runExecutor
 * to ensure listener registration doesn't leak past a finished run.
 */
export function linkAbortSignalToAgent(
  signal: AbortSignal | undefined,
  stopFn: (reason?: 'user' | 'shutdown') => void,
): () => void {
  if (!signal) return () => {};

  // Extract the abort origin from signal.reason, if the controller called
  // `.abort('shutdown')` or `.abort('user')`. Anything else (including
  // unset / DOMException) defaults to 'user' — that's the conservative
  // default for backward compatibility with the many callers that simply
  // fire abortController.abort() with no payload.
  const extractReason = (s: AbortSignal): 'user' | 'shutdown' => {
    const r = (s as AbortSignal & { reason?: unknown }).reason;
    if (r === 'shutdown') return 'shutdown';
    if (typeof r === 'string' && r.toLowerCase().includes('shutdown')) return 'shutdown';
    return 'user';
  };

  if (signal.aborted) {
    stopFn(extractReason(signal));
    return () => {};
  }
  let removed = false;
  const listener = () => stopFn(extractReason(signal));
  signal.addEventListener('abort', listener, { once: true });
  return () => {
    if (removed) return;
    removed = true;
    signal.removeEventListener('abort', listener);
  };
}
