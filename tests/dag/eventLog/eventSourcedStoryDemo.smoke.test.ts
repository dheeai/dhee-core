/**
 * Smoke test for the narrative story demo. Pins the three explicit
 * test outcomes the script claims to prove:
 *   ① branching: main + noir coexist
 *   ② caching: projectB hits 9/9
 *   ③ time travel: walkState rewound to specific seqs
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

describe('eventSourcedStoryDemo (smoke)', () => {
  it('runs to completion end-to-end without intervention; all three tests prove', () => {
    const repoRoot = join(__dirname, '..', '..', '..');
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/eventSourcedStoryDemo.ts'],
      { cwd: repoRoot, encoding: 'utf-8', timeout: 60_000 },
    );
    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);

    // Final marker
    expect(result.stdout).toContain('ALL THREE TESTS PROVEN END-TO-END WITHOUT INTERVENTION');

    // Test 1 — branching
    expect(result.stdout).toMatch(/TEST 1 — BRANCHING/);
    expect(result.stdout).toMatch(/main \+ noir coexist; 3 divergent nodes on noir/);

    // Test 2 — caching: projectB should hit 9/9 (story, scenes_plan, 3 prompts, 3 videos, final).
    expect(result.stdout).toMatch(/TEST 2 — CACHING/);
    expect(result.stdout).toMatch(/projectB hit 9\/9 nodes/);
    expect(result.stdout).toMatch(/byte-identical final video\? YES/);

    // Test 3 — time travel: explicit asOfSeq rewinds.
    expect(result.stdout).toMatch(/TEST 3 — TIME TRAVEL/);
    expect(result.stdout).toMatch(/State as of seq=6 \(just after scenes_plan completed\)/);
    expect(result.stdout).toMatch(/State as of seq=14 \(after shot_2_video; final_video not yet computed\)/);
    expect(result.stdout).toMatch(/State as of seq=20 \(the moment the final video first completed\)/);
    expect(result.stdout).toMatch(/State NOW \(latest\)/);

    // Story content actually flowed through.
    expect(result.stdout).toContain('Aaron');
    expect(result.stdout).toContain('Beth');
    expect(result.stdout).toContain('30s');
  }, 60_000);
});
