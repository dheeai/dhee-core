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
export {
  getOversight,
  setPiOversight,
  setVLMJudge,
  type OversightState,
} from './server/oversightState.js';

// Per-call LLM usage telemetry (issue #102). Local JSONL sink + summary,
// plus a cloud-billed-only PostHog forwarder the desktop opts into for
// cloud accounts (never for local / BYO-key accounts).
export {
  recordLlmUsage,
  readUsageRecords,
  summarizeUsage,
  usageTelemetryPath,
  isUsageTelemetryEnabled,
  addUsageListener,
  type LlmUsageRecord,
  type LlmUsageInput,
  type UsageSummary,
  type LaneSummary,
  type LlmLane,
} from './core/llm/usageTelemetry.js';
export {
  enableCloudUsageAnalytics,
  forwardUsageToPostHog,
  buildLlmUsageEvent,
  LLM_USAGE_EVENT,
} from './server/llmUsageAnalytics.js';

// Phase 6.5: pi-agent in-process bridge for desktop chat. The desktop
// builds an AgentSession per chat-session via buildPiSession and runs
// each user message through runAgentTurn (shared with the `pnpm drive`
// CLI so agent + chat-driven turns interpret the model's output
// identically).
export {
  buildPiSession,
  buildPiSessionConfig,
  DHEE_SKILL_NAME,
} from './agent/pi/buildSession.js';
export type { BuildPiSessionOptions } from './agent/pi/buildSession.js';
export { runAgentTurn } from './agent/pi/runTurn.js';
export type {
  AgentTurnSession,
  RunAgentTurnOk,
  RunAgentTurnErr,
  RunAgentTurnResult,
  RunAgentTurnOpts,
  ToolCallSummary,
} from './agent/pi/runTurn.js';
