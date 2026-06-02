/**
 * Tests for the pure helpers in vlm.judge:
 *   - parseVerdict: tolerant of markdown fences + prose preamble.
 *   - buildJudgePrompt: composes criteria + every non-image input.
 *   - pickConfig: prefers explicit runner config, falls back to env,
 *     errors loudly when neither path resolves.
 *   - stampPendingCritique: writes the critique into project.json
 *     preserving sibling fields.
 *
 * The actual VLM call (chat.completions) isn't exercised here — it's
 * an OpenAI client over the wire; that's integration territory. The
 * helpers above are the load-bearing logic; mocking the wire call
 * doesn't add coverage.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildJudgePrompt,
  parseVerdict,
  pickBestAttempt,
  pickConfig,
  stampPendingCritique,
  type JudgeAttempt,
} from '../../../src/dag/runners/vlmJudge.js';

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length) {
    try {
      rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
    } catch {}
  }
});

describe('parseVerdict', () => {
  it('parses a clean JSON object', () => {
    const raw = '{"pass": true, "score": 0.9, "notes": "looks good"}';
    const v = parseVerdict(raw);
    expect(v).toEqual({ pass: true, score: 0.9, notes: 'looks good' });
  });

  it('strips ```json fences', () => {
    const raw = '```json\n{"pass": false, "score": 0.4, "notes": "wrong character"}\n```';
    const v = parseVerdict(raw);
    expect(v).toMatchObject({ pass: false, score: 0.4, notes: 'wrong character' });
  });

  it('tolerates prose preamble + trailing whitespace', () => {
    const raw =
      'Here is my analysis:\n\n{"pass": false, "score": 0.5, "notes": "owner looks like Angel — needs canonical bald/heavyset/50s anchoring"}\n';
    const v = parseVerdict(raw);
    expect(v).toMatchObject({
      pass: false,
      notes: expect.stringContaining('Angel'),
    });
  });

  it('rejects empty response', () => {
    expect(parseVerdict('')).toEqual({ error: expect.stringMatching(/empty/) });
  });

  it('rejects when no JSON object can be found', () => {
    expect(parseVerdict('I refuse to respond')).toEqual({
      error: expect.stringMatching(/no JSON object/),
    });
  });

  it('rejects malformed JSON (has braces but invalid content)', () => {
    expect(parseVerdict('{ "pass": true, "score": 0.9 "notes": "missing comma" }')).toEqual({
      error: expect.stringMatching(/malformed JSON/),
    });
  });

  it('rejects when required fields are missing or wrong type', () => {
    expect(parseVerdict('{"pass": "yes", "score": 0.9, "notes": "x"}')).toEqual({
      error: expect.stringMatching(/non-boolean.*pass/),
    });
    expect(parseVerdict('{"pass": true, "score": "high", "notes": "x"}')).toEqual({
      error: expect.stringMatching(/non-number.*score/),
    });
    expect(parseVerdict('{"pass": true, "score": 0.9}')).toEqual({
      error: expect.stringMatching(/non-string.*notes/),
    });
  });
});

describe('buildJudgePrompt', () => {
  it('includes the evaluation criteria when provided', () => {
    const out = buildJudgePrompt({
      contextInputs: { shot_image_prompt: { view: 'front view' } },
      imageInputId: 'shot_image',
      criteria: 'character identity + setting fidelity',
    });
    expect(out).toContain('character identity + setting fidelity');
  });

  it('excludes the image input from the text payload (it goes in image_url)', () => {
    const out = buildJudgePrompt({
      contextInputs: { shot_image: '/path/to/img.png', shot_image_prompt: { view: 'fv' } },
      imageInputId: 'shot_image',
    });
    expect(out).not.toContain('/path/to/img.png');
    expect(out).toContain('shot_image_prompt');
  });

  it('serializes object inputs as pretty JSON, leaves strings raw', () => {
    const out = buildJudgePrompt({
      contextInputs: {
        characters_plan: { characters: [{ id: 'ruby', name: 'Ruby' }] },
        world_style: 'cinematic noir, sickly yellow-green fluorescents',
      },
      imageInputId: 'shot_image',
    });
    expect(out).toContain('"characters"');
    expect(out).toContain('cinematic noir, sickly yellow-green fluorescents');
  });
});

describe('pickConfig', () => {
  it('prefers explicit runner config when all three judge fields are set', () => {
    const got = pickConfig(
      {
        outputPath: 'x',
        refineNode: 'y',
        judgeProvider: 'openrouter',
        judgeApiKey: 'sk-or-abc',
        judgeModel: 'xiaomi/mimo-v2.5',
      },
      {},
    );
    expect(got).toEqual({
      provider: 'openrouter',
      apiKey: 'sk-or-abc',
      model: 'xiaomi/mimo-v2.5',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
  });

  it('falls back to VLM_* env when config is incomplete', () => {
    const got = pickConfig(
      { outputPath: 'x', refineNode: 'y' },
      {
        VLM_PROVIDER: 'openrouter',
        VLM_API_KEY: 'sk-or-env',
        VLM_MODEL: 'xiaomi/mimo-v2.5',
      },
    );
    expect(got).toMatchObject({ provider: 'openrouter', apiKey: 'sk-or-env' });
  });

  it('errors loudly when neither source resolves', () => {
    const got = pickConfig({ outputPath: 'x', refineNode: 'y' }, {});
    expect(got).toEqual({ error: expect.stringMatching(/no VLM endpoint/) });
  });
});

describe('pickBestAttempt (best-of-N selection)', () => {
  const a = (n: number, pass: boolean, score: number): JudgeAttempt => ({
    n,
    pass,
    score,
    notes: '',
    stashPath: '',
  });

  it('picks the FIRST passing attempt when any pass', () => {
    // attempt 1 fails (0.9), attempt 2 passes (0.65), attempt 3 passes (0.85).
    // First passing wins → attempt 2, even though attempt 3 scored higher.
    expect(pickBestAttempt([a(1, false, 0.9), a(2, true, 0.65), a(3, true, 0.85)]).n).toBe(2);
  });

  it('picks highest-scoring when no attempt passes', () => {
    expect(pickBestAttempt([a(1, false, 0.4), a(2, false, 0.7), a(3, false, 0.5)]).n).toBe(2);
  });

  it('breaks score ties by earliest (lowest n)', () => {
    expect(pickBestAttempt([a(1, false, 0.5), a(2, false, 0.5), a(3, false, 0.5)]).n).toBe(1);
  });

  it('handles single attempt', () => {
    expect(pickBestAttempt([a(1, true, 0.9)]).n).toBe(1);
    expect(pickBestAttempt([a(1, false, 0.2)]).n).toBe(1);
  });

  it('throws on empty input (no defensible best)', () => {
    expect(() => pickBestAttempt([])).toThrow(/no attempts/);
  });
});

describe('stampPendingCritique', () => {
  it('writes a new pendingCritiques map onto a fresh project.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vlm-judge-stamp-'));
    cleanupDirs.push(dir);
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: 'TestProj' }, null, 2));

    stampPendingCritique(dir, 'shot_image_prompt', 'scene_1_shot_4', 'fix anchoring');

    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf-8'));
    expect(project.pendingCritiques).toEqual({
      'shot_image_prompt:scene_1_shot_4': 'fix anchoring',
    });
    // Sibling preserved.
    expect(project.name).toBe('TestProj');
  });

  it('uses bare nodeId when no itemId (stage nodes)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vlm-judge-stamp-'));
    cleanupDirs.push(dir);
    writeFileSync(join(dir, 'project.json'), JSON.stringify({}));

    stampPendingCritique(dir, 'world_style', undefined, 'noir not pastel');

    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf-8'));
    expect(project.pendingCritiques).toEqual({ world_style: 'noir not pastel' });
  });

  it('overwrites a prior critique for the same key (idempotent re-stamp)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vlm-judge-stamp-'));
    cleanupDirs.push(dir);
    writeFileSync(
      join(dir, 'project.json'),
      JSON.stringify({ pendingCritiques: { 'shot_image_prompt:s1_4': 'first' } }, null, 2),
    );

    stampPendingCritique(dir, 'shot_image_prompt', 's1_4', 'second-attempt note');

    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf-8'));
    expect(project.pendingCritiques['shot_image_prompt:s1_4']).toBe('second-attempt note');
  });
});
