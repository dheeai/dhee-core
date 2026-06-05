/**
 * usageTelemetryExtension — record chat-agent (pi-ai) LLM usage to the
 * shared telemetry sink (issue #102, fix #0).
 *
 * The chat lane doesn't go through dhee's LLMClient — pi-ai owns its own
 * provider stream. But every assistant turn carries a `usage` object, and
 * pi emits a `message_end` event with that message. We subscribe and
 * record one telemetry line per assistant message, tagged lane='chat', so
 * the chat-vs-walker spend split and the chat lane's input:output ratio
 * (the symptom in issue #102) are visible alongside the walker lane.
 *
 * Recording goes to the same `<logs>/llm-usage.jsonl` the walker uses, via
 * recordLlmUsage (best-effort, env-gated). Pure read of the event — never
 * mutates the message or the turn.
 */
import type { ExtensionAPI, ExtensionFactory } from '@mariozechner/pi-coding-agent';
import { recordLlmUsage } from '../../core/llm/usageTelemetry.js';

/** The assistant-message usage shape pi-ai attaches (see pi-ai Usage). */
interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

interface AssistantLike {
  role?: string;
  model?: string;
  usage?: PiUsage;
}

/**
 * Pull the usage off a `message_end` event payload and record it. Exported
 * for direct testing (drives the same path the registered handler does).
 */
export function recordChatMessageUsage(message: unknown, sessionId?: string): void {
  const m = message as AssistantLike | undefined;
  if (!m || m.role !== 'assistant' || !m.usage) return;
  const u = m.usage;
  const prompt = u.input ?? 0;
  recordLlmUsage({
    lane: 'chat',
    model: m.model ?? 'unknown',
    ...(sessionId !== undefined ? { sessionId } : {}),
    promptTokens: prompt,
    cachedTokens: u.cacheRead ?? 0,
    completionTokens: u.output ?? 0,
    totalTokens: u.totalTokens ?? prompt + (u.output ?? 0),
    ...(typeof u.cost?.total === 'number' ? { costUsd: u.cost.total } : {}),
  });
}

/** pi extension factory — wire into the default session stack. */
export const registerUsageTelemetry: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.on('message_end', (event: { message?: unknown }) => {
    recordChatMessageUsage(event?.message);
  });
};
