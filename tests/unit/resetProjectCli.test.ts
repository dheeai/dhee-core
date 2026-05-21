/**
 * CLI smoke tests for `scripts/reset-project.ts`.
 *
 * The earlier "Reset from UI" tests greped WebSocketHandler.ts /
 * types.ts / frontend/commands.ts to assert message strings; deleted
 * because they pinned text rather than exercising behavior. What's
 * left is real CLI behavior — that the script's arg validation
 * surfaces a clear error before it tries to touch anything.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';

describe('scripts/reset-project.ts CLI', () => {
  it('exits 1 with usage hint when run with no args', () => {
    const tsxPath = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const scriptPath = join(process.cwd(), 'scripts', 'reset-project.ts');

    try {
      execSync(`"${tsxPath}" "${scriptPath}"`, { encoding: 'utf-8', timeout: 10000 });
    } catch (err: any) {
      expect(err.status).toBe(1);
      expect(err.stderr).toContain('Usage');
    }
  });

  it('exits 1 with a recognisable error when the stage name is unknown', () => {
    const tsxPath = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const scriptPath = join(process.cwd(), 'scripts', 'reset-project.ts');

    try {
      execSync(`"${tsxPath}" "${scriptPath}" nonexistent_proj invalid_stage`, { encoding: 'utf-8', timeout: 10000 });
    } catch (err: any) {
      expect(err.status).toBe(1);
      expect(err.stderr).toMatch(/Unknown stage|not found/i);
    }
  });
});
