/**
 * Regression: ConversationManager.runTask must NOT throw "Session
 * agent not configured" when the session has no agent yet. The
 * embedded desktop integration creates a session up-front (so it
 * can render its UI) and then learns about the active project
 * later — by the time runTask is called, the session may not have
 * been through configureSessionForProject yet (e.g. user calls
 * `focusSessionProject` directly which does NOT create an agent).
 *
 * The pre-bug behavior was: runTask checks `!session.agent` BEFORE
 * its own `ensureAmbientSession()` helper runs, throwing the
 * "Session agent not configured" error even though the runTask body
 * itself contains the recovery code path. The fix: reorder so
 * ensureAmbientSession runs before the agent check (or remove the
 * early check entirely — ensureAmbientSession guarantees an agent
 * exists, and the second check at the "Failed to initialize" line
 * already covers the failure case).
 *
 * Bug surfaced 2026-05-01 in the dhee-desktop embedded path:
 * "Session agent not configured. Select a project first." appeared
 * after the user opened a project, even though the desktop's
 * ChatPanelEmbedded calls focusProject on project select.
 */
import { describe, it, expect } from "vitest";
import { ConversationManager } from "../../src/server/ConversationManager.js";

describe("ConversationManager.runTask ambient session bootstrap", () => {
  it("does not throw 'Session agent not configured' when a session has no agent yet", async () => {
    const cm = new ConversationManager({
      llmConfig: { baseUrl: "x", apiKey: "x", model: "x" } as never,
    });
    const session = cm.createSession();

    // Spy on `ensureAmbientSession` (private method) by patching the
    // prototype. Inject a fake agent + session context the way the
    // real method would, so runTask can proceed.
    const fakeAgent = {
      async initialize() {},
      async run(_task: string) {
        return { status: "completed" as const, output: "", todos: [] };
      },
      stop() {},
      isRunning() { return false; },
      getToolNames() { return []; },
      setAutonomousMode() {},
      on() { return this; },
      off() { return this; },
      emit() { return true; },
      removeAllListeners() { return this; },
    };
    let ambientCalled = false;
    const internal = (cm as unknown as {
      sessions: Map<string, { agent?: unknown; sessionContext?: unknown; initialized?: boolean }>;
    }).sessions;
    (cm as unknown as { ensureAmbientSession: (id: string) => void }).ensureAmbientSession =
      (sessionId: string) => {
        ambientCalled = true;
        const s = internal.get(sessionId);
        if (s) {
          s.agent = fakeAgent;
          s.sessionContext = {
            sessionId,
            mode: "local",
            projectDir: "ambient.dhee",
          } as never;
          s.initialized = true;
        }
      };

    let thrown: unknown = null;
    try {
      await cm.runTask(session.id, "hello there");
    } catch (err) {
      thrown = err;
    }

    expect(ambientCalled).toBe(true);
    if (thrown instanceof Error) {
      expect(thrown.message).not.toMatch(/Session agent not configured/i);
    }
  });
});
