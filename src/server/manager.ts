/**
 * Embed-friendly barrel for the in-process ConversationManager.
 *
 * Used by hosts that want to drive dhee-core without booting the
 * Fastify HTTP/WebSocket server — e.g. the Electron desktop app
 * imports `ConversationManager` and `ConversationEvents` from
 * `dhee-core/manager` directly and wires the events into IPC.
 *
 * IMPORTANT: this barrel must not import anything from `./index.ts`,
 * `./routes.ts`, `./WebSocketHandler.ts`, or any `fastify` /
 * `@fastify/*` package. The whole point is to give hosts a Fastify-
 * free entry. The `embedBarrels.test.ts` source-check enforces this.
 */
export { ConversationManager } from './ConversationManager.js';
export type {
  ConversationManagerConfig,
  ConversationEvents,
} from './ConversationManager.js';
export type {
  SessionState,
  ServerMessage,
  ServerMessageType,
  ClientMessage,
  HistoryData,
  HistoryChatMessage,
  HistoryToolCall,
} from './types.js';
export {
  getSessionHistorySnapshot,
  clearSessionHistory,
} from './sessionPersistence.js';
export { loadDevEnv } from './loadDevEnv.js';
export type { LoadDevEnvResult } from './loadDevEnv.js';
export {
  createProjectInProcess,
  CreateProjectError,
} from './runners/createProjectInProcess.js';
export type {
  CreateProjectInProcessOpts,
  CreateProjectInProcessResult,
} from './runners/createProjectInProcess.js';
export {
  captureAnalyticsEvent,
  configurePostHogRuntime,
  captureDesktopAppFirstStarted,
  captureDesktopAppStarted,
  captureDesktopHeartbeat,
  captureDesktopAppQuit,
  captureDesktopAuthStarted,
  configureAnalytics,
  getAnalyticsDistinctId,
  identifyAnalyticsUser,
  isPostHogEnabled,
  registerPostHogShutdownHandlers,
  resetAnalyticsForTests,
  sanitizeAnalyticsProperties,
  setAnalyticsIdentity,
  setCommonProperties,
  shutdownPostHog,
} from './posthog.js';
export type {
  AnalyticsCaptureOptions,
  AnalyticsEventName,
  AnalyticsIdentity,
} from './posthog.js';

// Custom ComfyUI workflow integration — exposed for hosts (e.g.
// dhee-desktop) that drive workflow CRUD via in-process IPC
// instead of HTTP. The host calls `setUserWorkflowsDir()` at
// startup, then routes its renderer's CRUD requests to these
// helpers. Pi-agent tools call the same helpers, so the chat path
// and the IPC path stay perfectly in sync.
export {
  setUserWorkflowsDir,
  getUserWorkflowsDir,
} from '../services/providers/workflowsRoot.js';
export { refreshWorkflowRegistry } from '../services/comfyui/workflowIntegration.js';
export {
  validateWorkflowFile,
  analyzeWorkflowFile,
  saveWorkflow,
  listWorkflows,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  WorkflowIntegrationError,
} from '../services/comfyui/workflowIntegration.js';
export type {
  ValidateResult,
  ValidateError,
  AnalyzeResult,
  SaveWorkflowOptions,
  SaveWorkflowResult,
  WorkflowSummary,
  WorkflowUpdate,
} from '../services/comfyui/workflowIntegration.js';
export type {
  WorkflowManifest,
  WorkflowPipeline,
  InputRequirement,
  ParameterMapping,
} from '../services/providers/types.js';
