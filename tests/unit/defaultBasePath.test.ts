/**
 * Regression: dhee-core's filesystem helpers (loadProject,
 * projectExists, projectPath, …) default `basePath` to
 * `process.cwd()`. When dhee-core is embedded inside Electron's
 * main process, cwd points at the host's launch dir — typically
 * NOT where projects live.
 *
 * Workaround: read the `dhee_PROJECTS_DIR` env var first; fall
 * back to `process.cwd()`. The embedded host (dhee-desktop) sets
 * this env in `dheeCoreManager.start()` so projectFileIO sees the
 * right base in both dev (REPO_ROOT) and packaged (~/dhee) modes.
 *
 * Bug surfaced 2026-05-01: focusSessionProject → loadProject('foo.dhee')
 * resolved to `dhee-desktop/foo.dhee/...` and ENOENT'd.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { defaultBasePath } from "../../src/tasks/video/workflow/projectFileIO.js";

const ENV_KEY = "dhee_PROJECTS_DIR";

describe("defaultBasePath", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("returns dhee_PROJECTS_DIR when set", () => {
    process.env[ENV_KEY] = "/some/projects/dir";
    expect(defaultBasePath()).toBe("/some/projects/dir");
  });

  it("falls back to process.cwd() when dhee_PROJECTS_DIR is unset", () => {
    delete process.env[ENV_KEY];
    expect(defaultBasePath()).toBe(process.cwd());
  });

  it("falls back to process.cwd() when dhee_PROJECTS_DIR is empty", () => {
    process.env[ENV_KEY] = "";
    expect(defaultBasePath()).toBe(process.cwd());
  });
});
