import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { PostHog } from 'posthog-node';

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const MAX_ERROR_MESSAGE_LENGTH = 500;
const MAX_PROPERTY_STRING_LENGTH = 1000;
const MAX_ARRAY_ITEMS = 25;
const MAX_OBJECT_DEPTH = 4;
const DEVICE_ID_DIR = '.dhee';
const DEVICE_ID_FILE = 'device-id';
const SENSITIVE_PROPERTY_PATTERN =
  /(api[_-]?key|token|secret|password|authorization|credential|bearer)/i;

let posthogClient: PostHog | null | undefined;
let shutdownHandlersRegistered = false;
let cachedDeviceId: string | undefined;

// posthog-node's @posthog/core hardcodes `console.error('Error while flushing PostHog', err)`
// in its background flush path with no opt-out. When us.i.posthog.com is unreachable
// (firewall, captive portal, flaky network) this floods stdout with multi-frame stack traces
// every flush interval. We install a one-shot console.error filter that drops only those
// PostHog flush messages and emits at most one throttled summary line per minute.
const POSTHOG_FLUSH_LOG_PREFIX = 'Error while flushing PostHog';
const POSTHOG_NETWORK_ERROR_NAME = 'PostHogFetchNetworkError';
const POSTHOG_QUIET_SUMMARY_INTERVAL_MS = 60_000;
let originalConsoleError: typeof console.error | null = null;
let suppressedFlushErrorCount = 0;
let lastFlushErrorSummaryAt = 0;

export type AnalyticsEventName =
  | 'desktop_app_first_started'
  | 'desktop_app_started'
  | 'desktop_heartbeat'
  | 'desktop_app_quit'
  | 'website_download_clicked'
  | 'desktop_auth_started'
  | 'desktop_token_issued'
  | 'project_created'
  | 'core_session_started'
  | 'core_session_ended'
  | 'core_tool_call_started'
  | 'core_tool_call_completed'
  | 'core_task_started'
  | 'core_task_completed'
  | 'core_task_failed'
  | 'error_occurred'
  | 'final_video_created'
  | (string & {});

interface CommonProperties {
  app_version: string;
  platform: 'desktop' | 'server' | 'website';
  os: 'macos' | 'linux' | 'win32' | 'unknown';
}

export interface AnalyticsIdentity {
  distinctId?: string;
  installId?: string;
  userId?: string;
}

export interface AnalyticsCaptureOptions {
  timestamp?: string | Date;
  identity?: AnalyticsIdentity;
  component?: string;
}

export interface PostHogRuntimeConfig {
  apiKey?: string;
  host?: string;
  analyticsSalt?: string;
}

let commonProperties: CommonProperties = {
  app_version: '0.0.0',
  platform: 'server',
  os: normalizeOs(os.platform()),
};

let analyticsIdentity: AnalyticsIdentity = {};
let extraCommonProperties: Record<string, unknown> = {};

export interface ToolCallStartedPayload {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  agentName: string;
  args: Record<string, unknown>;
  startedAt?: string;
  projectDir?: string;
  workflowName?: string;
}

export interface ToolCallCompletedPayload {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  agentName: string;
  isError: boolean;
  durationMs?: number | null;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  projectDir?: string;
  sqliteRowId?: number;
  source?: 'live' | 'backfill';
  workflowName?: string;
}

export interface WorkflowEventPayload {
  sessionId: string;
  workflowName: string;
  durationMs?: number;
  templateId?: string;
  taskKind?: string;
  taskId?: string;
}

export interface WorkflowFailedPayload extends WorkflowEventPayload {
  errorType: string;
}

export interface ErrorOccurredPayload {
  sessionId: string;
  errorType: string;
  toolName?: string;
  workflowName?: string;
  messageHash?: string;
}

export interface FinalVideoCreatedPayload {
  sessionId?: string;
  durationSeconds?: number;
  fileSizeBytes?: number;
  versionNumber?: number;
  templateId?: string;
  style?: string;
  segmentCount?: number;
  projectDir?: string;
  assemblyPathType: 'executor_final_assembly' | 'timeline_backend' | 'timeline_desktop';
}

interface ArgSummary {
  argCount: number;
  argKeys: string[];
  argsJsonLength: number;
}

