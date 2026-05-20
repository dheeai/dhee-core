import { describe, it, expect } from "vitest";
import {
  translatePiEvent,
  flattenToolResult,
  extractAssistantText,
  extractFinalText,
  type TranslationContext,
} from "../../src/agent/pi/translateEvent.js";

const ctx0: TranslationContext = { agentName: "dhee-pi", finalAssistantText: "" };

describe("translatePiEvent — tool execution", () => {
  it("turns tool_execution_start into tool_call with the args object", () => {
    const r = translatePiEvent(
      {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "dhee_status",
        args: { project: "chhaya" },
      } as never,
      ctx0,
    );
    expect(r.events).toEqual([
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "dhee_status",
        arguments: { project: "chhaya" },
        agentName: "dhee-pi",
      },
    ]);
  });

  it("normalizes missing args to an empty object on tool_execution_start", () => {
    const r = translatePiEvent(
      { type: "tool_execution_start", toolCallId: "t1", toolName: "dhee_list_projects" } as never,
      ctx0,
    );
    const ev = r.events[0] as { type: string; arguments: unknown };
    expect(ev.type).toBe("tool_call");
    expect(ev.arguments).toEqual({});
  });

  it("emits tool_streaming with reset=true when a partial result has text content", () => {
    const r = translatePiEvent(
      {
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "dhee_run_to",
        args: {},
        partialResult: { content: [{ type: "text", text: "step 3/10" }] },
      } as never,
      ctx0,
    );
    expect(r.events).toHaveLength(1);
    const ev = r.events[0] as {
      type: string;
      chunk: string;
      done: boolean;
      reset: boolean;
    };
    expect(ev.type).toBe("tool_streaming");
    expect(ev.chunk).toBe("step 3/10");
    expect(ev.done).toBe(false);
    expect(ev.reset).toBe(true);
  });

  it("drops tool_execution_update with no extractable text", () => {
    const r = translatePiEvent(
      {
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "dhee_run_to",
        args: {},
        partialResult: { content: [{ type: "image", url: "..." }] },
      } as never,
      ctx0,
    );
    expect(r.events).toHaveLength(0);
  });

  it("flattens tool_execution_end so file_path bubbles to the top of result", () => {
    const r = translatePiEvent(
      {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "dhee_show_first_frame",
        result: {
          content: [{ type: "text", text: "assets/images/s1shot1_first_frame.png" }],
          details: {
            file_path: "assets/images/s1shot1_first_frame.png",
            asset_id: "img_xyz",
          },
        },
        isError: false,
      } as never,
      ctx0,
    );
    const ev = r.events[0] as { type: string; result: Record<string, unknown>; isError: boolean };
    expect(ev.type).toBe("tool_result");
    expect(ev.isError).toBe(false);
    expect(ev.result["file_path"]).toBe("assets/images/s1shot1_first_frame.png");
    expect(ev.result["asset_id"]).toBe("img_xyz");
    expect(ev.result["output"]).toBe("assets/images/s1shot1_first_frame.png");
  });

  it("propagates isError on tool_execution_end", () => {
    const r = translatePiEvent(
      {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "dhee_status",
        result: { content: [{ type: "text", text: "boom" }], details: {} },
        isError: true,
      } as never,
      ctx0,
    );
    expect((r.events[0] as { isError: boolean }).isError).toBe(true);
  });
});

