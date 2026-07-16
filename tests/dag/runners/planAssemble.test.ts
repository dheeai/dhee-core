/**
 * `plan.assemble` — Layer 3a. Deterministic (NO LLM calls) runner that
 * assembles the canonical `scenes_plan.json` from:
 *   - a `scope:'all'` collection of per-scene fragments, each
 *     `{ section: {...}, shots: [...] }` (one file per scene)
 *   - the outline stage's output (supplies `title`)
 *
 * Contract (see planAssemble.ts doc comment for the authoritative
 * version): exactly one declared input with `scope:'all'` is the
 * fragments collection (ctx.inputs[that.from] is the walker's
 * `{ itemId: absolutePath }` map); exactly one declared input WITHOUT
 * `scope:'all'` is the outline (ctx.inputs[that.from] is already the
 * parsed JSON object, per the walker's 'matching' resolution).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planAssembleRunner } from '../../../src/dag/runners/planAssemble.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

let bundleDir: string;
let projectDir: string;

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'assemble-bundle-'));
  projectDir = mkdtempSync(join(tmpdir(), 'assemble-proj-'));
  mkdirSync(join(bundleDir, 'schemas'), { recursive: true });
});

afterEach(() => {
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

/** Writes a per-scene fragment JSON file under projectDir and returns its absolute path. */
function writeFragment(relPath: string, fragment: unknown): string {
  const abs = join(projectDir, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, JSON.stringify(fragment));
  return abs;
}

function makeCtx(opts: {
  config: Record<string, unknown>;
  fragments: Record<string, string>; // itemId -> absolute path
  outline: Record<string, unknown>;
  narration?: unknown; // when provided, wires a `narration` input onto the node
}): RunnerContext {
  const node: NodeDef = {
    id: 'assemble_plan',
    kind: 'stage',
    inputs: [
      { from: 'scene_fragment', usage: 'aggregate', scope: 'all' },
      { from: 'outline', usage: 'input' },
      ...(opts.narration !== undefined ? [{ from: 'narration', usage: 'context' as const }] : []),
    ],
    outputs: { format: 'json', pattern: 'plans/scenes_plan.json' },
    runner: { tool: 'plan.assemble', config: opts.config },
  };
  return {
    projectDir,
    bundleDir,
    node,
    inputs: {
      scene_fragment: opts.fragments,
      outline: opts.outline,
      ...(opts.narration !== undefined ? { narration: opts.narration } : {}),
    },
    log: () => {},
  };
}

function fragment(sceneId: string, opts?: { mode?: string; shots?: Array<Record<string, unknown>> }): Record<string, unknown> {
  const sceneNum = sceneId.match(/^scene_(\d+)$/)![1];
  return {
    section: { id: sceneId, title: `Scene ${sceneNum}`, ...(opts?.mode ? { mode: opts.mode } : {}) },
    shots:
      opts?.shots ??
      [
        { id: `${sceneId}_shot_1`, scene: Number(sceneNum), shotNumber: 1, characterPresence: 'none' },
        { id: `${sceneId}_shot_2`, scene: Number(sceneNum), shotNumber: 2, characterPresence: 'character' },
      ],
  };
}

function writeProjectJson(narration: boolean | undefined): void {
  const project: Record<string, unknown> = { projectId: 'p1', name: 'Test' };
  if (narration !== undefined) {
    project['features'] = { narration };
  }
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(project));
}