function normalizeOs(value: string): CommonProperties['os'] {
  if (value === 'darwin') return 'macos';
  if (value === 'linux') return 'linux';
  if (value === 'win32') return 'win32';
  return 'unknown';
}

function getPostHogApiKey(): string | undefined {
  const key = process.env['POSTHOG_API_KEY']?.trim();
  return key && key.length > 0 ? key : undefined;
}

function getPostHogHost(): string {
  const host = process.env['POSTHOG_HOST']?.trim();
  return host && host.length > 0 ? host : DEFAULT_POSTHOG_HOST;
}

export function configurePostHogRuntime(config: PostHogRuntimeConfig): void {
  const apiKey = config.apiKey?.trim();
  const host = config.host?.trim();
  const analyticsSalt = config.analyticsSalt?.trim();

  if (apiKey && !process.env['POSTHOG_API_KEY']) {
    process.env['POSTHOG_API_KEY'] = apiKey;
  }
  if (host && !process.env['POSTHOG_HOST']) {
    process.env['POSTHOG_HOST'] = host;
  }
  if (analyticsSalt && !process.env['ANALYTICS_SALT']) {
    process.env['ANALYTICS_SALT'] = analyticsSalt;
  }

  if (posthogClient === null && getPostHogApiKey()) {
    posthogClient = undefined;
  }
}

function isPostHogFlushNoise(args: unknown[]): boolean {
  for (const arg of args) {
    if (typeof arg === 'string' && arg.startsWith(POSTHOG_FLUSH_LOG_PREFIX)) {
      return true;
    }
    if (arg && typeof arg === 'object') {
      const name = (arg as { name?: unknown }).name;
      if (typeof name === 'string' && name === POSTHOG_NETWORK_ERROR_NAME) {
        return true;
      }
      const message = (arg as { message?: unknown }).message;
      if (
        typeof message === 'string' &&
        (message.includes('Network error while fetching PostHog') ||
          message.startsWith(POSTHOG_FLUSH_LOG_PREFIX))
      ) {
        return true;
      }
    }
  }
  return false;
}

function installPostHogConsoleFilter(): void {
  if (originalConsoleError) {
    return;
  }
  const original = console.error.bind(console);
  originalConsoleError = original;
  console.error = (...args: unknown[]) => {
    if (isPostHogFlushNoise(args)) {
      suppressedFlushErrorCount += 1;
      const now = Date.now();
      if (now - lastFlushErrorSummaryAt >= POSTHOG_QUIET_SUMMARY_INTERVAL_MS) {
        lastFlushErrorSummaryAt = now;
        const count = suppressedFlushErrorCount;
        suppressedFlushErrorCount = 0;
        console.warn(
          `[PostHog] suppressed ${count} flush error log${count === 1 ? '' : 's'} ` +
            `in the last ${Math.round(POSTHOG_QUIET_SUMMARY_INTERVAL_MS / 1000)}s ` +
            `(host=${getPostHogHost()}). Telemetry will retry automatically.`,
        );
      }
      return;
    }
    original(...(args as Parameters<typeof console.error>));
  };
}

function uninstallPostHogConsoleFilter(): void {
  if (!originalConsoleError) {
    return;
  }
  console.error = originalConsoleError;
  originalConsoleError = null;
  suppressedFlushErrorCount = 0;
  lastFlushErrorSummaryAt = 0;
}

function getPostHogClient(): PostHog | null {
  if (posthogClient !== undefined) {
    return posthogClient;
  }

  const apiKey = getPostHogApiKey();
  if (!apiKey) {
    posthogClient = null;
    return posthogClient;
  }

  installPostHogConsoleFilter();

  posthogClient = new PostHog(apiKey, {
    host: getPostHogHost(),
  });
  return posthogClient;
}

function getOrCreateDeviceId(): string {
  if (cachedDeviceId) {
    return cachedDeviceId;
  }

  try {
    const deviceDir = path.join(os.homedir(), DEVICE_ID_DIR);
    const deviceFilePath = path.join(deviceDir, DEVICE_ID_FILE);

    if (fs.existsSync(deviceFilePath)) {
      const existing = fs.readFileSync(deviceFilePath, 'utf8').trim();
      if (existing) {
        cachedDeviceId = existing;
        return cachedDeviceId;
      }
    }

    if (!fs.existsSync(deviceDir)) {
      fs.mkdirSync(deviceDir, { recursive: true });
    }

    const newId = randomUUID();
    fs.writeFileSync(deviceFilePath, `${newId}\n`, { encoding: 'utf8' });
    cachedDeviceId = newId;
    return cachedDeviceId;
  } catch {
    cachedDeviceId = `ephemeral_${randomUUID()}`;
    return cachedDeviceId;
  }
}

