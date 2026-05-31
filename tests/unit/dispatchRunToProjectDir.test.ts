import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDispatchRunToTool } from "../../src/agent/pi/tools/dispatchRunTo.js";
import { BackgroundTaskRunner } from "../../src/server/runners/BackgroundTaskRunner.js";
import { __resetBackgroundTaskRunnerForTesting } from "../../src/server/runners/backgroundTaskRunnerSingleton.js";

const SINGLETON_KEY = "__dhee_background_task_runner__";

function installRunner(runner: BackgroundTaskRunner): void {
  (globalThis as unknown as Record<string, unknown>)[SINGLETON_KEY] = runner;
}

interface ToolResult {
  details?: {
    status?: string;
    projectDir?: string;
  };
}

describe("dhee_dispatch_run_to stores resolved projectDir on background tasks", () => {
  let projectsDir: string;
  let projectDir: string;
  let wrongProjectsDir: string;
  let originalEnv: string | undefined;
  let runner: BackgroundTaskRunner;
  let releaseExecutor: (() => void) | null = null;

  beforeEach(() => {
    releaseExecutor = null;
    projectsDir = mkdtempSync(join(tmpdir(), "dhee-dispatch-project-dir-"));
    wrongProjectsDir = mkdtempSync(join(tmpdir(), "dhee-dispatch-project-dir-wrong-"));
    projectDir = join(projectsDir, "cyberpunk-2");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "project.json"),
      JSON.stringify({ version: "3.0", name: "cyberpunk-2" }),
      "utf8",
    );
    originalEnv = process.env["dhee_PROJECTS_DIR"];
    process.env["dhee_PROJECTS_DIR"] = projectsDir;

    __resetBackgroundTaskRunnerForTesting();
    runner = new BackgroundTaskRunner(async () => {
      await new Promise<void>((resolve) => {
        releaseExecutor = resolve;
      });
    });
    installRunner(runner);
  });

  afterEach(() => {
    if (releaseExecutor) releaseExecutor();
    if (originalEnv === undefined) delete process.env["dhee_PROJECTS_DIR"];
    else process.env["dhee_PROJECTS_DIR"] = originalEnv;
    __resetBackgroundTaskRunnerForTesting();
    rmSync(projectsDir, { recursive: true, force: true });
    rmSync(wrongProjectsDir, { recursive: true, force: true });
  });

  it("resolves a bare project folder and stores its absolute projectDir", async () => {
    const tool = createDispatchRunToTool({ sessionId: "session-1" });
    const result = (await tool.execute(
      "tc-dispatch",
      { project: "cyberpunk-2" } as never,
      undefined as never,
      undefined as never,
    )) as ToolResult;

    expect(result.details?.status).toBe("started");
    expect(result.details?.projectDir).toBe(projectDir);
    expect(runner.getActive()?.spec.params.projectDir).toBe(projectDir);
  });

  it("preserves explicit projectDir even when dhee_PROJECTS_DIR points elsewhere", async () => {
    process.env["dhee_PROJECTS_DIR"] = wrongProjectsDir;

    const tool = createDispatchRunToTool({ sessionId: "session-1" });
    const result = (await tool.execute(
      "tc-dispatch",
      { project: "cyberpunk-2", projectDir } as never,
      undefined as never,
      undefined as never,
    )) as ToolResult;

    expect(result.details?.status).toBe("started");
    expect(result.details?.projectDir).toBe(projectDir);
    expect(runner.getActive()?.spec.params.projectDir).toBe(projectDir);
  });
});
