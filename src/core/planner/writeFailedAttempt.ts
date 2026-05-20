/**
 * Persist the LLM's last failed output to disk so the user has
 * something to inspect, hand-edit, and recover from.
 *
 * Without this, when a content node like `shot_image_prompt:shot_9`
 * exhausts its validation retries, the broken content is discarded
 * (the run loop returns BEFORE `writeOutput`) and the user is left
 * with no artefact to fix — they'd have to grep `logs/llm-calls.log`,
 * a multi-MB file, to find the bad payload.
 *
 * Strategy: mirror the artifact's resolved output path with a
 * `.failed` suffix. A `.failed.error` companion holds the validation
 * message so the user knows what was wrong without re-reading the
 * notification. Both are plain text, both sit next to where the
 * good file *would* live, so renaming `.failed → .json` after
 * hand-repair is the natural recovery path.
 *
 * Pure-ish: derives path via `getOutputPath` (pure), then does two
 * filesystem writes. Wraps both in try/catch so a write failure
 * doesn't mask the original LLM failure — the run still ends with
 * the validation error as the primary cause.
 */
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DependencyGraphExecutor } from './DependencyGraphExecutor.js';
import type { ExecutionNode } from './types.js';
import { getOutputPath } from './contentResolver.js';

export interface FailedAttemptResult {
  /** Relative path of the written `.failed` file, or null if the
   *  write itself failed (e.g. read-only fs, parent dir missing). */
  contentPath: string | null;
  /** Relative path of the `.failed.error` companion, or null. */
  errorPath: string | null;
}

export function writeFailedAttempt(
  node: ExecutionNode,
  content: string,
  errorMessage: string,
  projectDir: string,
  template: ReturnType<DependencyGraphExecutor['getTemplate']>,
): FailedAttemptResult {
  const baseRel = getOutputPath(node, projectDir, template);
  const contentRel = `${baseRel}.failed`;
  const errorRel = `${baseRel}.failed.error`;
  const contentAbs = join(projectDir, contentRel);
  const errorAbs = join(projectDir, errorRel);

  let contentPath: string | null = null;
  let errorPath: string | null = null;

  try {
    const parent = dirname(contentAbs);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    writeFileSync(contentAbs, content, 'utf-8');
    contentPath = contentRel;
  } catch {
    // Swallow — the original failure is the main signal; we don't
    // want a sidecar-write error to derail the markFailed path.
  }

  try {
    writeFileSync(errorAbs, errorMessage, 'utf-8');
    errorPath = errorRel;
  } catch {
    // Same rationale.
  }

  return { contentPath, errorPath };
}

/**
 * Delete the `.failed` + `.failed.error` sidecars for a node, if present.
 * Called when a previously-failed node successfully recovers (e.g. the
 * LLM's json_repair pass fixed the broken output, or the full retry
 * produced valid content) so the project tree doesn't carry stale
 * "broken" markers next to working artefacts.
 *
 * Idempotent — missing files are silently ignored. I/O errors are
 * swallowed for the same reason as the writer: we don't want sidecar
 * cleanup issues to mask the actual run state.
 */
export function clearFailedAttempt(
  node: ExecutionNode,
  projectDir: string,
  template: ReturnType<DependencyGraphExecutor['getTemplate']>,
): void {
  const baseRel = getOutputPath(node, projectDir, template);
  const contentAbs = join(projectDir, `${baseRel}.failed`);
  const errorAbs = join(projectDir, `${baseRel}.failed.error`);
  for (const p of [contentAbs, errorAbs]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // Swallow.
    }
  }
}