function resolveIdentity(input?: AnalyticsIdentity): Required<Pick<AnalyticsIdentity, 'distinctId'>> & AnalyticsIdentity {
  const identity = {
    ...analyticsIdentity,
    ...(input ?? {}),
  };
  const distinctId =
    identity.distinctId ??
    (identity.userId ? `user:${identity.userId}` : undefined) ??
    (identity.installId ? `install:${identity.installId}` : undefined) ??
    `install:${getOrCreateDeviceId()}`;

  return {
    ...identity,
    distinctId,
  };
}

function summarizeArgs(args: Record<string, unknown>): ArgSummary {
  const argKeys = Object.keys(args).slice(0, 20);
  let argsJsonLength = 0;
  try {
    argsJsonLength = JSON.stringify(args).length;
  } catch {
    argsJsonLength = 0;
  }

  return {
    argCount: Object.keys(args).length,
    argKeys,
    argsJsonLength,
  };
}

function hashProjectDir(projectDir?: string): string | undefined {
  if (!projectDir) {
    return undefined;
  }

  const salt = process.env['ANALYTICS_SALT']?.trim() ?? '';
  return createHash('sha256').update(`${salt}:${projectDir}`).digest('hex').slice(0, 16);
}

function sanitizeErrorMessage(message?: string): string | undefined {
  if (!message) {
    return undefined;
  }
  const normalized = message.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function sanitizeAnalyticsValue(value: unknown, depth: number): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'string') {
    return value.length > MAX_PROPERTY_STRING_LENGTH
      ? value.slice(0, MAX_PROPERTY_STRING_LENGTH)
      : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_OBJECT_DEPTH) return undefined;
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeAnalyticsValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }

  if (typeof value === 'object') {
    if (depth >= MAX_OBJECT_DEPTH) return undefined;
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_PROPERTY_PATTERN.test(key)) {
        continue;
      }
      const sanitized = sanitizeAnalyticsValue(nested, depth + 1);
      if (sanitized !== undefined) {
        result[key] = sanitized;
      }
    }
    return result;
  }

  return undefined;
}

export function sanitizeAnalyticsProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (SENSITIVE_PROPERTY_PATTERN.test(key)) {
      continue;
    }
    const sanitized = sanitizeAnalyticsValue(value, 0);
    if (sanitized !== undefined) {
      result[key] = sanitized;
    }
  }
  return result;
}

function toDate(input?: string | Date): Date | undefined {
  if (!input) {
    return undefined;
  }
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? undefined : input;
  }
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function configureAnalytics(input: {
  platform?: CommonProperties['platform'];
  appVersion?: string;
  identity?: AnalyticsIdentity;
  properties?: Record<string, unknown>;
}): void {
  if (input.platform || input.appVersion) {
    setCommonProperties(
      input.platform ?? commonProperties.platform,
      input.appVersion ?? commonProperties.app_version,
    );
  }
  if (input.identity) {
    setAnalyticsIdentity(input.identity);
  }
  if (input.properties) {
    extraCommonProperties = sanitizeAnalyticsProperties(input.properties);
  }
}

export function setCommonProperties(
  platform: CommonProperties['platform'],
  appVersion: string,
): void {
  commonProperties = {
    app_version: appVersion,
    platform,
    os: normalizeOs(os.platform()),
  };
}

export function setAnalyticsIdentity(identity: AnalyticsIdentity): void {
  analyticsIdentity = { ...identity };
}

export function getAnalyticsDistinctId(identity?: AnalyticsIdentity): string {
  return resolveIdentity(identity).distinctId;
}

export function identifyAnalyticsUser(
  identity: Required<Pick<AnalyticsIdentity, 'userId'>> & AnalyticsIdentity,
  properties: Record<string, unknown> = {},
): void {
  const client = getPostHogClient();
  const resolved = resolveIdentity(identity);
  setAnalyticsIdentity(identity);

  if (!client) {
    return;
  }

  try {
    client.identify({
      distinctId: `user:${identity.userId}`,
      properties: sanitizeAnalyticsProperties({
        user_id: identity.userId,
        install_id: resolved.installId,
        $anon_distinct_id: resolved.installId ? `install:${resolved.installId}` : undefined,
        ...properties,
      }),
    });
  } catch {
    // Analytics must never affect runtime behavior.
  }
}

