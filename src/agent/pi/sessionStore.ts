/**
 * sessionStore — small disk-backed index for resuming chat sessions.
 *
 * Pi-coding-agent owns the actual conversation transcript (an
 * append-only JSONL session file). This module only tracks the
 * mapping needed for resume:
 *
 *   <sessionId>  →  { projectSlug, sessionFile, lastActivity }
 *
 * One global index file:
 *
 *   ~/.dhee/pi-sessions/sessions-index.json
 *     Keyed by sessionId. Per-project lookups filter on `projectSlug`.
 *
 * The transcripts themselves live at:
 *
 *   ~/.dhee/pi-sessions/<projectSlug>/<sessionId>.jsonl
 *
 * (`projectSlug` for ambient sessions before a project is focused is
 * the literal string `_default`.) Rewritten atomically (write tmp +
 * rename) since it's touched on every connect / message.
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDir, getPiSessionsDir } from "./paths.js";

export const AMBIENT_PROJECT_SLUG = "_default";

export interface SessionRecord {
  sessionId: string;
  projectSlug: string;
  sessionFile: string;
  createdAt: number;
  lastActivity: number;
}

interface GlobalIndex {
  version: 1;
  sessions: Record<string, SessionRecord>;
}

const GLOBAL_INDEX_NAME = "sessions-index.json";

function globalIndexPath(): string {
  return resolve(getPiSessionsDir(), GLOBAL_INDEX_NAME);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt index — fall back rather than crash. Data loss is bounded
    // to the resume table; pi-coding-agent's JSONL files are unaffected.
    return fallback;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  ensureDir(resolve(path, ".."));
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, path);
}

function loadGlobal(): GlobalIndex {
  return readJson<GlobalIndex>(globalIndexPath(), { version: 1, sessions: {} });
}

function saveGlobal(idx: GlobalIndex): void {
  writeJsonAtomic(globalIndexPath(), idx);
}

/**
 * Compute the JSONL path a brand-new session should write to.
 * The file itself is created/owned by pi-coding-agent's SessionManager;
 * we only decide where it lives.
 */
export function sessionFilePathFor(sessionId: string, projectSlug: string): string {
  return join(getPiSessionsDir(projectSlug), `${sessionId}.jsonl`);
}

/**
 * Record a newly-created session so future resumes can find it.
 * Idempotent: re-recording the same id updates lastActivity (and
 * optionally the projectSlug, e.g. when the user focuses a project
 * on an ambient session) in place.
 */
export function recordSession(
  sessionId: string,
  projectSlug: string,
  sessionFile: string,
): SessionRecord {
  const now = Date.now();
  const global = loadGlobal();
  const existing = global.sessions[sessionId];
  const record: SessionRecord = existing
    ? { ...existing, projectSlug, sessionFile, lastActivity: now }
    : { sessionId, projectSlug, sessionFile, createdAt: now, lastActivity: now };
  global.sessions[sessionId] = record;
  saveGlobal(global);
  return record;
}

/** Bump lastActivity on an existing record. No-op if unknown. */
export function touchSession(sessionId: string): void {
  const global = loadGlobal();
  const record = global.sessions[sessionId];
  if (!record) return;
  record.lastActivity = Date.now();
  global.sessions[sessionId] = record;
  saveGlobal(global);
}

/**
 * Update the projectSlug of an existing session. Used when a user focuses
 * a project on an ambient session — we keep the JSONL where it was created
 * (moving it would break pi-coding-agent's open file handles), but
 * remember the latest project so per-project resume queries see it.
 */
export function setSessionProject(sessionId: string, projectSlug: string): void {
  const global = loadGlobal();
  const record = global.sessions[sessionId];
  if (!record || record.projectSlug === projectSlug) return;
  record.projectSlug = projectSlug;
  record.lastActivity = Date.now();
  global.sessions[sessionId] = record;
  saveGlobal(global);
}

export function findSession(sessionId: string): SessionRecord | null {
  const global = loadGlobal();
  const record = global.sessions[sessionId];
  if (!record) return null;
  // Defensive: if the JSONL has been wiped manually (e.g. user
  // cleared ~/.dhee), don't pretend we can resume.
  if (!existsSync(record.sessionFile)) return null;
  return record;
}

export function mostRecentForProject(projectSlug: string): SessionRecord | null {
  const global = loadGlobal();
  let best: SessionRecord | null = null;
  for (const r of Object.values(global.sessions)) {
    if (r.projectSlug !== projectSlug) continue;
    if (!existsSync(r.sessionFile)) continue;
    if (!best || r.lastActivity > best.lastActivity) best = r;
  }
  return best;
}

/** Most recent session across all projects. */
export function mostRecentSession(): SessionRecord | null {
  const global = loadGlobal();
  let best: SessionRecord | null = null;
  for (const r of Object.values(global.sessions)) {
    if (!existsSync(r.sessionFile)) continue;
    if (!best || r.lastActivity > best.lastActivity) best = r;
  }
  return best;
}

export function listSessionsForProject(projectSlug: string): SessionRecord[] {
  const global = loadGlobal();
  return Object.values(global.sessions)
    .filter(r => r.projectSlug === projectSlug && existsSync(r.sessionFile))
    .sort((a, b) => b.lastActivity - a.lastActivity);
}

/**
 * Forget a session in the index. Does NOT delete the JSONL — that's
 * pi-coding-agent's data and may be useful later. Use purgeSessionHistory
 * for the explicit "clear chat" action.
 */
export function forgetSession(sessionId: string): void {
  const global = loadGlobal();
  if (!global.sessions[sessionId]) return;
  delete global.sessions[sessionId];
  saveGlobal(global);
}

/**
 * Hard-delete: forget the session AND remove the JSONL.
 * Used by the explicit "clear chat history" user action.
 */
export function purgeSessionHistory(sessionId: string): void {
  const global = loadGlobal();
  const record = global.sessions[sessionId];
  if (!record) return;
  try {
    if (existsSync(record.sessionFile)) rmSync(record.sessionFile);
  } catch {
    // Best-effort; the index forget below still runs.
  }
  forgetSession(sessionId);
}

/** Test helper: ensure the per-project sessions dir exists. */
export function ensureProjectSessionsDir(projectSlug: string): string {
  const dir = getPiSessionsDir(projectSlug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Test helper: list raw session JSONL files for a project. */
export function listProjectJsonlFiles(projectSlug: string): string[] {
  const dir = getPiSessionsDir(projectSlug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith(".jsonl"));
}
