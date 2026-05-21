/**
 * One-shot retry wrapper for LLM calls that return empty content.
 *
 * Bug 13 (Ruby V3 regen 2026-05-20): the executor caught
 * shot_motion_directive:scene_4_shot_10's 0-char response, marked the node
 * failed, and instructed the USER to invalidate-and-retry. That's the right
 * floor (don't write 0 bytes to disk), but the actual underlying class of
 * failure — model-API hiccup, rate-limit recovery, transient content-policy
 * false positive — is recoverable by simply asking the same model again.
 *
 * Pulled out into a pure helper so it can be unit-tested without spinning
 * up the executor or a real LLMClient.
 */

export interface RetryOnEmptyOptions {
  /** Optional logger — called with one-line messages when retry fires. */
  log?: (message: string) => void;
  /** Optional UI hook — invoked before the retry attempt. */
  onRetry?: () => void;
}

/**
 * Call `generate` once. If the result trims to 0 chars, call it ONE more
 * time and return that result (empty or not). The empty-content guard
 * downstream will hard-fail if both attempts come back empty.
 */
export async function retryOnEmptyLLMResponse(
  generate: () => Promise<string>,
  options: RetryOnEmptyOptions = {},
): Promise<string> {
  const first = await generate();
  if (first.trim().length > 0) return first;

  options.log?.('[empty-response-retry] Empty LLM response — retrying once');
  options.onRetry?.();
  return generate();
}