export function captureAnalyticsEvent(
  event: AnalyticsEventName,
  properties: Record<string, unknown> = {},
  options: AnalyticsCaptureOptions = {},
): void {
  const client = getPostHogClient();
  if (!client) {
    return;
  }

  const identity = resolveIdentity(options.identity);

  try {
    client.capture({
      distinctId: identity.distinctId,
      event,
      timestamp: toDate(options.timestamp),
      disableGeoip: commonProperties.platform !== 'desktop',
      properties: sanitizeAnalyticsProperties({
        ...commonProperties,
        ...extraCommonProperties,
        app_component: options.component ?? 'dhee-core',
        install_id: identity.installId,
        user_id: identity.userId,
        ...properties,
      }),
    });
  } catch {
    // Analytics must never affect runtime behavior.
  }
}

export function isPostHogEnabled(): boolean {
  return !!getPostHogApiKey();
}

export function hashAnalyticsMessage(message?: string): string | undefined {
  const sanitized = sanitizeErrorMessage(message);
  if (!sanitized) {
    return undefined;
  }
  return createHash('sha256').update(sanitized).digest('hex').slice(0, 8);
}

export function captureAppStarted(platform: CommonProperties['platform']): void {
  captureAnalyticsEvent('app_started', {
    platform,
  }, {
    component: platform === 'desktop' ? 'dhee-desktop' : 'dhee-core',
  });
}

export function captureDesktopAppFirstStarted(): void {
  captureAnalyticsEvent('desktop_app_first_started', {}, { component: 'dhee-desktop' });
}

export function captureDesktopAppStarted(properties: Record<string, unknown> = {}): void {
  captureAnalyticsEvent('desktop_app_started', properties, { component: 'dhee-desktop' });
}

export function captureDesktopHeartbeat(properties: Record<string, unknown> = {}): void {
  captureAnalyticsEvent('desktop_heartbeat', properties, { component: 'dhee-desktop' });
}

export function captureDesktopAppQuit(properties: Record<string, unknown> = {}): void {
  captureAnalyticsEvent('desktop_app_quit', properties, { component: 'dhee-desktop' });
}

export function captureDesktopAuthStarted(properties: Record<string, unknown> = {}): void {
  captureAnalyticsEvent('desktop_auth_started', properties, { component: 'dhee-desktop' });
}

export function captureSessionStarted(sessionId: string, startedAt?: string): void {
  const startIso = startedAt ?? new Date().toISOString();
  captureAnalyticsEvent('core_session_started', {
    core_session_id: sessionId,
    session_id: sessionId,
    '$start_timestamp': startIso,
    session_started_at: startIso,
  }, {
    timestamp: startIso,
  });
}

export function captureSessionEnded(
  sessionId: string,
  durationMs?: number,
  startedAt?: string,
  interactionCount?: number,
): void {
  const endIso = new Date().toISOString();
  const sessionDurationSeconds = typeof durationMs === 'number'
    ? Math.max(0, Math.round(durationMs / 1000))
    : undefined;
  const bounce = typeof interactionCount === 'number' ? interactionCount <= 1 : undefined;

  captureAnalyticsEvent('core_session_ended', {
    core_session_id: sessionId,
    session_id: sessionId,
    duration_ms: durationMs,
    '$end_timestamp': endIso,
    '$session_duration': sessionDurationSeconds,
    '$is_bounce': bounce,
    session_started_at: startedAt,
    session_ended_at: endIso,
    session_interaction_count: interactionCount,
  }, {
    timestamp: endIso,
  });
}

export function captureWorkflowStarted(payload: WorkflowEventPayload): void {
  captureAnalyticsEvent('core_task_started', {
    core_session_id: payload.sessionId,
    session_id: payload.sessionId,
    workflow_name: payload.workflowName,
    template_id: payload.templateId,
    task_kind: payload.taskKind,
    task_id: payload.taskId,
  });
}

