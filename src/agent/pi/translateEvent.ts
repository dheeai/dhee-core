/**
 * Pure mapping from pi-coding-agent's session events to the dhee
 * AgentEvent vocabulary that ConversationManager + the frontend expect.
 *
 * Extracted so the translation can be unit-tested without booting a real
 * pi AgentSession (which requires auth, model registry, etc.).
 */
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type {
  ToolCallEvent,
  ToolResultEvent,
  ToolStreamingEvent,
  StreamingTextEvent,
  AgentTextEvent,
  NotificationEvent,
} from "../../events/events.js";

export type TranslateddheeEvent =
  | ToolCallEvent
  | ToolResultEvent
  | ToolStreamingEvent
  | StreamingTextEvent
  | AgentTextEvent
  | NotificationEvent;

export interface TranslationContext {
  /** agentName tag attached to tool_call / tool_result / tool_streaming events. */
  agentName: string;
  /**
   * Latest assistant text observed across message_end events for the current
   * turn. Consumed when agent_end fires to seed run()'s GenericAgentResult.output.
   */
  finalAssistantText: string;
}

export interface TranslationResult {
  /** dhee events to emit, in order. */
  events: TranslateddheeEvent[];
  /** Updated context the caller should persist. */
  context: TranslationContext;
  /**
   * When defined, the pi agent_end event fired and run() should resolve with
   * this output. Empty string is a valid value — it just means the assistant
   * had no final text (the output usually came via tool calls).
   */
  agentEndOutput?: string;
}

export function translatePiEvent(
  event: AgentSessionEvent,
  ctx: TranslationContext,
): TranslationResult {
  switch (event.type) {
    case "tool_execution_start":
      return {
        events: [
          {
            type: "tool_call",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            arguments: (event.args ?? {}) as Record<string, unknown>,
            agentName: ctx.agentName,
          },
        ],
        context: ctx,
      };

    case "tool_execution_update": {
      const text = extractContentText(event.partialResult);
      if (!text) return { events: [], context: ctx };
      return {
        events: [
          {
            type: "tool_streaming",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            chunk: text,
            done: false,
            reset: true,
            agentName: ctx.agentName,
          },
        ],
        context: ctx,
      };
    }

    case "tool_execution_end":
      return {
        events: [
          {
            type: "tool_result",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: flattenToolResult(event.result),
            isError: event.isError,
            agentName: ctx.agentName,
          },
        ],
        context: ctx,
      };

    case "message_update": {
      const sub = event.assistantMessageEvent;
      if (sub.type !== "text_delta" || typeof sub.delta !== "string" || sub.delta.length === 0) {
        return { events: [], context: ctx };
      }
      return {
        events: [{ type: "streaming_text", chunk: sub.delta, done: false }],
        context: ctx,
      };
    }

    case "message_end": {
      const text = extractAssistantText(event.message);
      if (!text) return { events: [], context: ctx };
      // Emit ONLY streaming_text(done:true) — not also agent_text. The
      // server's onAgentText handler converts agent_text into another
      // stream_chunk(done:true), which would double-fire and duplicate
      // the bubble in chat. streaming_text alone covers the rendering.
      return {
        events: [{ type: "streaming_text", chunk: text, done: true }],
        context: { ...ctx, finalAssistantText: text },
      };
    }

    case "agent_end": {
      const out = ctx.finalAssistantText || extractFinalText(event.messages);
      return { events: [], context: ctx, agentEndOutput: out };
    }

    case "compaction_start": {
      // Surface to the user — a long pause is otherwise unexplained.
      // Reason: 'manual' | 'threshold' | 'overflow'. We only flag the
      // automatic ones; a manual /compact is initiated by the user
      // and doesn't need an explainer toast.
      if (event.reason === "manual") return { events: [], context: ctx };
      return {
        events: [
          {
            type: "notification",
            level: "info",
            message:
              event.reason === "overflow"
                ? "Context window is full — summarizing earlier messages…"
                : "Approaching context limit — summarizing earlier messages…",
          },
        ],
        context: ctx,
      };
    }

    case "compaction_end": {
      if (event.reason === "manual") return { events: [], context: ctx };
      if (event.aborted) return { events: [], context: ctx };
      const errLevel: "info" | "warning" | "error" = event.errorMessage ? "warning" : "info";
      const errMsg = event.errorMessage
        ? `Compaction failed: ${event.errorMessage}.${event.willRetry ? ' Retrying…' : ''}`
        : "Earlier messages summarized — chat continues.";
      return {
        events: [{ type: "notification", level: errLevel, message: errMsg }],
        context: ctx,
      };
    }

    default:
      return { events: [], context: ctx };
  }
}

export function extractContentText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const v = value as { content?: unknown };
  if (!Array.isArray(v.content)) return "";
  return v.content
    .map((c) =>
      c && typeof c === "object" && "type" in c && (c as { type: unknown }).type === "text" && "text" in c
        ? String((c as { text: unknown }).text)
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

export function flattenToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as { content?: unknown; details?: unknown };
  const text = extractContentText(r);
  const details = r.details && typeof r.details === "object" ? (r.details as Record<string, unknown>) : {};
  return { ...details, output: text };
}

export function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as { role?: unknown; content?: unknown };
  // pi's message_end fires for user / assistant / toolResult messages alike.
  // Only assistant text should land in the chat as an agent bubble — echoing
  // the user's own prompt back as an agent message is what produced the
  // mysterious "(Active project: ...) show me ..." bubble in noir-3.
  if (m.role !== undefined && m.role !== "assistant") return "";
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content
    .map((c) =>
      c && typeof c === "object" && "type" in c && (c as { type: unknown }).type === "text" && "text" in c
        ? String((c as { text: unknown }).text)
        : "",
    )
    .filter(Boolean)
    .join("");
}

export function extractFinalText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === "object" && "role" in m && (m as { role: unknown }).role === "assistant") {
      const text = extractAssistantText(m);
      if (text) return text;
    }
  }
  return "";
}
