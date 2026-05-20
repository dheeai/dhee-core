/**
 * Server discovery file — the contract that lets external agents
 * (pi-agent, openclaw, anything that can read a JSON file) find
 * the running dhee-core HTTP server without knowing the random
 * port the desktop allocated for it.
 *
 * On start, the server writes `~/.dhee/server.json` with its url,
 * port, pid, and version. On graceful shutdown, the file is removed.
 * If a stale file is left behind by a crash, the next start
 * overwrites it.
 *
 * File mode is 0600 — only the running user can read it. There is no
 * auth on local-mode endpoints, so possession of the file's contents
 * is the trust boundary on shared machines. (For multi-user or remote
 * setups, add a token field and require Bearer auth on the server
 * side; that is a future extension.)
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

export interface DiscoveryFileContent {
  /** Full base URL clients should hit, e.g. "http://127.0.0.1:54321". */
  url: string;
  host: string;
  port: number;
  pid: number;
  /** Server mode at the time the file was written. */
  mode?: 'local' | 'remote' | 'auto';
  /** dhee-core package version, useful for compatibility checks. */
  version?: string;
  /** Unix-ms timestamp the server wrote the file. */
  startedAt: number;
}

export interface WriteDiscoveryOptions {
  /** Absolute path; defaults to defaultDiscoveryPath() if omitted. */
  path?: string;
  host: string;
  port: number;
  pid: number;
  mode?: 'local' | 'remote' | 'auto';
  version?: string;
}

/**
 * Resolve the canonical discovery file path. Honours
 * `dhee_DISCOVERY_FILE` if set; otherwise falls back to
 * `~/.dhee/server.json`.
 */
export function defaultDiscoveryPath(): string {
  const override = process.env['dhee_DISCOVERY_FILE'];
  if (override && override.trim()) return override.trim();
  return join(homedir(), '.dhee', 'server.json');
}

/**
 * Write the discovery file. Creates parent dirs if needed and sets
 * mode 0600 so other users on the same machine cannot read it.
 */
export function writeDiscoveryFile(opts: WriteDiscoveryOptions): string {
  const path = opts.path ?? defaultDiscoveryPath();
  mkdirSync(dirname(path), { recursive: true });

  const content: DiscoveryFileContent = {
    url: `http://${opts.host}:${opts.port}`,
    host: opts.host,
    port: opts.port,
    pid: opts.pid,
    startedAt: Date.now(),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.version !== undefined ? { version: opts.version } : {}),
  };

  writeFileSync(path, JSON.stringify(content, null, 2), { encoding: 'utf-8' });
  // chmod separately because writeFileSync's mode parameter only applies on
  // create — if the file already existed, its mode was unchanged. We always
  // want 0600.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows or oddball filesystems may not support chmod; best-effort.
  }
  return path;
}

/**
 * Delete the discovery file. No-op if it doesn't exist; survives
 * permission errors silently because shutdown shouldn't fail on this.
 */
export function removeDiscoveryFile(path: string = defaultDiscoveryPath()): void {
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // Best-effort. A leftover file just gets overwritten on next start.
  }
}

/**
 * Read and parse the discovery file. Returns null if missing or
 * unparseable — callers should check and fall back appropriately.
 */
export function readDiscoveryFile(path: string = defaultDiscoveryPath()): DiscoveryFileContent | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.url !== 'string' || typeof parsed?.port !== 'number') return null;
    return parsed as DiscoveryFileContent;
  } catch {
    return null;
  }
}

/**
 * Check whether a discovery file points at a process that no longer
 * exists. The desktop hard-killing dhee-core (force quit) leaves a
 * stale file; clients can `kill(pid, 0)` (signal 0 doesn't actually
 * deliver a signal — just tests existence) to detect this and ignore
 * the file rather than connecting to a port that's now silent or owned
 * by something else.
 *
 * Returns true if the file is missing or its pid is dead.
 */
export function isDiscoveryFileStale(path: string = defaultDiscoveryPath()): boolean {
  const content = readDiscoveryFile(path);
  if (!content) return true;
  try {
    process.kill(content.pid, 0);
    return false;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but we lack perms (still alive).
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false;
    return true;
  }
}
