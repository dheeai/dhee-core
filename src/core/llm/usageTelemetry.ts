/**
 * usageTelemetry — per-call LLM usage telemetry (issue #102, fix #0).
 *
 * Records one JSONL line per real LLM call, tagged by LANE (walker vs
 * chat) and origin (nodeId/itemId for the walker; sessionId for the
 * chat agent). This is the instrumentation that turns the rest of the
 * #102 work from guesswork into data: it confirms the chat-vs-walker
 * spend split and lets us measure the cached-token ratio lift from the
 * prompt-cache work and the prompt-size bound from the context-trim work.
 *
 * Writes to `<logs>/llm-usage.jsonl` (alongside the other LLM logs) so
 * it's where you already look when debugging. Best-effort: a write
 * failure never disrupts a generation. Opt out with
 * DHEE_USAGE_TELEMETRY_DISABLED; override the path with
 * DHEE_USAGE_TELEMETRY_PATH.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getLogsDir } from '../../utils/logsPath.js';

export type LlmLane = 'walker' | 'chat' | string;

/** One recorded LLM call. */
export interface LlmUsageRecord {
  /** Epoch ms. */
  ts: number;
  lane: LlmLane;
  model: string;
  /** Walker lane: the bundle node that issued the call. */
  nodeId?: string;
  /** Walker lane: the collection item, when applicable. */
  itemId?: string;
  /** Chat lane: the pi session id, when available. */
  sessionId?: string;
  promptTokens: number;
  /** Of promptTokens, how many were served from the provider's prefix cache. */
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** cachedTokens / promptTokens (0 when promptTokens is 0). */
  cachedRatio: number;
  /** USD cost for this call when the provider reports it. */
  costUsd?: number;
}

/** The fields a caller supplies; ts + cachedRatio are derived. */
export type LlmUsageInput = Omit<LlmUsageRecord, 'ts' | 'cachedRatio'> & { ts?: number };

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** Resolve the telemetry file path (env override wins). */
export function usageTelemetryPath(): string {
  const override = process.env['DHEE_USAGE_TELEMETRY_PATH'];
  if (override && override.trim()) return override.trim();
  return join(getLogsDir(), 'llm-usage.jsonl');
}

export function isUsageTelemetryEnabled(): boolean {
  return !truthy(process.env['DHEE_USAGE_TELEMETRY_DISABLED']);
}

/** A subscriber notified for every recorded usage record. */
export type UsageListener = (record: LlmUsageRecord) => void;
const usageListeners: UsageListener[] = [];

/**
 * Subscribe to every recorded usage record. Used to forward records to a
 * downstream sink (e.g. the cloud-billed PostHog forwarder — see
 * src/server/llmUsageAnalytics.ts). Returns an unsubscribe function.
 *
 * Listeners fire INDEPENDENTLY of the local-file write, so forwarding
 * works even where the JSONL path isn't writable (e.g. a packaged
 * desktop whose cwd is read-only).
 */
export function addUsageListener(fn: UsageListener): () => void {
  usageListeners.push(fn);
  return () => {
    const i = usageListeners.indexOf(fn);
    if (i >= 0) usageListeners.splice(i, 1);
  };
}

/** Test helper: drop all listeners. */
export function clearUsageListeners(): void {
  usageListeners.length = 0;
}

function buildRecord(input: LlmUsageInput): LlmUsageRecord {
  const prompt = Number.isFinite(input.promptTokens) ? input.promptTokens : 0;
  const cached = Number.isFinite(input.cachedTokens) ? input.cachedTokens : 0;
  return {
    ts: input.ts ?? Date.now(),
    lane: input.lane,
    model: input.model,
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    promptTokens: prompt,
    cachedTokens: cached,
    completionTokens: Number.isFinite(input.completionTokens) ? input.completionTokens : 0,
    totalTokens: Number.isFinite(input.totalTokens) ? input.totalTokens : 0,
    cachedRatio: prompt > 0 ? cached / prompt : 0,
    ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
  };
}

/**
 * Record one usage record: notify listeners, then append the local JSONL.
 * Best-effort — never throws, so it can't break a generation. No-op when
 * disabled (DHEE_USAGE_TELEMETRY_DISABLED).
 */
export function recordLlmUsage(input: LlmUsageInput): void {
  if (!isUsageTelemetryEnabled()) return;
  const rec = buildRecord(input);
  // 1. Notify listeners first — independent of file IO so a downstream
  //    forwarder (e.g. cloud analytics) still fires where the log path
  //    isn't writable.
  for (const fn of usageListeners) {
    try {
      fn(rec);
    } catch {
      // A listener must never break recording.
    }
  }
  // 2. Append the local JSONL (best-effort).
  try {
    const path = usageTelemetryPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(rec) + '\n');
  } catch {
    // Telemetry is observability, never a hard dependency.
  }
}

/** Read records back (for summaries / tests). Skips malformed lines. */
export function readUsageRecords(path: string = usageTelemetryPath()): LlmUsageRecord[] {
  if (!existsSync(path)) return [];
  const out: LlmUsageRecord[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as LlmUsageRecord);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

export interface LaneSummary {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** cachedTokens / promptTokens across the lane. */
  cachedRatio: number;
  /** promptTokens / completionTokens (Infinity when no output). */
  inputOutputRatio: number;
}

export interface UsageSummary {
  overall: LaneSummary;
  byLane: Record<string, LaneSummary>;
}

function emptyLane(): LaneSummary {
  return {
    calls: 0,
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    cachedRatio: 0,
    inputOutputRatio: 0,
  };
}

function finalize(s: LaneSummary): LaneSummary {
  s.cachedRatio = s.promptTokens > 0 ? s.cachedTokens / s.promptTokens : 0;
  s.inputOutputRatio = s.completionTokens > 0 ? s.promptTokens / s.completionTokens : Infinity;
  return s;
}

/**
 * Aggregate records into an overall summary + a per-lane breakdown — the
 * "verifiable from per-call telemetry" the issue's done-criteria asks for
 * (chat-vs-walker split, cached ratio, input:output ratio).
 */
export function summarizeUsage(records: readonly LlmUsageRecord[]): UsageSummary {
  const overall = emptyLane();
  const byLane: Record<string, LaneSummary> = {};
  for (const r of records) {
    const lane = byLane[r.lane] ?? (byLane[r.lane] = emptyLane());
    for (const target of [overall, lane]) {
      target.calls += 1;
      target.promptTokens += r.promptTokens || 0;
      target.cachedTokens += r.cachedTokens || 0;
      target.completionTokens += r.completionTokens || 0;
      target.totalTokens += r.totalTokens || 0;
      target.costUsd += r.costUsd || 0;
    }
  }
  finalize(overall);
  for (const lane of Object.values(byLane)) finalize(lane);
  return { overall, byLane };
}
