/**
 * Regression: ConversationManager.focusSessionProject must read
 * `project.json` reliably regardless of the host's process.cwd().
 *
 * The original code did `loadProject(projectDirName)`, which passes
 * the project DIR NAME (e.g. "chhaya_60s_anime.dhee") into
 * loadProject's `basePath` argument — semantically wrong. It only
 * happened to work in the standalone CLI when cwd was already
 * /Users/.../dhee-core AND a session context was set up with
 * matching projectDir. Embedded in the desktop, neither held, and
 * focusSessionProject failed with
 *   "project.json not found or empty for 'chhaya_60s_anime'".
 *
 * Fix: read project.json directly from
 *   `<defaultBasePath>/<projectName>.dhee/project.json`
 * where defaultBasePath honours `dhee_PROJECTS_DIR` (set by the
 * embedded host) and falls back to process.cwd() (CLI).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationManager } from "../../src/server/ConversationManager.js";

describe("ConversationManager.focusSessionProject reads project.json from dhee_PROJECTS_DIR", () => {
  let projectsDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), "dhee-focus-"));
    mkdirSync(join(projectsDir, "demo.dhee"), { recursive: true });
    writeFileSync(
      join(projectsDir, "demo.dhee", "project.json"),
      JSON.stringify({
        version: "3.0",
        name: "demo",
        templateId: "narrative",
        style: "noir",
        targetDuration: 30,
      }),
    );
    originalEnv = process.env["dhee_PROJECTS_DIR"];
    process.env["dhee_PROJECTS_DIR"] = projectsDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env["dhee_PROJECTS_DIR"];
    else process.env["dhee_PROJECTS_DIR"] = originalEnv;
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it("loads the project even when process.cwd() is unrelated to dhee_PROJECTS_DIR", async () => {
    const cm = new ConversationManager({
      llmConfig: { baseUrl: "x", apiKey: "x", model: "x" } as never,
    });
    const session = cm.createSession();

    const result = await cm.focusSessionProject(session.id, "demo");
    expect(result.projectName).toBe("demo");
    expect(result.templateId).toBe("narrative");
    expect(result.style).toBe("noir");
  });

  it("throws a clear error when the project does not exist", async () => {
    const cm = new ConversationManager({
      llmConfig: { baseUrl: "x", apiKey: "x", model: "x" } as never,
    });
    const session = cm.createSession();

    await expect(cm.focusSessionProject(session.id, "nonexistent-project")).rejects.toThrow(
      /not found|unreadable/i,
    );
  });

  /**
   * GIVEN the desktop opens project "demo" — dheeCoreManager calls
   *       `manager.focusSessionProject(sessionId, "demo")` BEFORE the
   *       user types any task.
   *
   *  WHEN the user then sends the very first task on that session.
   *
   *  THEN `applyProjectAnnouncement` must still inject the
   *       "(Active project: demo. …)" prefix so pi-agent reads the
   *       active project in its prompt — otherwise pi falls back to
   *       `dhee_list_projects`, only sees `.dhee`-suffixed dirs,
   *       and confidently picks the wrong one (the BurgerEating-vs-
   *       The-Village bug from the field).
   *
   *  This regression check looks at the post-focus session state: if
   *  `announcedProject` was pre-set to the focus target, the very
   *  next `applyProjectAnnouncement` call will short-circuit and the
   *  agent will never see the announcement.
   */
  it("does NOT pre-mark the project as announced — the first runTask must still emit the announcement", async () => {
    const cm = new ConversationManager({
      llmConfig: { baseUrl: "x", apiKey: "x", model: "x" } as never,
    });
    const session = cm.createSession();

    await cm.focusSessionProject(session.id, "demo");

    // Reach into the private session map — we test the contract that
    // a fresh focus leaves announcedProject unset.
    const sessions = (
      cm as unknown as {
        sessions: Map<string, { focusedProject?: string; announcedProject?: string }>;
      }
    ).sessions;
    const internal = sessions.get(session.id)!;
    expect(internal.focusedProject).toBe("demo");
    expect(internal.announcedProject).toBeUndefined();
  });

  it("keeps an explicit focused projectDir even when dhee_PROJECTS_DIR changes afterward", async () => {
    const docsRoot = mkdtempSync(join(tmpdir(), "dhee-focus-docs-"));
    const otherProjectsDir = mkdtempSync(join(tmpdir(), "dhee-focus-other-"));
    const explicitProjectDir = join(docsRoot, "cyberpunk-2");
    mkdirSync(explicitProjectDir, { recursive: true });
    writeFileSync(
      join(explicitProjectDir, "project.json"),
      JSON.stringify({
        version: "3.0",
        name: "cyberpunk-2",
        templateId: "narrative",
        style: "cyberpunk",
        targetDuration: 240,
      }),
    );

    try {
      process.env["dhee_PROJECTS_DIR"] = otherProjectsDir;
      const cm = new ConversationManager({
        llmConfig: { baseUrl: "x", apiKey: "x", model: "x" } as never,
      });
      const session = cm.createSession();

      const focusSessionProject = (
        cm as unknown as {
          focusSessionProject: (
            sessionId: string,
            projectName: string,
            projectDir?: string,
          ) => Promise<{ projectName: string; projectDir?: string }>;
        }
      ).focusSessionProject.bind(cm);
      const result = await focusSessionProject(session.id, "cyberpunk-2", explicitProjectDir);
      expect(result.projectName).toBe("cyberpunk-2");
      expect(result.projectDir).toBe(explicitProjectDir);

      process.env["dhee_PROJECTS_DIR"] = projectsDir;

      const sessions = (
        cm as unknown as {
          sessions: Map<
            string,
            {
              focusedProject?: string;
              focusedProjectDir?: string;
              announcedProject?: string;
            }
          >;
        }
      ).sessions;
      const internal = sessions.get(session.id)!;
      expect(internal.focusedProject).toBe("cyberpunk-2");
      expect(internal.focusedProjectDir).toBe(explicitProjectDir);
      expect(internal.announcedProject).toBeUndefined();
    } finally {
      rmSync(docsRoot, { recursive: true, force: true });
      rmSync(otherProjectsDir, { recursive: true, force: true });
    }
  });
});
