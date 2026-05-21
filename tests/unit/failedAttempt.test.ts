/**
 * GIVEN an LLM produced broken output that failed validation + repair + retry
 * WHEN writeFailedAttempt persists it next to the artifact's output path
 * THEN both `.failed` and `.failed.error` sidecars appear at predictable
 *   project-relative paths, so the desktop's Content tab can surface them.
 * AND clearFailedAttempt is idempotent — running it on a path with no
 *   sidecars is a no-op; running it on a path with sidecars removes both.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  writeFailedAttempt,
  clearFailedAttempt,
} from '../../src/core/planner/failedAttempt.js';

let projectDir: string;

beforeEach(() => {
  projectDir = join(tmpdir(), `kshana-failed-attempt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(projectDir, { recursive: true });
});

afterAll(() => {
  // beforeEach uses a fresh tmpdir per test; nothing to do here, but
  // safety: the test runner cleans tmp on its own.
});

describe('writeFailedAttempt', () => {
  it('writes the broken content to {output}.failed and the error to {output}.failed.error', () => {
    const outputRel = 'prompts/images/shots/scene-1-shot-3.json';
    const broken = '{"imagePrompt": "wandering off in the wrong direction"}';
    const err = 'No reference to any known character found.';

    const sidecar = writeFailedAttempt(projectDir, outputRel, broken, err);

    expect(sidecar.contentPath).toBe(`${outputRel}.failed`);
    expect(sidecar.errorPath).toBe(`${outputRel}.failed.error`);
    expect(readFileSync(join(projectDir, sidecar.contentPath!), 'utf-8')).toBe(broken);
    expect(readFileSync(join(projectDir, sidecar.errorPath!), 'utf-8')).toBe(err);
  });

  it('creates parent directories that do not yet exist', () => {
    // The artifact's output dir might not exist when validation fails
    // before writeOutput got a chance to create it.
    const outputRel = 'deeply/nested/never/before/seen/foo.json';
    const sidecar = writeFailedAttempt(
      projectDir,
      outputRel,
      'broken',
      'error',
    );
    expect(sidecar.contentPath).toBe(`${outputRel}.failed`);
    expect(existsSync(join(projectDir, sidecar.contentPath!))).toBe(true);
  });

  it('overwrites prior sidecars when a node fails again', () => {
    const outputRel = 'prompts/x.json';
    writeFailedAttempt(projectDir, outputRel, 'first attempt', 'first err');
    const second = writeFailedAttempt(projectDir, outputRel, 'second attempt', 'second err');

    expect(readFileSync(join(projectDir, second.contentPath!), 'utf-8')).toBe('second attempt');
    expect(readFileSync(join(projectDir, second.errorPath!), 'utf-8')).toBe('second err');
  });
});

describe('clearFailedAttempt', () => {
  it('removes both .failed and .failed.error sidecars', () => {
    const outputRel = 'prompts/x.json';
    writeFailedAttempt(projectDir, outputRel, 'broken', 'error');
    expect(existsSync(join(projectDir, `${outputRel}.failed`))).toBe(true);
    expect(existsSync(join(projectDir, `${outputRel}.failed.error`))).toBe(true);

    clearFailedAttempt(projectDir, outputRel);

    expect(existsSync(join(projectDir, `${outputRel}.failed`))).toBe(false);
    expect(existsSync(join(projectDir, `${outputRel}.failed.error`))).toBe(false);
  });

  it('is a no-op when no sidecars exist (idempotent)', () => {
    // Caller writeOutput → clearFailedAttempt runs on every successful
    // write. If the previous run never failed, the sidecars don't
    // exist — clear must not throw.
    expect(() => clearFailedAttempt(projectDir, 'never/written.json')).not.toThrow();
  });

  it('does not delete the actual artifact when it exists alongside the sidecars', () => {
    // Defensive: clear only touches `.failed` / `.failed.error` paths.
    // It must NEVER unlink the real output (`prompts/x.json`) even if
    // the path happens to exist.
    const outputRel = 'prompts/x.json';
    mkdirSync(join(projectDir, 'prompts'), { recursive: true });
    writeFileSync(join(projectDir, outputRel), 'real artifact content', 'utf-8');
    writeFailedAttempt(projectDir, outputRel, 'broken', 'error');

    clearFailedAttempt(projectDir, outputRel);

    // Sidecars gone.
    expect(existsSync(join(projectDir, `${outputRel}.failed`))).toBe(false);
    // Real artifact untouched.
    expect(existsSync(join(projectDir, outputRel))).toBe(true);
    expect(readFileSync(join(projectDir, outputRel), 'utf-8')).toBe('real artifact content');
  });
});
