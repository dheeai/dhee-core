/**
 * llmUsageAnalytics — forward per-call LLM usage to PostHog, PER USER,
 * for opted-in cloud accounts only (issue #102 #0 follow-up).
 *
 * Privacy model: dhee-core never decides which account should report usage —
 * only the desktop knows (it owns auth + account state). The desktop calls
 * `enableCloudUsageAnalytics({ userId })` ONLY for an opted-in cloud account,
 * which registers the forwarder as a usage listener. For local / BYO-key
 * accounts the desktop never calls it, so their usage is never sent — it
 * stays in the local JSONL on their machine and nothing more.
 *
 * The event carries ONLY token counts + structural ids (lane, model,
 * node/item/session). It NEVER includes prompt or output CONTENT.
 */
import {
  addUsageListener,
  type LlmUsageRecord,
} from '../core/llm/usageTelemetry.js';
import {
  captureAnalyticsEvent,
  setAnalyticsIdentity,
  type AnalyticsIdentity,
} from './posthog.js';

/** PostHog event name for a single LLM call's usage. */
export const LLM_USAGE_EVENT = 'core_llm_usage';

/**
 * Pure: map a usage record to the PostHog event payload. Token counts and
 * structural ids only — no prompt/output content ever leaves the process.
 * Exported for testing.
 */
export function buildLlmUsageEvent(rec: LlmUsageRecord): {
  event: string;
  properties: Record<string, unknown>;
} {
  return {
    event: LLM_USAGE_EVENT,
    properties: {
      lane: rec.lane,
      model: rec.model,
      ...(rec.nodeId !== undefined ? { node_id: rec.nodeId } : {}),
      ...(rec.itemId !== undefined ? { item_id: rec.itemId } : {}),
      ...(rec.sessionId !== undefined ? { session_id: rec.sessionId } : {}),
      prompt_tokens: rec.promptTokens,
      cached_tokens: rec.cachedTokens,
      completion_tokens: rec.completionTokens,
      total_tokens: rec.totalTokens,
      cached_ratio: rec.cachedRatio,
      ...(rec.costUsd !== undefined ? { cost_usd: rec.costUsd } : {}),
    },
  };
}

/**
 * Forward one usage record to PostHog. No-op when PostHog has no API key
 * (captureAnalyticsEvent already guards that). Uses the globally-set
 * analytics identity for per-user attribution.
 */
export function forwardUsageToPostHog(rec: LlmUsageRecord): void {
  const { event, properties } = buildLlmUsageEvent(rec);
  captureAnalyticsEvent(event, properties, { component: 'dhee-core' });
}

/**
 * Turn on per-user LLM usage analytics for a CLOUD-BILLED account. The
 * desktop calls this ONLY for cloud-billed users (after auth), NEVER for
 * local / BYO-key accounts. Sets the per-user analytics identity and
 * registers the forwarder. Returns an unsubscribe to call on sign-out /
 * account switch (e.g. switching to a local account).
 */
export function enableCloudUsageAnalytics(
  identity: Required<Pick<AnalyticsIdentity, 'userId'>> & AnalyticsIdentity,
): () => void {
  setAnalyticsIdentity(identity);
  return addUsageListener(forwardUsageToPostHog);
}
