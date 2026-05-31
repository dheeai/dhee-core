import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dheeReadArtifact } from "../../src/agent/pi/tools/readArtifact.js";

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: {
    projectDir?: string;
    resolvedPath?: string;
    bytes?: number;
  };
}

async function readArtifact(params: unknown): Promise<ToolResult> {
  return (await dheeReadArtifact.execute(
    "tc-read-artifact",
    params as never,
    undefined as never,
    undefined as never,
  )) as ToolResult;
}

describe("dhee_read_artifact resolves bare and explicit project dirs", () => {
  let projectsDir: string;
  let bareProjectDir: string;
  let legacyProjectDir: string;
  let wrongProjectsDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), "dhee-read-artifact-"));
    wrongProjectsDir = mkdtempSync(join(tmpdir(), "dhee-read-artifact-wrong-"));
    bareProjectDir = join(projectsDir, "cyberpunk-2");
    legacyProjectDir = join(projectsDir, "legacy.dhee");

    mkdirSync(bareProjectDir, { recursive: true });
    mkdirSync(legacyProjectDir, { recursive: true });
    writeFileSync(
      join(bareProjectDir, "project.json"),
      JSON.stringify({ version: "3.0", name: "cyberpunk-2" }),
      "utf8",
    );
    writeFileSync(
      join(legacyProjectDir, "project.json"),
      JSON.stringify({ version: "3.0", name: "legacy" }),
      "utf8",
    );
    writeFileSync(join(projectsDir, "outside.txt"), "outside", "utf8");

    originalEnv = process.env["dhee_PROJECTS_DIR"];
    process.env["dhee_PROJECTS_DIR"] = projectsDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env["dhee_PROJECTS_DIR"];
    else process.env["dhee_PROJECTS_DIR"] = originalEnv;
    rmSync(projectsDir, { recursive: true, force: true });
    rmSync(wrongProjectsDir, { recursive: true, force: true });
  });

  it("reads project.json from a bare project folder", async () => {
    const result = await readArtifact({ project: "cyberpunk-2", path: "project.json" });

    expect(result.content[0]?.text).toContain("cyberpunk-2");
    expect(result.details?.projectDir).toBe(bareProjectDir);
    expect(result.details?.resolvedPath).toBe(join(bareProjectDir, "project.json"));
    expect(result.details?.bytes).toBeGreaterThan(0);
  });

  it("reads project.json from a legacy .dhee folder", async () => {
    const result = await readArtifact({ project: "legacy", path: "project.json" });

    expect(result.content[0]?.text).toContain("legacy");
    expect(result.details?.projectDir).toBe(legacyProjectDir);
    expect(result.details?.resolvedPath).toBe(join(legacyProjectDir, "project.json"));
  });

  it("rejects paths that escape the project folder", async () => {
    await expect(
      readArtifact({ project: "cyberpunk-2", path: "../outside.txt" }),
    ).rejects.toThrow(/outside project/i);
  });

  it("accepts explicit projectDir even when dhee_PROJECTS_DIR points elsewhere", async () => {
    process.env["dhee_PROJECTS_DIR"] = wrongProjectsDir;

    const result = await readArtifact({
      project: "cyberpunk-2",
      projectDir: bareProjectDir,
      path: "project.json",
    });

    expect(result.content[0]?.text).toContain("cyberpunk-2");
    expect(result.details?.projectDir).toBe(bareProjectDir);
    expect(result.details?.resolvedPath).toBe(join(bareProjectDir, "project.json"));
  });
});
