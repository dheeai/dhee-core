/**
 * Regression: when dhee-core runs embedded inside dhee-desktop's
 * Electron main process, no `.env` is loaded — the embed entry
 * (`server/manager.ts`) deliberately avoids `dotenv/config` because
 * the desktop owns env management via AppSettings.
 *
 * But in development, the user's API keys, ComfyUI URL, and tier
 * routing config live in `dhee-core/.env`. Without a way to load
 * them, the embedded core errors out with "No API key found for X"
 * even though the .env right next door has the key.
 *
 * `loadDevEnv()` is the bridge: dhee-desktop's main process calls
 * it in dev mode to surface the .env into process.env BEFORE
 * AppSettings overrides anything. It must:
 *   - read `.env` from the dhee-core package root
 *   - NOT overwrite vars that are already set (so a packaged build's
 *     env, or AppSettings-derived vars, win)
 *   - return which vars it actually wrote (debug visibility)
 *
 * Bug surfaced 2026-05-01 in the embedded chat: redo task failed
 * with "No API key found for openrouter" because tier routing
 * (`LLM_TIER_HEAVY_PROVIDER=openrouter`) needs `OPENROUTER_API_KEY`
 * which only the .env had.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadDevEnv } from "../../src/server/loadDevEnv.js";

describe("loadDevEnv", () => {
  let fakeRoot: string;
  const trackedKeys = ["__TEST_KEY_A", "__TEST_KEY_B", "__TEST_KEY_C", "__TEST_KEY_D"];

  beforeEach(() => {
    fakeRoot = mkdtempSync(join(tmpdir(), "dhee-core-loaddevenv-"));
    writeFileSync(
      join(fakeRoot, "package.json"),
      JSON.stringify({ name: "dhee-core", version: "0.0.0" }),
    );
    for (const k of trackedKeys) delete process.env[k];
  });

  afterEach(() => {
    for (const k of trackedKeys) delete process.env[k];
    rmSync(fakeRoot, { recursive: true, force: true });
  });

  it("populates process.env from .env at the given root", () => {
    writeFileSync(
      join(fakeRoot, ".env"),
      "__TEST_KEY_A=alpha\n__TEST_KEY_B=beta\n",
    );

    const result = loadDevEnv(fakeRoot);

    expect(result.loaded).toBe(true);
    expect(result.path).toBe(join(fakeRoot, ".env"));
    expect(result.vars).toEqual(expect.arrayContaining(["__TEST_KEY_A", "__TEST_KEY_B"]));
    expect(process.env["__TEST_KEY_A"]).toBe("alpha");
    expect(process.env["__TEST_KEY_B"]).toBe("beta");
  });

  it("does NOT overwrite env vars that are already set", () => {
    writeFileSync(
      join(fakeRoot, ".env"),
      "__TEST_KEY_A=from_dotenv\n__TEST_KEY_B=from_dotenv\n",
    );
    process.env["__TEST_KEY_A"] = "from_caller";

    const result = loadDevEnv(fakeRoot);

    expect(process.env["__TEST_KEY_A"]).toBe("from_caller");
    expect(process.env["__TEST_KEY_B"]).toBe("from_dotenv");
    // The skipped key must NOT appear in `vars` since loadDevEnv didn't write it.
    expect(result.vars).not.toContain("__TEST_KEY_A");
    expect(result.vars).toContain("__TEST_KEY_B");
  });

  it("treats an empty-string env var as 'set' (does not overwrite)", () => {
    // applyEnvFromSettings on the desktop side currently writes empty
    // strings when the user hasn't configured a key. After the
    // companion desktop fix that's no longer the case, but loadDevEnv
    // must still respect any non-undefined value already present.
    writeFileSync(join(fakeRoot, ".env"), "__TEST_KEY_C=from_dotenv\n");
    process.env["__TEST_KEY_C"] = "";

    loadDevEnv(fakeRoot);

    expect(process.env["__TEST_KEY_C"]).toBe("");
  });

  it("returns loaded=false when no .env exists at the root", () => {
    const result = loadDevEnv(fakeRoot);
    expect(result.loaded).toBe(false);
    expect(result.path).toBe(null);
    expect(result.vars).toEqual([]);
  });

  it("always returns the root path so embedded hosts can chdir to it", () => {
    // Both with and without .env present.
    const noEnv = loadDevEnv(fakeRoot);
    expect(noEnv.root).toBe(fakeRoot);

    writeFileSync(join(fakeRoot, ".env"), "__TEST_KEY_D=v\n");
    const withEnv = loadDevEnv(fakeRoot);
    expect(withEnv.root).toBe(fakeRoot);
  });

  it("returns projectsDir = dhee_PROJECTS_DIR override when set", () => {
    const original = process.env["dhee_PROJECTS_DIR"];
    process.env["dhee_PROJECTS_DIR"] = "/some/explicit/projects/path";
    try {
      const result = loadDevEnv(fakeRoot);
      expect(result.projectsDir).toBe("/some/explicit/projects/path");
    } finally {
      if (original === undefined) delete process.env["dhee_PROJECTS_DIR"];
      else process.env["dhee_PROJECTS_DIR"] = original;
    }
  });

  it("returns projectsDir = ~/dhee when dhee_PACKAGED=1 (packaged desktop)", () => {
    const originalPkg = process.env["dhee_PACKAGED"];
    const originalDir = process.env["dhee_PROJECTS_DIR"];
    delete process.env["dhee_PROJECTS_DIR"];
    process.env["dhee_PACKAGED"] = "1";
    try {
      const result = loadDevEnv(fakeRoot);
      // Should end with /dhee (homedir prefix varies per machine).
      expect(result.projectsDir).toMatch(/\/dhee$/);
    } finally {
      if (originalPkg === undefined) delete process.env["dhee_PACKAGED"];
      else process.env["dhee_PACKAGED"] = originalPkg;
      if (originalDir !== undefined) process.env["dhee_PROJECTS_DIR"] = originalDir;
    }
  });

  it("returns projectsDir = dhee-core package root in dev mode (not packaged, no override)", () => {
    const originalPkg = process.env["dhee_PACKAGED"];
    const originalDir = process.env["dhee_PROJECTS_DIR"];
    delete process.env["dhee_PACKAGED"];
    delete process.env["dhee_PROJECTS_DIR"];
    try {
      const result = loadDevEnv(fakeRoot);
      // In dev mode, getProjectsDir() returns the real REPO_ROOT (the
      // dhee-core package this module is loaded from), NOT the
      // fakeRoot we passed for .env reading. The test only asserts
      // that the returned path is a real directory containing
      // dhee-core's package.json — that's the contract.
      const pkg = JSON.parse(readFileSync(join(result.projectsDir, "package.json"), "utf8")) as { name?: string };
      expect(pkg.name).toBe("dhee-core");
    } finally {
      if (originalPkg !== undefined) process.env["dhee_PACKAGED"] = originalPkg;
      if (originalDir !== undefined) process.env["dhee_PROJECTS_DIR"] = originalDir;
    }
  });
});