describe('plan.assemble', () => {
  it('orders out-of-order scene fragments by section.id scene number and flattens shots', async () => {
    writeProjectJson(true);
    const fragments = {
      scene_2: writeFragment('frag/scene_2.json', fragment('scene_2')),
      scene_1: writeFragment('frag/scene_1.json', fragment('scene_1')),
      scene_3: writeFragment('frag/scene_3.json', fragment('scene_3')),
    };
    const outline = { title: 'My Movie' };

    const result = await planAssembleRunner.run(
      makeCtx({ config: { outputPath: 'plans/scenes_plan.json' }, fragments, outline }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = JSON.parse(readFileSync(join(projectDir, result.outputPath), 'utf-8'));
    expect(written.title).toBe('My Movie');
    expect(written.sections.map((s: { id: string }) => s.id)).toEqual(['scene_1', 'scene_2', 'scene_3']);
    expect(written.shots.map((s: { id: string }) => s.id)).toEqual([
      'scene_1_shot_1', 'scene_1_shot_2',
      'scene_2_shot_1', 'scene_2_shot_2',
      'scene_3_shot_1', 'scene_3_shot_2',
    ]);
  });

  it('computes character_shot_ids / none_shot_ids from each shot.characterPresence', async () => {
    writeProjectJson(true);
    const fragments = {
      scene_1: writeFragment('frag/scene_1.json', fragment('scene_1')),
    };
    const outline = { title: 'T' };

    const result = await planAssembleRunner.run(
      makeCtx({ config: { outputPath: 'plans/scenes_plan.json' }, fragments, outline }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = JSON.parse(readFileSync(join(projectDir, result.outputPath), 'utf-8'));
    expect(written.none_shot_ids).toEqual(['scene_1_shot_1']);
    expect(written.character_shot_ids).toEqual(['scene_1_shot_2']);
  });

  it("computes narration_section_ids from section.mode==='narration', in scene order", async () => {
    writeProjectJson(true);
    const fragments = {
      scene_1: writeFragment('frag/scene_1.json', fragment('scene_1', { mode: 'narration' })),
      scene_2: writeFragment('frag/scene_2.json', fragment('scene_2')), // no mode
      scene_3: writeFragment('frag/scene_3.json', fragment('scene_3', { mode: 'narration' })),
    };
    const outline = { title: 'T' };

    const result = await planAssembleRunner.run(
      makeCtx({ config: { outputPath: 'plans/scenes_plan.json' }, fragments, outline }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = JSON.parse(readFileSync(join(projectDir, result.outputPath), 'utf-8'));
    expect(written.narration_section_ids).toEqual(['scene_1', 'scene_3']);
  });

  it('forces narration_section_ids to [] when the project narration feature flag is false', async () => {
    writeProjectJson(false);
    const fragments = {
      scene_1: writeFragment('frag/scene_1.json', fragment('scene_1', { mode: 'narration' })),
    };
    const outline = { title: 'T' };

    const result = await planAssembleRunner.run(
      makeCtx({ config: { outputPath: 'plans/scenes_plan.json' }, fragments, outline }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = JSON.parse(readFileSync(join(projectDir, result.outputPath), 'utf-8'));
    expect(written.narration_section_ids).toEqual([]);
  });

  it('forces narration_section_ids to [] when project.json has no features/narration field at all (default OFF)', async () => {
    writeProjectJson(undefined);
    const fragments = {
      scene_1: writeFragment('frag/scene_1.json', fragment('scene_1', { mode: 'narration' })),
    };
    const outline = { title: 'T' };

    const result = await planAssembleRunner.run(
      makeCtx({ config: { outputPath: 'plans/scenes_plan.json' }, fragments, outline }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = JSON.parse(readFileSync(join(projectDir, result.outputPath), 'utf-8'));
    expect(written.narration_section_ids).toEqual([]);
  });

  it('fails when a shot id does not match the canonical scene_N_shot_M pattern', async () => {
    writeProjectJson(true);
    const fragments = {
      scene_1: writeFragment('frag/scene_1.json', fragment('scene_1', {
        shots: [{ id: 'shot_99', scene: 1, shotNumber: 1, characterPresence: 'none' }],
      })),
    };
    const outline = { title: 'T' };

    const result = await planAssembleRunner.run(
      makeCtx({ config: { outputPath: 'plans/scenes_plan.json' }, fragments, outline }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/id|pattern|shot/i);
  });

  it("fails when a shot's scene field does not match its own fragment's section", async () => {
    writeProjectJson(true);
    const fragments = {
      scene_2: writeFragment('frag/scene_2.json', fragment('scene_2', {
        shots: [{ id: 'scene_2_shot_1', scene: 3, shotNumber: 1, characterPresence: 'none' }],
      })),
    };
    const outline = { title: 'T' };

    const result = await planAssembleRunner.run(
      makeCtx({ config: { outputPath: 'plans/scenes_plan.json' }, fragments, outline }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/scene|mismatch|section/i);
  });

  describe('narration input wiring', () => {
    it('populates narration_section_ids when a wired narration input is boolean true (project flag OFF)', async () => {
      writeProjectJson(false);
      const fragments = {
        scene_1: writeFragment('frag/scene_1.json', fragment('scene_1', { mode: 'narration' })),
      };
      const outline = { title: 'T' };

      const result = await planAssembleRunner.run(
        makeCtx({ config: { outputPath: 'plans/scenes_plan.json' }, fragments, outline, narration: true }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const written = JSON.parse(readFileSync(join(projectDir, result.outputPath), 'utf-8'));
      expect(written.narration_section_ids).toEqual(['scene_1']);
    });

    it("populates narration_section_ids when a wired narration input is the string 'true' (project flag OFF)", async () => {
      writeProjectJson(false);
      const fragments = {
        scene_1: writeFragment('frag/scene_1.json', fragment('scene_1', { mode: 'narration' })),
      };
      const outline = { title: 'T' };

      const result = await planAssembleRunner.run(
        makeCtx({ config: { outputPath: 'plans/scenes_plan.json' }, fragments, outline, narration: 'true' }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const written = JSON.parse(readFileSync(join(projectDir, result.outputPath), 'utf-8'));
      expect(written.narration_section_ids).toEqual(['scene_1']);
    });

    it('forces narration_section_ids to [] when a wired narration input is boolean false (project flag ON)', async () => {
      writeProjectJson(true);
      const fragments = {
        scene_1: writeFragment('frag/scene_1.json', fragment('scene_1', { mode: 'narration' })),
      };
      const outline = { title: 'T' };

      const result = await planAssembleRunner.run(
        makeCtx({ config: { outputPath: 'plans/scenes_plan.json' }, fragments, outline, narration: false }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const written = JSON.parse(readFileSync(join(projectDir, result.outputPath), 'utf-8'));
      expect(written.narration_section_ids).toEqual([]);
    });

    it("forces narration_section_ids to [] when a wired narration input is the string 'false' (project flag ON)", async () => {
      writeProjectJson(true);
      const fragments = {
        scene_1: writeFragment('frag/scene_1.json', fragment('scene_1', { mode: 'narration' })),
      };
      const outline = { title: 'T' };

      const result = await planAssembleRunner.run(
        makeCtx({ config: { outputPath: 'plans/scenes_plan.json' }, fragments, outline, narration: 'false' }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const written = JSON.parse(readFileSync(join(projectDir, result.outputPath), 'utf-8'));
      expect(written.narration_section_ids).toEqual([]);
    });

    it('falls back to project.json features.narration when no narration input is wired (true → populated)', async () => {
      writeProjectJson(true);
      const fragments = {
        scene_1: writeFragment('frag/scene_1.json', fragment('scene_1', { mode: 'narration' })),
      };
      const outline = { title: 'T' };

      const result = await planAssembleRunner.run(
        makeCtx({ config: { outputPath: 'plans/scenes_plan.json' }, fragments, outline }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const written = JSON.parse(readFileSync(join(projectDir, result.outputPath), 'utf-8'));
      expect(written.narration_section_ids).toEqual(['scene_1']);
    });

    it('falls back to project.json features.narration when no narration input is wired (off → [])', async () => {
      writeProjectJson(false);
      const fragments = {
        scene_1: writeFragment('frag/scene_1.json', fragment('scene_1', { mode: 'narration' })),
      };
      const outline = { title: 'T' };

      const result = await planAssembleRunner.run(
        makeCtx({ config: { outputPath: 'plans/scenes_plan.json' }, fragments, outline }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const written = JSON.parse(readFileSync(join(projectDir, result.outputPath), 'utf-8'));
      expect(written.narration_section_ids).toEqual([]);
    });
  });

  describe('outputSchema validation', () => {
    const SCENES_PLAN_SCHEMA = {
      type: 'object',
      required: ['title', 'sections', 'shots', 'narration_section_ids', 'character_shot_ids', 'none_shot_ids'],
      properties: {
        title: { type: 'string' },
        sections: { type: 'array' },
        shots: { type: 'array' },
        narration_section_ids: { type: 'array' },
        character_shot_ids: { type: 'array' },
        none_shot_ids: { type: 'array' },
      },
    };

    it('passes when the assembled result validates against outputSchema', async () => {
      writeProjectJson(true);
      writeFileSync(join(bundleDir, 'schemas/scenes_plan.schema.json'), JSON.stringify(SCENES_PLAN_SCHEMA));
      const fragments = { scene_1: writeFragment('frag/scene_1.json', fragment('scene_1')) };
      const outline = { title: 'T' };

      const result = await planAssembleRunner.run(
        makeCtx({
          config: { outputPath: 'plans/scenes_plan.json', outputSchema: 'schemas/scenes_plan.schema.json' },
          fragments,
          outline,
        }),
      );

      expect(result.ok).toBe(true);
    });

    it('fails when the assembled result does NOT validate against outputSchema', async () => {
      writeProjectJson(true);
      const BAD_SCHEMA = { type: 'object', required: ['nonexistent_field'], properties: {} };
      writeFileSync(join(bundleDir, 'schemas/scenes_plan.schema.json'), JSON.stringify(BAD_SCHEMA));
      const fragments = { scene_1: writeFragment('frag/scene_1.json', fragment('scene_1')) };
      const outline = { title: 'T' };

      const result = await planAssembleRunner.run(
        makeCtx({
          config: { outputPath: 'plans/scenes_plan.json', outputSchema: 'schemas/scenes_plan.schema.json' },
          fragments,
          outline,
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/schema|nonexistent_field/i);
    });
  });
});
