/**
 * runAgentTurn — execute one pi-coding-agent turn and return a
 * structured envelope.
 *
 * Shared by:
 *   - the `pnpm drive` CLI (Claude-Code-driven test harness).
 *   - the desktop's in-process chatPrompt IPC handler (BUG-016 Phase 6.5).
 *
 * Both need the same shape: kick `session.prompt(msg)`, capture every
 * text delta + tool_execution_start, return `{assistant_text, tool_calls}`.
 * Hoisting it here means agent-driven and chat-driven turns interpret
 * the model's output identically.
 *
 * `keepAlive` controls disposal. The CLI disposes after each turn
 * (one-shot subprocess); the desktop's long-lived session should NOT
 * dispose between turns.
 */

export interface ToolCallSummary {
  name: string;
}

export interface RunAgentTurnOk {
  ok: true;
  assistant_text: string;
  tool_calls: ToolCallSummary[];
}

export interface RunAgentTurnErr {
  ok: false;
  error: string;
}

export type RunAgentTurnResult = RunAgentTurnOk | RunAgentTurnErr;

export interface RunAgentTurnOpts {
  /**
   * Set true when the same session will be used for more turns (the
   * desktop's chat panel). Defaults to false (the CLI's one-shot
   * subprocess), in which case the session is disposed after the
   * turn so the JSONL handle releases cleanly.
   */
  keepAlive?: boolean;
}

/**
 * The narrow surface we exercise from a pi-coding-agent AgentSession.
 * Keeping it loose lets tests stub it without dragging the SDK's
 * full event-type union into the harness.
 */
export interface AgentTurnSession {
  subscribe: (listener: (ev: unknown) => void) => () => void;
  prompt: (message: string) => Promise<void>;
  dispose?: () => void;
}

export async function runAgentTurn(
  session: AgentTurnSession,
  message: string,
  opts: RunAgentTurnOpts = {},
): Promise<RunAgentTurnResult> {
  const textChunks: string[] = [];
  const toolCalls: ToolCallSummary[] = [];

  const unsub = session.subscribe((ev) => {
    const e = ev as {
      type?: string;
      assistantMessageEvent?: { type?: string; delta?: string };
      toolName?: string;
    };
    if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') {
      const delta = e.assistantMessageEvent.delta ?? '';
      if (delta) textChunks.push(delta);
    } else if (e.type === 'tool_execution_start') {
      toolCalls.push({ name: e.toolName ?? 'unknown' });
    }
  });

  try {
    await session.prompt(message);
  } catch (err) {
    unsub?.();
    if (!opts.keepAlive) session.dispose?.();
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
  unsub?.();
  if (!opts.keepAlive) session.dispose?.();

  return {
    ok: true,
    assistant_text: textChunks.join('').trim(),
    tool_calls: toolCalls,
  };
}
