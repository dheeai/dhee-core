/**
 * Persist a node's broken LLM output to disk so the user can inspect
 * exactly what the model produced when validation + repair + retry all
 * failed.
 *
 * Today, when an LLM call's JSON fails validation and the repair +
 * full-retry cycle also fails, the executor calls `markFailed` and
 * moves on — the broken content lives ONLY in `logs/llm-calls.log`.
 * That's hard to find: the user sees the failure status in the desktop
 * UI but has no path to the actual output to inspect, edit, or copy.
 *
 * `writeFailedAttempt` writes two sidecars next to the artifact's
 * expected output path:
 *
 *   {outputPath}.failed         — the raw broken content the LLM produced
 *   {outputPath}.failed.error   — the validation error message
 *
 * The desktop's Content tab surfaces these as a "Failures" section so
 * the user can read them in-place. `clearFailedAttempt` removes both
 * sidecars when the node next succeeds.
 *
 * Pure I/O, no executor coupling — takes the resolved path directly.
 */
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';

export interface FailedAttemptSidecar {
  /** Relative path to the `.failed` content file, or null if writing failed. */
  contentPath: string | null;
  /** Relative path to the `.failed.error` companion, or null if writing failed. */
  errorPath: string | null;
}

/**
 * Write the broken content + error message to disk next to the
 * artifact's expected output. Both paths are project-relative.
 *
 * @param projectDir Absolute path to the project root.
 * @param outputPathRel Project-relative path the artifact would have
 *   been written to had validation passed (e.g.
 *   `prompts/images/shots/scene-1-shot-3.json`).
 * @param brokenContent The raw text the LLM produced.
 * @param errorMessage The validation error that rejected the content.
 * @returns The two sidecar paths (or null entries if write failed).
 */
export function writeFailedAttempt(
  projectDir: string,
  outputPathRel: string,
  brokenContent: string,
  errorMessage: string,
): FailedAttemptSidecar {
  const result: FailedAttemptSidecar = { contentPath: null, errorPath: null };

  const failedRel = `${outputPathRel}.failed`;
  const errorRel = `${outputPathRel}.failed.error`;
  const failedAbs = join(projectDir, failedRel);
  const errorAbs = join(projectDir, errorRel);

  try {
    const parent = dirname(failedAbs);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    writeFileSync(failedAbs, brokenContent, 'utf-8');
    result.contentPath = failedRel;
  } catch {
    // best-effort — leave contentPath null if we couldn't write
  }
  try {
    writeFileSync(errorAbs, errorMessage, 'utf-8');
    result.errorPath = errorRel;
  } catch {
    // best-effort — leave errorPath null
  }
  return result;
}

/**
 * Remove any `.failed` / `.failed.error` sidecars previously written for
 * this node's output path. Called when the node next succeeds so the
 * project tree doesn't carry a stale "broken" marker next to the now-
 * good artefact.
 *
 * Idempotent: no error if the files don't exist.
 */
export function clearFailedAttempt(
  projectDir: string,
  outputPathRel: string,
): void {
  const failedAbs = join(projectDir, `${outputPathRel}.failed`);
  const errorAbs = join(projectDir, `${outputPathRel}.failed.error`);
  for (const p of [failedAbs, errorAbs]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // best-effort
    }
  }
}
