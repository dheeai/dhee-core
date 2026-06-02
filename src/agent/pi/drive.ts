/**
 * drive — Claude-Code-driven test harness for the dhee pi-agent.
 *
 * Three subcommands:
 *
 *   drive start
 *     Boots a fresh pi session (writes its JSONL header to disk).
 *     Records the (sessionId → sessionFile) mapping in sessionStore
 *     under the `_drive` project slug. Prints JSON.
 *
 *   drive send <sessionId> "<msg>"
 *     Opens the recorded session, prompts the agent, captures
 *     text deltas + tool calls, prints JSON.
 *
 *   drive list
 *     Dumps the recorded `_drive` sessions as JSON.
 *
 * Why a file-backed driver, not pi's RPC mode: Claude Code's Bash
 * tool is one-shot, so we can't keep a long-lived RPC subprocess
 * across turns. File-backed sessions let each Bash call be
 * self-contained while state persists between them. See
 * /Users/ganaraj/Projects/aim-scoring-agent/DRIVING_PI_FROM_CLAUDE_CODE.md
 * for the full rationale (this driver follows the same shape).
 *
 * For testability the three commands are exported as pure async
 * functions taking a `DriveDeps` (with `buildSession` injectable).
 * The CLI shim at the bottom of the file calls them with the real
 * dependency set.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { SessionManager } from '@mariozechner/pi-coding-agent';
import { buildPiSession, type BuildPiSessionOptions } from './buildSession.js';
import { ensureDir, getPiSessionsDir } from './paths.js';
import { runAgentTurn } from './runTurn.js';
import { loadDevEnv } from '../../server/loadDevEnv.js';
import {
  findSession,
  listSessionsForProject,
  recordSession,
  touchSession,
  type SessionRecord,
} from './sessionStore.js';

export const DRIVE_PROJECT_SLUG = '_drive';

/** Injectable dependencies — `buildSession` is replaced in tests. */
export interface DriveDeps {
  buildSession: typeof buildPiSession;
}

const DEFAULT_DEPS: DriveDeps = {
  buildSession: buildPiSession,
};

/**
 * Resolve (provider, modelId, apiKey) from process.env so the CLI
 * driver can pass an explicit model triple to buildPiSession. Without
 * this, pi-coding-agent falls back to whatever ~/.pi/agent/settings.json
 * names — which is usually empty on dev boxes that haven't run
 * `pi /login` — and session.prompt() either errors with "No API key
 * found" or returns no content.
 *
 * Mirrors the desktop's `resolvePiModelFromSettings` mapping but
 * sourced from env, not Settings UI:
 *   - LLM_PROVIDER=gemini → google + GEMINI_MODEL + GOOGLE_API_KEY
 *   - OPENAI_BASE_URL contains openrouter.ai → openrouter + OPENAI_MODEL + OPENAI_API_KEY
 *   - otherwise → openai + OPENAI_MODEL + OPENAI_API_KEY
 *
 * Returns null when no usable triple can be assembled — caller falls
 * back to pi's settings.json discovery (legacy behavior).
 */
function resolvePiModelFromEnv(env: NodeJS.ProcessEnv = process.env): {
  modelProvider: string;
  modelId: string;
  apiKey: string;
} | null {
  const provider = (env['LLM_PROVIDER'] ?? '').trim().toLowerCase();
  if (provider === 'gemini') {
    const modelId = (env['GEMINI_MODEL'] ?? '').trim();
    const apiKey = (env['GOOGLE_API_KEY'] ?? '').trim();
    if (modelId && apiKey) return { modelProvider: 'google', modelId, apiKey };
    return null;
  }
  const baseUrl = (env['OPENAI_BASE_URL'] ?? '').trim();
  const modelId = (env['OPENAI_MODEL'] ?? '').trim();
  const apiKey = (env['OPENAI_API_KEY'] ?? '').trim();
  if (!modelId || !apiKey) return null;
  const isOpenRouter = /openrouter\.ai/i.test(baseUrl);
  return {
    modelProvider: isOpenRouter ? 'openrouter' : 'openai',
    modelId,
    apiKey,
  };
}

/**
 * Build session options that compose every CLI-side default — env
 * load, model+key triple, sessions dir for persistence — so cmdStart
 * and cmdSend share the same wiring instead of drifting.
 */
function buildSessionOptsFromEnv(
  sm: ReturnType<typeof SessionManager.open> | ReturnType<typeof SessionManager.create>,
  cwd: string,
): BuildPiSessionOptions {
  // Surface dhee-core/.env into process.env. Safe + idempotent: already-
  // set keys are preserved.
  loadDevEnv();
  const model = resolvePiModelFromEnv();
  return {
    sessionManager: sm,
    cwd,
    ...(model ?? {}),
  };
}

