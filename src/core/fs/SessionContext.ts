/**
 * SessionContext - Per-session context using AsyncLocalStorage.
 *
 * Replaces the global activeProjectDir singleton with per-session state.
 * Each WebSocket session (or CLI session) gets its own context containing:
 * - sessionId: Unique identifier
 * - projectDir: The active project directory name (e.g., "story.dhee")
 * - fs: The IFileSystem implementation for this session
 * - mode: Whether this is a local or remote session
 *
 * Uses Node.js AsyncLocalStorage for implicit propagation through the
 * async call stack — no need to thread context through every function.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { IFileSystem } from './IFileSystem.js';
import { LocalFileSystem } from './LocalFileSystem.js';

export type SessionMode = 'local' | 'remote';

export interface SessionContext {
  sessionId: string;
  projectDir: string;
  fs: IFileSystem;
  mode: SessionMode;
}

/**
 * AsyncLocalStorage instance that holds the current session context.
 */
const sessionStorage = new AsyncLocalStorage<SessionContext>();

/**
 * Default LocalFileSystem instance, shared across local sessions.
 */
const defaultLocalFs = new LocalFileSystem();

/**
 * Default project directory (backward-compatible with the old global).
 */
let defaultProjectDir = 'default.dhee';

/**
 * Get the current session context.
 * Returns undefined if not running inside a session (e.g., during startup).
 */
export function getCurrentSession(): SessionContext | undefined {
  return sessionStorage.getStore();
}

/**
 * Get the current session context, throwing if none exists.
 */
export function requireSession(): SessionContext {
  const session = sessionStorage.getStore();
  if (!session) {
    throw new Error(
      'No active session context. Code must run inside runInSession() or runInDefaultSession().'
    );
  }
  return session;
}

/**
 * Get the current session's IFileSystem.
 * Falls back to default LocalFileSystem if no session is active
 * (backward-compatible for CLI mode and non-session code paths).
 */
export function getSessionFs(): IFileSystem {
  const session = sessionStorage.getStore();
  return session?.fs ?? defaultLocalFs;
}

/**
 * Get the active project directory for the current session.
 * Falls back to the default project directory if no session context exists
 * (backward-compatible for CLI mode).
 */
export function getSessionProjectDir(): string {
  const session = sessionStorage.getStore();
  return session?.projectDir ?? defaultProjectDir;
}

/**
 * Set the active project directory for the current session.
 * If inside a session context, updates that session.
 * If not in a session context, updates the module-level default
 * (backward-compatible for CLI mode).
 */
export function setSessionProjectDir(dirName: string): void {
  const session = sessionStorage.getStore();
  if (session) {
    // Mutate the session context in place — it's unique per async scope
    (session as { projectDir: string }).projectDir = dirName;
  } else {
    // CLI/fallback mode: set the module-level default
    defaultProjectDir = dirName;
  }
}

/**
 * Run a function inside a session context.
 * All code within the callback (and any async continuations)
 * will see this session via getCurrentSession() / getSessionFs() / getSessionProjectDir().
 */
export function runInSession<T>(context: SessionContext, fn: () => T): T {
  return sessionStorage.run(context, fn);
}

/**
 * Run an async function inside a session context.
 * Node keeps AsyncLocalStorage bound to the returned Promise until it settles.
 */
export function runInSessionAsync<T>(
  context: SessionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return sessionStorage.run(context, fn);
}

/**
 * Create a default local session context.
 * Used for CLI mode or when no explicit session is configured.
 */
export function createLocalSession(
  sessionId: string,
  projectDir?: string,
): SessionContext {
  return {
    sessionId,
    projectDir: projectDir ?? defaultProjectDir,
    fs: defaultLocalFs,
    mode: 'local',
  };
}

/**
 * Create a remote session context.
 * Used when connecting to a remote client over WebSocket.
 */
export function createRemoteSession(
  sessionId: string,
  projectDir: string,
  fs: IFileSystem,
): SessionContext {
  return {
    sessionId,
    projectDir,
    fs,
    mode: 'remote',
  };
}

/**
 * Set the default project directory (for non-session code paths).
 * This is the backward-compatible equivalent of the old setActiveProjectDir().
 */
export function setDefaultProjectDir(dirName: string): void {
  defaultProjectDir = dirName;
}

/**
 * Get the default project directory.
 */
export function getDefaultProjectDir(): string {
  return defaultProjectDir;
}
