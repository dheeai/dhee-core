// kshana-core public entry point (bundle architecture only).
export * from './dag/walker.js';
export * from './dag/schema.js';
export * from './dag/bundleSource.js';
export {
  RunnerRegistry,
  getGlobalRegistry,
  type RunnerManifest,
} from './dag/runners/registry.js';

// Phase 6.4: embed-host helpers (formerly re-exported via the
// now-defunct `./manager` barrel). Kshana-desktop imports these
// directly from `dhee-core` so it no longer needs the dead
// ConversationManager-flavored entry point.
export {
  captureAnalyticsEvent,
  captureDesktopAppFirstStarted,
  captureDesktopAppQuit,
  captureDesktopAppStarted,
  captureDesktopAuthStarted,
  captureDesktopHeartbeat,
  configureAnalytics,
  configurePostHogRuntime,
  getAnalyticsDistinctId,
  identifyAnalyticsUser,
  isPostHogEnabled,
  sanitizeAnalyticsProperties,
  setAnalyticsIdentity,
  setCommonProperties,
} from './server/posthog.js';
export { loadDevEnv } from './server/loadDevEnv.js';
export type { LoadDevEnvResult } from './server/loadDevEnv.js';