export function captureWorkflowCompleted(payload: WorkflowEventPayload): void {
  captureAnalyticsEvent('core_task_completed', {
    core_session_id: payload.sessionId,
    session_id: payload.sessionId,
    workflow_name: payload.workflowName,
    template_id: payload.templateId,
    task_kind: payload.taskKind,
    task_id: payload.taskId,
    duration_ms: payload.durationMs,
    success: true,
  });
}

export function captureWorkflowFailed(payload: WorkflowFailedPayload): void {
  captureAnalyticsEvent('core_task_failed', {
    core_session_id: payload.sessionId,
    session_id: payload.sessionId,
    workflow_name: payload.workflowName,
    template_id: payload.templateId,
    task_kind: payload.taskKind,
    task_id: payload.taskId,
    error_type: payload.errorType,
    duration_ms: payload.durationMs,
    success: false,
  });
}

export function captureErrorOccurred(payload: ErrorOccurredPayload): void {
  captureAnalyticsEvent('error_occurred', {
    core_session_id: payload.sessionId,
    session_id: payload.sessionId,
    error_type: payload.errorType,
    tool_name: payload.toolName,
    workflow_name: payload.workflowName,
    message_hash: payload.messageHash,
  });
}

export function captureToolCallStarted(payload: ToolCallStartedPayload): void {
  const argSummary = summarizeArgs(payload.args);

  captureAnalyticsEvent(
    'core_tool_call_started',
    {
      core_session_id: payload.sessionId,
      session_id: payload.sessionId,
      tool_call_id: payload.toolCallId,
      tool_name: payload.toolName,
      agent_name: payload.agentName,
      workflow_name: payload.workflowName,
      project_dir_hash: hashProjectDir(payload.projectDir),
      source: 'live',
      ...argSummary,
    },
    { timestamp: payload.startedAt },
  );
}

export function captureToolCallCompleted(payload: ToolCallCompletedPayload): void {
  captureAnalyticsEvent(
    'core_tool_call_completed',
    {
      core_session_id: payload.sessionId,
      session_id: payload.sessionId,
      tool_call_id: payload.toolCallId,
      tool_name: payload.toolName,
      agent_name: payload.agentName,
      workflow_name: payload.workflowName,
      is_error: payload.isError,
      success: !payload.isError,
      duration_ms: payload.durationMs ?? null,
      latency_ms: payload.durationMs ?? null,
      error_message: sanitizeErrorMessage(payload.errorMessage),
      started_at: payload.startedAt,
      completed_at: payload.completedAt,
      sqlite_row_id: payload.sqliteRowId,
      project_dir_hash: hashProjectDir(payload.projectDir),
      source: payload.source ?? 'live',
    },
    { timestamp: payload.completedAt ?? payload.startedAt },
  );
}

export function captureFinalVideoCreated(payload: FinalVideoCreatedPayload): void {
  captureAnalyticsEvent('final_video_created', {
    core_session_id: payload.sessionId,
    session_id: payload.sessionId,
    duration_seconds: payload.durationSeconds,
    file_size_bytes: payload.fileSizeBytes,
    version_number: payload.versionNumber,
    template_id: payload.templateId,
    style: payload.style,
    segment_count: payload.segmentCount,
    project_dir_hash: hashProjectDir(payload.projectDir),
    assembly_path_type: payload.assemblyPathType,
  });
}

export async function shutdownPostHog(): Promise<void> {
  if (!posthogClient) {
    return;
  }

  try {
    await posthogClient.shutdown();
  } catch {
    // Analytics must never break shutdown flow.
  }
}

export function registerPostHogShutdownHandlers(): void {
  if (shutdownHandlersRegistered) {
    return;
  }
  shutdownHandlersRegistered = true;

  process.once('beforeExit', () => {
    void shutdownPostHog();
  });

  const handleSignal = (signal: NodeJS.Signals) => {
    process.once(signal, () => {
      void shutdownPostHog().finally(() => process.exit(0));
    });
  };

  handleSignal('SIGINT');
  handleSignal('SIGTERM');
}

export function resetAnalyticsForTests(): void {
  posthogClient = undefined;
  cachedDeviceId = undefined;
  analyticsIdentity = {};
  extraCommonProperties = {};
  commonProperties = {
    app_version: '0.0.0',
    platform: 'server',
    os: normalizeOs(os.platform()),
  };
  uninstallPostHogConsoleFilter();
}
