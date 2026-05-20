import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveProjectDir,
  ProjectDirNotFoundError,
} from '../../src/agent/pi/tools/resolveProjectDir.js';

let basePath: string;

beforeEach(() => {
  basePath = mkdtempSync(join(tmpdir(), 'resolve-project-dir-'));
});

afterEach(() => {
  rmSync(basePath, { recursive: true, force: true });
});

describe('resolveProjectDir', () => {
  it('finds <name>.dhee when present (canonical convention)', () => {
    mkdirSync(join(basePath, 'my_proj.dhee'));
    expect(resolveProjectDir({ name: 'my_proj', basePath })).toBe(
      join(basePath, 'my_proj.dhee'),
    );
  });

  it('finds <name> (no suffix) when present (dhee-desktop convention)', () => {
    // The desktop's NewProjectDialog creates `<workspace>/<name>`,
    // no `.dhee` suffix. Earlier versions failed here, leading
    // pi-agent to `mv` the folder. The fallback now handles it.
    mkdirSync(join(basePath, 'BurgerEating'));
    expect(resolveProjectDir({ name: 'BurgerEating', basePath })).toBe(
      join(basePath, 'BurgerEating'),
    );
  });

  it('prefers <name>.dhee over <name> when both exist (regression pin)', () => {
    // If a user has both for some reason, the canonical form wins so
    // existing dhee projects don't suddenly resolve to something
    // else.
    mkdirSync(join(basePath, 'p.dhee'));
    mkdirSync(join(basePath, 'p'));
    expect(resolveProjectDir({ name: 'p', basePath })).toBe(
      join(basePath, 'p.dhee'),
    );
  });

  it('uses an explicit projectDir when it exists, ignoring the convention probe', () => {
    const custom = join(basePath, 'totally', 'custom', 'place');
    mkdirSync(custom, { recursive: true });
    // Also create the conventional <name>.dhee to confirm
    // projectDir wins over it.
    mkdirSync(join(basePath, 'p.dhee'));
    expect(
      resolveProjectDir({ name: 'p', basePath, projectDir: custom }),
    ).toBe(custom);
  });

  it('falls back to convention probe when projectDir is given but does not exist', () => {
    mkdirSync(join(basePath, 'p.dhee'));
    expect(
      resolveProjectDir({
        name: 'p',
        basePath,
        projectDir: '/nope/missing',
      }),
    ).toBe(join(basePath, 'p.dhee'));
  });

  it('resolves relative projectDir against basePath', () => {
    mkdirSync(join(basePath, 'rel-folder'));
    expect(
      resolveProjectDir({
        name: 'whatever',
        basePath,
        projectDir: 'rel-folder',
      }),
    ).toBe(join(basePath, 'rel-folder'));
  });

  it('throws ProjectDirNotFoundError listing every attempted path when nothing matches', () => {
    try {
      resolveProjectDir({ name: 'ghost', basePath });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectDirNotFoundError);
      const e = err as ProjectDirNotFoundError;
      // Must include both probe paths so the agent (or human) can see
      // exactly what was checked, instead of guessing.
      expect(e.attempted).toEqual([
        join(basePath, 'ghost.dhee'),
        join(basePath, 'ghost'),
      ]);
    }
  });

  it('includes the explicit projectDir in attempted paths when it falls back', () => {
    try {
      resolveProjectDir({
        name: 'ghost',
        basePath,
        projectDir: '/nope/missing',
      });
      expect.fail('expected throw');
    } catch (err) {
      const e = err as ProjectDirNotFoundError;
      expect(e.attempted).toContain('/nope/missing');
      expect(e.attempted).toContain(join(basePath, 'ghost.dhee'));
      expect(e.attempted).toContain(join(basePath, 'ghost'));
    }
  });
});
