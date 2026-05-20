/**
 * Regression: runTask must populate session.activeEvents so the
 * onMedia closure that PiSessionAgent fires can reach onMediaGenerated.
 *
 * Without this, dhee_show_shot runs successfully, the agent says
 * "you should see the first frame" — but no media cards arrive in
 * the chat because the closure can't find the events callback to
 * forward to.
 *
 * The bug shipped on 2026-04-29 (chat reproduction in noir-3 's1 shot 4').
 */
import { describe, it, expect } from "vitest";
import { ConversationManager, type ConversationEvents } from "../../src/server/ConversationManager.js";

describe("ConversationManager runTask wires activeEvents for media events", () => {
  it("sets session.activeEvents during runTask so callbacks can reach the WS layer", async () => {
    const cm = new ConversationManager({
      llmConfig: { baseUrl: "x", apiKey: "x", model: "x" } as never,
    });
    const session = cm.createSession();
    const observed: { activeEventsSeen: boolean } = { activeEventsSeen: false };

    // Inject a fake agent so we don't have to boot pi or the executor. The
    // fake's run() snoops on session.activeEvents the way a real tool's
    // onMedia closure would.
    const fakeAgent = {
      async initialize() {},
      async run(_task: string) {
        const internalSession = (cm as unknown as {
          sessions: Map<string, { activeEvents?: ConversationEvents }>;
        }).sessions.get(session.id);
        observed.activeEventsSeen = !!internalSession?.activeEvents?.onMediaGenerated;
        return { status: "completed" as const, output: "", todos: [] };
      },
      stop() {},
      isRunning() { return false; },
      getToolNames() { return []; },
      setAutonomousMode() {},
      // TypedEventEmitter shims — only the methods runTask touches.
      on() { return this; },
      off() { return this; },
      emit() { return true; },
      removeAllListeners() { return this; },
    };
    const internal = (cm as unknown as {
      sessions: Map<string, { agent?: unknown; sessionContext?: unknown; initialized?: boolean }>;
    }).sessions;
    const internalSession = internal.get(session.id)!;
    internalSession.agent = fakeAgent;
    internalSession.sessionContext = {
      sessionId: session.id,
      mode: "local",
      projectDir: "ambient.dhee",
    } as never;
    internalSession.initialized = true;

    const events: ConversationEvents = {
      onMediaGenerated: () => {},
    };

    await cm.runTask(session.id, "test task", events);
    expect(observed.activeEventsSeen).toBe(true);
  });
});
