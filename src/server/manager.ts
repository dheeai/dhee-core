/**
 * Thin embed-time barrel kept ALIVE so the Electron desktop can
 * initialise its `dheeCoreManager` and register the IPC bridge.
 *
 * Background: the legacy `ConversationManager` + pi-coding-agent
 * stack was removed in d6f11bd ("full legacy deletion — bundle
 * architecture only"). The desktop's `dheeCoreManager.ts` still
 * dynamic-imports `dhee-core/manager` and constructs a
 * `ConversationManager` solely so it has a started-engine sentinel;
 * the only method it actually calls on the instance is `shutdown()`.
 *
 * Until the desktop's chat layer is rebuilt against the bundle
 * dispatcher, this barrel exposes a no-op `ConversationManager`
 * plus the analytics + dev-env helpers that the desktop pulls in
 * via the same import.
 */

export class ConversationManager {
  constructor(_config?: unknown) {}
  shutdown(): void {}
}

export type ConversationManagerConfig = { llmConfig: unknown };

export {
  captureAnalyticsEvent,
  configureAnalytics,
  configurePostHogRuntime,
  identifyAnalyticsUser,
  isPostHogEnabled,
  setAnalyticsIdentity,
  captureDesktopAppFirstStarted,
  captureDesktopAppStarted,
  captureDesktopHeartbeat,
  captureDesktopAppQuit,
  captureDesktopAuthStarted,
  getAnalyticsDistinctId,
  sanitizeAnalyticsProperties,
  setCommonProperties,
} from './posthog.js';

export { loadDevEnv } from './loadDevEnv.js';
export type { LoadDevEnvResult } from './loadDevEnv.js';

/** Compatibility no-op — real implementation was removed with the
 *  pi-coding-agent stack. Returns null so the desktop falls back to
 *  empty history. */
export function getSessionHistorySnapshot(_sessionId: string): null {
  return null;
}

/** Compatibility no-op — see above. */
export function clearSessionHistory(_sessionId: string): void {}

/** Idempotent no-op until the PostHog shutdown lands in the new
 *  bundle architecture. */
export async function shutdownPostHog(): Promise<void> {}
