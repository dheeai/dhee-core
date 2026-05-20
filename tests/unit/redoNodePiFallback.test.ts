/**
 * Regression: clicking "Regenerate" in the Edit modal sends a redo_node
 * WS message → ConversationManager.redoNode. For pi-era projects the
 * session agent (PiSessionAgent) has no `redoNode` method, so the
 * server was throwing "Agent does not support redo" silently —
 * Regenerate clicks did nothing visible.
 *
 * The fallback shells out to scripts/regen-node.ts (same path
 * dhee_regen uses) so pi-era projects get the same behavior as
 * legacy executor projects.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationManager, type ConversationEvents } from "../../src/server/ConversationManager.js";

let tmpRoot: string;
let originalProjectsDir: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "dhee-redo-fallback-"));
  originalProjectsDir = process.env["dhee_PROJECTS_DIR"];
  // Layout: <tmpRoot>/test.dhee/project.json + assets/manifest.json
  const proj = join(tmpRoot, "test.dhee");
  mkdirSync(join(proj, "assets"), { recursive: true });
  writeFileSync(
    join(proj, "project.json"),
    JSON.stringify({
      version: "3.0",
      id: "test",
      title: "Test",
      templateId: "narrative",
      assets: [],
    }),
  );
  writeFileSync(join(proj, "assets", "manifest.json"), JSON.stringify({ assets: [] }));
});

afterEach(() => {
  if (originalProjectsDir === undefined) delete process.env["dhee_PROJECTS_DIR"];
  else process.env["dhee_PROJECTS_DIR"] = originalProjectsDir;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ConversationManager.redoNode pi-era fallback", () => {
  it("does NOT throw 'Agent does not support redo' when the session agent has no redoNode method", async () => {
    const cm = new ConversationManager({
      llmConfig: { baseUrl: "x", apiKey: "x", model: "x" } as never,
    });
    const session = cm.createSession();

    // Inject a pi-like agent: no redoNode method, satisfies the rest of
    // SessionAgent so runTask can also resolve cleanly.
    const fakeAgent = {
      async initialize() {},
      async run(_t: string, _u?: string) {
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
    const internal = (cm as unknown as {
      sessions: Map<string, {
        agent?: unknown;
        sessionContext?: { projectDir: string };
        initialized?: boolean;
      }>;
    }).sessions;
    const s = internal.get(session.id)!;
    s.agent = fakeAgent;
    s.sessionContext = { projectDir: "test.dhee" };
    s.initialized = true;

    const events: ConversationEvents = {};

    // For an unknown node, the fallback subprocess will exit non-zero.
    // What we explicitly assert: the call does NOT throw the legacy
    // "Agent does not support redo" message — the dispatch took the
    // pi-era path. Any thrown error from the subprocess itself is
    // acceptable here; we just don't want the silent legacy error.
    let thrown: unknown;
    try {
      await cm.redoNode(session.id, "shot_image:scene_1_shot_1", events);
    } catch (err) {
      thrown = err;
    }
    if (thrown instanceof Error) {
      expect(thrown.message).not.toContain("Agent does not support redo");
    }
  });
});
