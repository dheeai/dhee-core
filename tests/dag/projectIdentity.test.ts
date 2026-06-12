import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getProjectCacheScope,
  normalizeProjectDirForIdentity,
} from '../../src/dag/projectIdentity.js';
import { computeInputsHash } from '../../src/dag/cas/inputsHash.js';

function withProject(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dhee-project-identity-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('project identity and cache scope', () => {
  it('uses project.json projectId when present', () => {
    withProject((dir) => {
      writeFileSync(
        join(dir, 'project.json'),
        JSON.stringify({ projectId: 'project-123' }),
        'utf8',
      );
      expect(getProjectCacheScope(dir)).toBe('project-123');
    });
  });

  it('falls back to normalized absolute projectDir for old projects', () => {
    withProject((dir) => {
      expect(getProjectCacheScope(`${dir}/`)).toBe(
        normalizeProjectDirForIdentity(dir),
      );
    });
  });

  it('makes identical runner inputs hash differently for different projects', () => {
    withProject((projectA) => {
      withProject((projectB) => {
        const baseKey = {
          tool: 'llm.generate',
          toolVersion: '0.1.0',
          inputs: { renderedPrompt: 'same story', style: 'same style' },
        };
        const hashA = computeInputsHash({
          ...baseKey,
          config: { model: 'same-model', projectScope: getProjectCacheScope(projectA) },
        });
        const hashB = computeInputsHash({
          ...baseKey,
          config: { model: 'same-model', projectScope: getProjectCacheScope(projectB) },
        });
        expect(hashA).not.toBe(hashB);
      });
    });
  });

  it('keeps cache scope stable within the same project', () => {
    withProject((dir) => {
      const first = getProjectCacheScope(dir);
      const second = getProjectCacheScope(`${dir}/`);
      expect(first).toBe(second);
    });
  });
});