export interface CmdStartOk {
  ok: true;
  sessionId: string;
  sessionFile: string;
  projectSlug: string;
}
export interface CmdErr {
  ok: false;
  error: string;
}
export interface ToolCallSummary {
  name: string;
}
export interface CmdSendOk {
  ok: true;
  sessionId: string;
  assistant_text: string;
  tool_calls: ToolCallSummary[];
}
export interface CmdListOk {
  ok: true;
  sessions: SessionRecord[];
}

/** drive start — boot a fresh session and record it. */
export async function cmdStart(deps: DriveDeps = DEFAULT_DEPS): Promise<CmdStartOk | CmdErr> {
  const sessionsDir = getPiSessionsDir(DRIVE_PROJECT_SLUG);
  ensureDir(sessionsDir);

  const cwd = process.cwd();
  // SessionManager.create assigns its own session id + file path. We
  // capture both AFTER buildSession returns (the JSONL header is
  // written during session boot).
  const sm = SessionManager.create(cwd, sessionsDir);

  let built;
  try {
    built = await deps.buildSession(buildSessionOptsFromEnv(sm, cwd));
  } catch (err) {
    return { ok: false, error: `buildSession failed: ${(err as Error)?.message ?? String(err)}` };
  }

  const session = built.session as unknown as {
    sessionId?: string;
    sessionFile?: string;
    dispose?: () => void;
  };
  const sessionId = session.sessionId;
  const sessionFile = session.sessionFile;
  if (!sessionId || !sessionFile) {
    return { ok: false, error: 'session returned no sessionId/sessionFile' };
  }
  // If for some reason the boot didn't materialize a file, leave a
  // placeholder so SessionManager.open() on the next send doesn't
  // ENOENT. This shouldn't trip in practice with the real SDK.
  if (!existsSync(sessionFile)) {
    writeFileSync(sessionFile, '', 'utf8');
  }
  session.dispose?.();

  recordSession(sessionId, DRIVE_PROJECT_SLUG, sessionFile);

  return { ok: true, sessionId, sessionFile, projectSlug: DRIVE_PROJECT_SLUG };
}

/**
 * drive send — open the recorded session, prompt the agent, capture
 * text deltas + tool calls.
 */
export async function cmdSend(
  sessionId: string,
  msg: string,
  deps: DriveDeps = DEFAULT_DEPS,
): Promise<CmdSendOk | CmdErr> {
  const rec = findSession(sessionId);
  if (!rec) return { ok: false, error: `unknown session: ${sessionId}` };

  const sm = SessionManager.open(rec.sessionFile);

  let built;
  try {
    built = await deps.buildSession(buildSessionOptsFromEnv(sm, process.cwd()));
  } catch (err) {
    return { ok: false, error: `buildSession failed: ${(err as Error)?.message ?? String(err)}` };
  }

  const result = await runAgentTurn(
    built.session as never,
    msg,
    // CLI is one-shot — dispose so the JSONL handle releases.
  );

  if (!result.ok) {
    return { ok: false, error: `prompt failed: ${result.error}` };
  }

  touchSession(sessionId);

  return {
    ok: true,
    sessionId,
    assistant_text: result.assistant_text,
    tool_calls: result.tool_calls,
  };
}

/** drive list — recorded drive sessions, most-recent first. */
export async function cmdList(): Promise<CmdListOk> {
  const sessions = listSessionsForProject(DRIVE_PROJECT_SLUG);
  return { ok: true, sessions };
}

/* ─── CLI shim ─── */

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const print = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');

  if (cmd === 'start') {
    const out = await cmdStart();
    print(out);
    if (!out.ok) process.exit(1);
  } else if (cmd === 'send') {
    const id = rest[0];
    const msg = rest.slice(1).join(' ');
    if (!id || !msg) {
      process.stderr.write('Usage: drive send <sessionId> "<message>"\n');
      process.exit(2);
    }
    const out = await cmdSend(id, msg);
    print(out);
    if (!out.ok) process.exit(1);
  } else if (cmd === 'list') {
    print(await cmdList());
  } else {
    process.stderr.write('Usage: drive start | send <id> "<msg>" | list\n');
    process.exit(2);
  }
}

// Run only when invoked directly (not when imported by tests).
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('drive.ts') === true ||
  process.argv[1]?.endsWith('drive.js') === true;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`drive: fatal: ${(err as Error)?.message ?? String(err)}\n`);
    process.exit(1);
  });
}