describe("translatePiEvent — assistant streaming", () => {
  it("forwards text_delta as streaming_text(done=false)", () => {
    const r = translatePiEvent(
      {
        type: "message_update",
        message: {} as unknown,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: {} as unknown },
      } as never,
      ctx0,
    );
    expect(r.events).toEqual([{ type: "streaming_text", chunk: "Hello", done: false }]);
  });

  it("ignores message_update events that aren't text_delta", () => {
    const r = translatePiEvent(
      {
        type: "message_update",
        message: {} as unknown,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "x", partial: {} as unknown },
      } as never,
      ctx0,
    );
    expect(r.events).toEqual([]);
  });

  it("ignores empty text_delta", () => {
    const r = translatePiEvent(
      {
        type: "message_update",
        message: {} as unknown,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial: {} as unknown },
      } as never,
      ctx0,
    );
    expect(r.events).toEqual([]);
  });

  it("emits exactly one streaming_text(done) on message_end — never both streaming_text and agent_text (server's onAgentText would double-fire stream_chunk)", () => {
    const r = translatePiEvent(
      {
        type: "message_end",
        message: { content: [{ type: "text", text: "Done." }] },
      } as never,
      ctx0,
    );
    expect(r.events).toEqual([
      { type: "streaming_text", chunk: "Done.", done: true },
    ]);
    expect(r.context.finalAssistantText).toBe("Done.");
  });

  it("drops message_end with no extractable text", () => {
    const r = translatePiEvent(
      {
        type: "message_end",
        message: { content: [{ type: "tool_use", id: "x" }] },
      } as never,
      ctx0,
    );
    expect(r.events).toHaveLength(0);
    expect(r.context.finalAssistantText).toBe("");
  });

  it("drops message_end for user-role messages so the user's own text isn't echoed as an agent bubble", () => {
    const r = translatePiEvent(
      {
        type: "message_end",
        message: {
          role: "user",
          content: [{ type: "text", text: "(Active project: X)\n\nshow me s2 shot 4" }],
        },
      } as never,
      ctx0,
    );
    expect(r.events).toHaveLength(0);
    expect(r.context.finalAssistantText).toBe("");
  });

  it("drops message_end for tool-result messages", () => {
    const r = translatePiEvent(
      {
        type: "message_end",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "tool stdout..." }],
        },
      } as never,
      ctx0,
    );
    expect(r.events).toHaveLength(0);
  });
});

describe("translatePiEvent — agent_end", () => {
  it("uses context.finalAssistantText as the agent end output when present", () => {
    const r = translatePiEvent(
      { type: "agent_end", messages: [] } as never,
      { agentName: "dhee-pi", finalAssistantText: "Hello there" },
    );
    expect(r.events).toEqual([]);
    expect(r.agentEndOutput).toBe("Hello there");
  });

  it("falls back to the last assistant message in messages[] when context has no text", () => {
    const r = translatePiEvent(
      {
        type: "agent_end",
        messages: [
          { role: "user", content: [{ type: "text", text: "Hi" }] },
          { role: "assistant", content: [{ type: "text", text: "First reply" }] },
          { role: "user", content: [{ type: "text", text: "Again" }] },
          { role: "assistant", content: [{ type: "text", text: "Last reply" }] },
        ],
      } as never,
      ctx0,
    );
    expect(r.agentEndOutput).toBe("Last reply");
  });

  it("returns empty string when neither context nor messages have assistant text", () => {
    const r = translatePiEvent({ type: "agent_end", messages: [] } as never, ctx0);
    expect(r.agentEndOutput).toBe("");
  });
});

describe("translatePiEvent — unknown event types", () => {
  it("returns no events without throwing", () => {
    const r = translatePiEvent({ type: "queue_update", steering: [], followUp: [] } as never, ctx0);
    expect(r.events).toEqual([]);
    expect(r.agentEndOutput).toBeUndefined();
  });
});

describe("helper functions", () => {
  it("flattenToolResult merges details over a synthesized output", () => {
    const out = flattenToolResult({
      content: [{ type: "text", text: "hello" }],
      details: { file_path: "p.png" },
    }) as Record<string, unknown>;
    expect(out["file_path"]).toBe("p.png");
    expect(out["output"]).toBe("hello");
  });

  it("flattenToolResult passes through non-object inputs unchanged", () => {
    expect(flattenToolResult("plain string")).toBe("plain string");
    expect(flattenToolResult(42)).toBe(42);
    expect(flattenToolResult(null)).toBe(null);
  });

  it("extractAssistantText handles string content directly", () => {
    expect(extractAssistantText({ content: "raw text" })).toBe("raw text");
  });

  it("extractFinalText scans backwards for the latest assistant message", () => {
    const text = extractFinalText([
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "user", content: [{ type: "text", text: "noise" }] },
      { role: "assistant", content: [{ type: "text", text: "latest" }] },
    ]);
    expect(text).toBe("latest");
  });
});
