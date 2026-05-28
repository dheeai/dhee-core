/**
 * buildPiSession — single source of truth for assembling a
 * dhee-flavoured pi-coding-agent session.
 *
 * Two callers:
 *   - drive.ts (Claude-Code-driven CLI test harness)
 *   - the desktop's in-process agent loader (future, BUG-016 proper fix)
 *
 * Splits into two halves:
 *   - `buildPiSessionConfig(opts)` — pure config assembly. Loads the
 *     dhee skill from the package's own skill dir, sets the
 *     read-only built-in tool allowlist, leaves model selection to
 *     pi-coding-agent's defaults (which read from ~/.pi/agent/settings).
 *     Pure enough to unit-test without an LLM.
 *   - `buildPiSession(opts)` — wires the config through
 *     `createAgentSession` and returns the live session.
 *
 * Skill loading: we use `skillsOverride` on DefaultResourceLoader to
 * explicitly inject the package-shipped skill. We deliberately do NOT
 * rely on the standard `.pi/skills/` discovery from cwd, because cwd
 * varies (the desktop's cwd is the user's project dir, not the
 * dhee-core package dir).
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  loadSkillsFromDir,
  SessionManager,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from '@mariozechner/pi-coding-agent';

/** The skill name (from the YAML frontmatter `name:` field) we inject. */
export const DHEE_SKILL_NAME = 'dhee';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, 'skill');

/** Read-only built-in tools. No bash / edit / write. */
const READONLY_BUILTINS = ['read', 'ls', 'grep', 'find'] as const;

export interface BuildPiSessionOptions {
  /**
   * Pi SessionManager. Caller decides in-memory vs file-backed.
   * Required so we don't accidentally write transcripts where the
   * caller didn't want them.
   */
  sessionManager: ReturnType<typeof SessionManager.inMemory>;
  /** Working directory for the agent. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Additional custom tool names to include in the allowlist. The
   * tools themselves must be registered via an extensionFactory
   * (passed in `extensionFactories`) and ALSO appear here, because
   * pi's `tools` option is a strict allowlist by name (the well-known
   * "Landmine 1": tools missing from the allowlist are silently
   * blocked even if registered).
   */
  customToolNames?: string[];
  /**
   * Extension factories — used to register custom dhee tools. Phase A
   * leaves this empty. Phase B will provide the 5 tools v1.
   */
  extensionFactories?: ConstructorParameters<typeof DefaultResourceLoader>[0]['extensionFactories'];
}

/**
 * Build the full pi-coding-agent config without booting the session.
 * Splitting this out makes the factory unit-testable.
 */
export async function buildPiSessionConfig(
  opts: BuildPiSessionOptions,
): Promise<CreateAgentSessionOptions> {
  const cwd = opts.cwd ?? process.cwd();
  const customToolNames = opts.customToolNames ?? [];

  // Load our packaged skill once and inject it via skillsOverride.
  // We disable default discovery (which would also scan cwd/.pi/skills
  // and ~/.pi/agent/skills) by hijacking `current` and replacing with
  // exactly our skill set. Callers who want extra skills can layer
  // them on a subsequent override.
  const packagedSkills = loadSkillsFromDir({
    dir: SKILL_DIR,
    source: 'dhee-core/src/agent/pi/skill',
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    skillsOverride: () => packagedSkills,
    extensionFactories: opts.extensionFactories,
  });
  await resourceLoader.reload();

  return {
    cwd,
    resourceLoader,
    tools: [...READONLY_BUILTINS, ...customToolNames],
    sessionManager: opts.sessionManager,
  };
}

/** Boot a dhee-flavoured pi-coding-agent session. */
export async function buildPiSession(
  opts: BuildPiSessionOptions,
): Promise<CreateAgentSessionResult> {
  const cfg = await buildPiSessionConfig(opts);
  return createAgentSession(cfg);
}
