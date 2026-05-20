import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from `metaUrl` (typically `import.meta.url`) until we find
 * the dhee-core package's own `package.json`. Robust against being
 * called from either `src/...` (vitest, tsx) or `dist/server/manager.js`
 * (bundled CJS/ESM output) — the depth differs but the package
 * boundary is unambiguous via `name === "dhee-core"`.
 *
 * Used to resolve repo-relative resources (orchestrator prompt,
 * subagent prompts, prompt-skill markdown). The previous hardcoded
 * `../../..` worked from source but pointed one level too high
 * when bundled, ENOENT'ing on the orchestrator prompt.
 */
export function finddheeCoreRoot(metaUrl: string): string {
  let dir = dirname(fileURLToPath(metaUrl));
  // Cap the walk at filesystem root — defensive guard, not a real loop bound.
  for (let i = 0; i < 64; i += 1) {
    const pkgPath = resolve(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
        if (pkg.name === "dhee-core") {
          return resolve(dir);
        }
      } catch {
        // ignore unreadable / non-JSON package.json — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `finddheeCoreRoot: could not locate dhee-core package.json walking up from ${metaUrl}`,
  );
}

const REPO_ROOT = finddheeCoreRoot(import.meta.url);

function isPackaged(): boolean {
  return process.env["dhee_PACKAGED"] === "1" || process.env["dhee_PACKAGED"] === "true";
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

export function getProjectsDir(): string {
  const override = process.env["dhee_PROJECTS_DIR"];
  if (override) return resolve(expandTilde(override));
  if (isPackaged()) {
    return resolve(homedir(), "dhee");
  }
  return REPO_ROOT;
}

export function getdheeConfigDir(): string {
  const override = process.env["dhee_CONFIG_DIR"];
  if (override) return resolve(expandTilde(override));
  return resolve(homedir(), ".dhee");
}

/**
 * Root directory for persisted pi-coding-agent chat sessions.
 * Sessions are scoped by project slug so each dhee project has its
 * own append-only JSONL transcript per chat session.
 *
 * Layout: <root>/<projectSlug>/<sessionId>.jsonl
 *
 * Override via DHEE_PI_SESSIONS_DIR (mostly for tests).
 */
export function getPiSessionsDir(projectSlug?: string): string {
  const override = process.env["DHEE_PI_SESSIONS_DIR"];
  const root = override
    ? resolve(expandTilde(override))
    : resolve(getdheeConfigDir(), "pi-sessions");
  return projectSlug ? resolve(root, projectSlug) : root;
}

export function ensureDir(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
  return path;
}

export { REPO_ROOT };
