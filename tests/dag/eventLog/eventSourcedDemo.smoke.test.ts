/**
 * Smoke test for the end-to-end demo script. Spawns it, asserts exit 0
 * and that the "ALL FOUR CAPABILITIES PROVEN" marker appears.
 *
 * This is the regression gate for the architecture demo — if any of
 * the projections / walker / CAS / branch / swap pieces breaks, this
 * goes red.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

describe('eventSourcedDemo (smoke)', () => {
  it('runs to completion and proves all four capabilities', () => {
    const repoRoot = join(__dirname, '..', '..', '..');
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/eventSourcedDemo.ts'],
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 60_000,
      },
    );
    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('ALL FOUR CAPABILITIES PROVEN END-TO-END');
    expect(result.stdout).toContain('① EVENT LOG FOUNDATION');
    expect(result.stdout).toContain('② NON-DESTRUCTIVE VERSIONING');
    expect(result.stdout).toContain('③ CONTENT-ADDRESSED CACHE');
    expect(result.stdout).toContain('④ FORKS');
    expect(result.stdout).toContain('⑤ CONDITIONAL RUNNER SWAP');
    // Cache replay should save the entire first-walk cost on project B.
    expect(result.stdout).toMatch(/Spend on projectB:\s+\$0\.0000/);
  }, 60_000);
});
