/**
 * TDD Tests for the 3-call shot_image_prompt pipeline.
 *
 * The pipeline splits shot_image_prompt generation into:
 *   Call 1: Mode decision (classification) → { mode, refs }
 *   Call 2: First frame prompt (creative) → imagePrompt string
 *   Call 3: Last frame prompt (creative) → imagePrompt string
 *   Assembly: deterministic JSON construction
 */

import { describe, it, expect } from 'vitest';
import {
  validateWithSchema,
} from '../../src/core/planner/schemas.js';

// ──────────────────────────────────────────────────────────────────────────────
// assembleShotImagePrompt: deterministic JSON construction
// ──────────────────────────────────────────────────────────────────────────────

describe('shotImagePipeline: assembleShotImagePrompt', () => {
  it('produces valid flfv JSON with first_frame + last_frame', async () => {
    const { assembleShotImagePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = assembleShotImagePrompt({
      shotNumber: 1,
      generationStrategy: 'flfv',
      firstFrameMode: 'image_text_to_image',
      firstFramePrompt: 'A wide shot of the city from image 1, deep focus...',
      firstFrameRefs: [{ imageNumber: 1, type: 'setting' as const, refId: 'setting_image:city' }],
      lastFramePrompt: 'The city now engulfed in flames, smoke filling the upper third...',
      negativePrompt: 'blurry, cartoon, text',
    });

    expect(result.shotNumber).toBe(1);
    expect(result.generationStrategy).toBe('flfv');
    expect(result.frames.first_frame.imagePrompt).toContain('wide shot');
    expect(result.frames.first_frame.generationMode).toBe('image_text_to_image');
    expect(result.frames.first_frame.references).toHaveLength(1);
    expect(result.frames.last_frame).toBeDefined();
    expect(result.frames.last_frame!.generationMode).toBe('edit_first_frame');
    expect(result.frames.last_frame!.references).toEqual([]);
    expect(result.negativePrompt).toBe('blurry, cartoon, text');
    expect(result.aspectRatio).toBe('16:9');

    // Must pass the existing Zod schema
    const validation = validateWithSchema('shot_image_prompt', result);
    expect(validation.valid).toBe(true);
  });

  it('coerces fmlfv strategy to flfv (FML2V disabled) and omits mid_frame', async () => {
    const { assembleShotImagePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = assembleShotImagePrompt({
      shotNumber: 4,
      generationStrategy: 'fmlfv',
      firstFrameMode: 'image_text_to_image',
      firstFramePrompt: 'A medium shot of the warrior...',
      firstFrameRefs: [{ imageNumber: 1, type: 'character' as const, refId: 'character_image:kai' }],
      lastFramePrompt: 'The altar split in two, energy pouring upward...',
      negativePrompt: 'blurry, cartoon',
    });

    // fmlfv requests are silently downgraded to flfv; no mid_frame produced.
    expect(result.generationStrategy).toBe('flfv');
    expect(result.frames.mid_frame).toBeUndefined();
    expect(result.frames.last_frame).toBeDefined();

    const validation = validateWithSchema('shot_image_prompt', result);
    expect(validation.valid).toBe(true);
  });

  it('sets edit_previous_shot mode with only new character refs', async () => {
    const { assembleShotImagePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = assembleShotImagePrompt({
      shotNumber: 3,
      generationStrategy: 'flfv',
      firstFrameMode: 'edit_previous_shot',
      firstFramePrompt: 'The phantom from image 1 now visible beside the girl...',
      firstFrameRefs: [{ imageNumber: 1, type: 'character' as const, refId: 'character_image:monster' }],
      lastFramePrompt: 'The phantom has advanced to center frame...',
      negativePrompt: 'blurry, cartoon',
    });

    expect(result.frames.first_frame.generationMode).toBe('edit_previous_shot');
    expect(result.frames.first_frame.references).toEqual([
      { imageNumber: 1, type: 'character', refId: 'character_image:monster' },
    ]);
  });

  it('always sets last_frame to edit_first_frame with empty refs', async () => {
    const { assembleShotImagePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = assembleShotImagePrompt({
      shotNumber: 2,
      generationStrategy: 'flfv',
      firstFrameMode: 'edit_previous_shot',
      firstFramePrompt: 'Camera pushed in to close-up...',
      firstFrameRefs: [],
      lastFramePrompt: 'Expression shifted to resolve...',
      negativePrompt: 'blurry',
    });

    expect(result.frames.last_frame!.generationMode).toBe('edit_first_frame');
    expect(result.frames.last_frame!.references).toEqual([]);
    // last_frame should NOT contain 'from image' even if first_frame does
    expect(result.frames.last_frame!.imagePrompt).not.toContain('from image');
  });

  it('passes flfv strategy through unchanged', async () => {
    const { assembleShotImagePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = assembleShotImagePrompt({
      shotNumber: 1,
      generationStrategy: 'flfv',
      firstFrameMode: 'image_text_to_image',
      firstFramePrompt: 'test',
      firstFrameRefs: [],
      lastFramePrompt: 'test delta',
      negativePrompt: 'blurry',
    });

    expect(result.generationStrategy).toBe('flfv');
  });

  it('passes v2v_extend strategy through unchanged', async () => {
    const { assembleShotImagePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = assembleShotImagePrompt({
      shotNumber: 2,
      generationStrategy: 'v2v_extend',
      firstFrameMode: 'edit_previous_shot',
      firstFramePrompt: 'test',
      firstFrameRefs: [],
      lastFramePrompt: 'test delta',
      negativePrompt: 'blurry',
    });

    expect(result.generationStrategy).toBe('v2v_extend');
  });

  it('defaults aspectRatio to 16:9', async () => {
    const { assembleShotImagePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = assembleShotImagePrompt({
      shotNumber: 1,
      generationStrategy: 'flfv',
      firstFrameMode: 'image_text_to_image',
      firstFramePrompt: 'test',
      firstFrameRefs: [],
      lastFramePrompt: 'test delta',
      negativePrompt: 'blurry',
    });

    expect(result.aspectRatio).toBe('16:9');
  });

  // ── Phase 2: deterministic slot manifest (task #11) ────────────────────
  // The assembler prepends a manifest line built from firstFrameRefs and
  // strips inline `from image N` tokens from LLM prose. This pins both
  // behaviours so future edits don't silently regress.

  it('prepends a slot manifest line built from firstFrameRefs', async () => {
    const { assembleShotImagePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = assembleShotImagePrompt({
      shotNumber: 1,
      generationStrategy: 'flfv',
      firstFrameMode: 'image_text_to_image',
      firstFramePrompt: 'A medium close-up of Ruby pointing a revolver.',
      firstFrameRefs: [
        { imageNumber: 1, type: 'setting', refId: 'setting_image:inside_pawn_shop' },
        { imageNumber: 2, type: 'character', refId: 'character_image:ruby' },
        { imageNumber: 3, type: 'character', refId: 'character_image:owner' },
      ],
      lastFramePrompt: 'Ruby now holding the crystal.',
      negativePrompt: 'blurry',
    });

    expect(result.frames.first_frame.imagePrompt).toMatch(
      /^Inside Pawn Shop \(setting\) from image 1\. Ruby from image 2\. Owner from image 3\./,
    );
    // Manifest is followed by the LLM prose, separated by a blank line.
    expect(result.frames.first_frame.imagePrompt).toContain('\n\nA medium close-up of Ruby');
    // The last frame gets the same manifest prepended.
    expect(result.frames.last_frame?.imagePrompt).toMatch(
      /^Inside Pawn Shop \(setting\) from image 1\. Ruby from image 2\. Owner from image 3\./,
    );
  });

  it('strips inline "from image N" tokens from LLM-emitted prose', async () => {
    const { assembleShotImagePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = assembleShotImagePrompt({
      shotNumber: 1,
      generationStrategy: 'flfv',
      firstFrameMode: 'image_text_to_image',
      firstFramePrompt:
        'Ruby from image 2 stands on the counter, levelling her revolver at the owner from image 3 behind it.',
      firstFrameRefs: [
        { imageNumber: 2, type: 'character', refId: 'character_image:ruby' },
        { imageNumber: 3, type: 'character', refId: 'character_image:owner' },
      ],
      lastFramePrompt: 'Owner from image 3 collapses behind the counter.',
      negativePrompt: 'blurry',
    });

    // Manifest line precedes the LLM prose — the prose portion (after the
    // blank-line separator) must have no inline "from image N" markers.
    const firstProse = result.frames.first_frame.imagePrompt.split('\n\n').slice(1).join('\n\n');
    const lastProse = (result.frames.last_frame?.imagePrompt ?? '').split('\n\n').slice(1).join('\n\n');
    expect(firstProse).not.toMatch(/from image \d/i);
    expect(lastProse).not.toMatch(/from image \d/i);
    // The bare character names remain in place.
    expect(firstProse).toContain('Ruby stands on the counter');
    expect(firstProse).toContain('the owner behind it');
    expect(lastProse).toContain('Owner collapses');
  });

  it('produces an empty manifest line when firstFrameRefs is empty', async () => {
    const { assembleShotImagePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = assembleShotImagePrompt({
      shotNumber: 1,
      generationStrategy: 'flfv',
      firstFrameMode: 'text_to_image',
      firstFramePrompt: 'Atmospheric close-up of rain on a bell.',
      firstFrameRefs: [],
      lastFramePrompt: 'Atmospheric close-up, the bell now still.',
      negativePrompt: 'blurry',
    });

    // No manifest, no leading "from image" anywhere — just the LLM prose.
    expect(result.frames.first_frame.imagePrompt).toBe('Atmospheric close-up of rain on a bell.');
    expect(result.frames.last_frame?.imagePrompt).toBe('Atmospheric close-up, the bell now still.');
  });

  it('labels settings with " (setting)" suffix; characters bare', async () => {
    const { assembleShotImagePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = assembleShotImagePrompt({
      shotNumber: 1,
      generationStrategy: 'flfv',
      firstFrameMode: 'image_text_to_image',
      firstFramePrompt: 'shot prose',
      firstFrameRefs: [
        { imageNumber: 1, type: 'setting', refId: 'setting_image:lamborghini_driver_seat' },
        { imageNumber: 2, type: 'character', refId: 'character_image:angel' },
      ],
      lastFramePrompt: 'delta',
      negativePrompt: 'blurry',
    });

    expect(result.frames.first_frame.imagePrompt).toContain(
      'Lamborghini Driver Seat (setting) from image 1.',
    );
    expect(result.frames.first_frame.imagePrompt).toContain('Angel from image 2.');
    expect(result.frames.first_frame.imagePrompt).not.toContain('Angel (setting)');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildNegativePrompt: template-based negative prompt
// ──────────────────────────────────────────────────────────────────────────────

describe('shotImagePipeline: buildNegativePrompt', () => {
  it('returns base negatives for any mode', async () => {
    const { buildNegativePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const neg = buildNegativePrompt('image_text_to_image');
    expect(neg).toContain('blurry');
    expect(neg).toContain('cartoon');
    expect(neg).toContain('text');
    expect(neg).toContain('watermark');
  });

  it('returns negatives for all modes without error', async () => {
    const { buildNegativePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(buildNegativePrompt('image_text_to_image')).toBeTruthy();
    expect(buildNegativePrompt('edit_previous_shot')).toBeTruthy();
    expect(buildNegativePrompt('text_to_image')).toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseModeDecision: parse call 1 output with fallback
// ──────────────────────────────────────────────────────────────────────────────

describe('shotImagePipeline: parseModeDecision', () => {
  const allRefs = [
    { imageNumber: 1, type: 'character' as const, refId: 'character_image:monster', label: 'monster' },
    { imageNumber: 2, type: 'character' as const, refId: 'character_image:the_girl', label: 'the_girl' },
    { imageNumber: 3, type: 'setting' as const, refId: 'setting_image:city', label: 'city' },
  ];

  it('parses valid mode decision JSON', async () => {
    const { parseModeDecision } = await import('../../src/core/planner/shotImagePipeline.js');
    const raw = JSON.stringify({
      mode: 'edit_previous_shot',
      newCharacterRefs: [{ imageNumber: 1, type: 'character', refId: 'character_image:monster' }],
      existingSubjects: ['the_girl'],
    });

    const result = parseModeDecision(raw, allRefs);
    expect(result.mode).toBe('edit_previous_shot');
    expect(result.references).toHaveLength(1);
    expect(result.references[0].refId).toBe('character_image:monster');
  });

  it('falls back to image_text_to_image with all refs on garbage input', async () => {
    const { parseModeDecision } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = parseModeDecision('not json at all!!!', allRefs);
    expect(result.mode).toBe('image_text_to_image');
    expect(result.references).toHaveLength(3); // all refs as fallback
  });

  it('falls back on missing mode field', async () => {
    const { parseModeDecision } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = parseModeDecision(JSON.stringify({ foo: 'bar' }), allRefs);
    expect(result.mode).toBe('image_text_to_image');
    expect(result.references).toHaveLength(3);
  });

  it('falls back on invalid mode value', async () => {
    const { parseModeDecision } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = parseModeDecision(JSON.stringify({ mode: 'invalid_mode' }), allRefs);
    expect(result.mode).toBe('image_text_to_image');
  });

  it('handles edit_previous_shot with no new refs (continuation only)', async () => {
    const { parseModeDecision } = await import('../../src/core/planner/shotImagePipeline.js');
    const raw = JSON.stringify({
      mode: 'edit_previous_shot',
      newCharacterRefs: [],
      existingSubjects: ['the_girl', 'monster'],
    });

    const result = parseModeDecision(raw, allRefs);
    expect(result.mode).toBe('edit_previous_shot');
    expect(result.references).toHaveLength(0);
  });

  it('strips markdown code fences from response', async () => {
    const { parseModeDecision } = await import('../../src/core/planner/shotImagePipeline.js');
    const raw = '```json\n{"mode": "text_to_image", "newCharacterRefs": [], "existingSubjects": []}\n```';
    const result = parseModeDecision(raw, allRefs);
    expect(result.mode).toBe('text_to_image');
    expect(result.references).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Prompt builders: build system+user prompts for each call
// ──────────────────────────────────────────────────────────────────────────────

describe('shotImagePipeline: buildModeDecisionPrompt', () => {
  it('includes available references in the user prompt', async () => {
    const { buildModeDecisionPrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const { system, user } = buildModeDecisionPrompt({
      shotDescription: 'The girl enters the apocalyptic street',
      shotNumber: 3,
      availableRefs: [
        { imageNumber: 1, type: 'character' as const, refId: 'character_image:the_girl', label: 'the_girl' },
        { imageNumber: 2, type: 'setting' as const, refId: 'setting_image:city', label: 'city' },
      ],
      previousShotAvailable: true,
      previousShotCharacters: ['monster'],
    });
    expect(user).toContain('character_image:the_girl');
    expect(user).toContain('setting_image:city');
    expect(user).toContain('Shot 3');
    expect(user).toContain('previous shot');
  });

  it('includes previous shot characters when available', async () => {
    const { buildModeDecisionPrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const { user } = buildModeDecisionPrompt({
      shotDescription: 'A phantom appears beside the girl',
      shotNumber: 4,
      availableRefs: [],
      previousShotAvailable: true,
      previousShotCharacters: ['the_girl'],
    });
    expect(user).toContain('the_girl');
    expect(user).toContain('previous shot');
  });

  it('loads mode decision guide into system prompt', async () => {
    const { buildModeDecisionPrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const { system } = buildModeDecisionPrompt({
      shotDescription: 'test',
      shotNumber: 1,
      availableRefs: [],
      previousShotAvailable: false,
      previousShotCharacters: [],
    });
    expect(system).toContain('mode');
    expect(system).toContain('JSON');
  });
});

describe('shotImagePipeline: buildFirstFramePrompt', () => {
  it('includes shot description and mode in user prompt', async () => {
    const { buildFirstFramePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const { user } = buildFirstFramePrompt({
      shotDescription: 'A wide shot of the girl sprinting through ruins',
      cameraWork: 'wide, tracking',
      mode: 'image_text_to_image',
      references: [{ imageNumber: 1, type: 'character' as const, refId: 'character_image:the_girl' }],
      sceneStateContext: '',
    });
    expect(user).toContain('wide shot');
    expect(user).toContain('character_image:the_girl');
  });

  it('tells the LLM the mode for edit_previous_shot calls', async () => {
    const { buildFirstFramePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const { system } = buildFirstFramePrompt({
      shotDescription: 'Camera pushes in to close-up',
      cameraWork: 'close-up',
      mode: 'edit_previous_shot',
      references: [],
      sceneStateContext: '',
    });
    // System prompt now loads the merged guide (all modes) and tells
    // the LLM which mode + frame target this call is for. The
    // edit_previous_shot section's "delta-only" content is present
    // as part of the unified guide.
    expect(system).toContain('edit_previous_shot');
    expect(system).toContain('FIRST FRAME');
    expect(system).toContain('delta');
  });

  it('tells the LLM the mode for image_text_to_image (fresh) calls', async () => {
    const { buildFirstFramePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const { system } = buildFirstFramePrompt({
      shotDescription: 'A wide establishing shot',
      cameraWork: 'wide',
      mode: 'image_text_to_image',
      references: [{ imageNumber: 1, type: 'setting' as const, refId: 'setting_image:city' }],
      sceneStateContext: '',
    });
    expect(system).toContain('image_text_to_image');
    expect(system).toContain('FIRST FRAME');
    // Fresh mode's section + the common SCALIST framework must both
    // be present (single merged guide carries all sections).
    expect(system).toContain('SCALIST');
    // Negative pattern: the merged guide must NOT teach the LLM
    // about the "from image N" slot-token concept that we used to
    // forbid via a DO NOT instruction.
    expect(system).not.toContain('from image N');
  });
});

describe('shotImagePipeline: buildLastFramePrompt', () => {
  it('includes first frame prompt as context', async () => {
    const { buildLastFramePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const { user } = buildLastFramePrompt({
      firstFramePrompt: 'A wide shot of the girl mid-stride in the city...',
      lastFrameChanges: 'Girl moved to far right. Wall collapsed.',
      shotDescription: 'The girl dodges falling debris',
    });
    expect(user).toContain('mid-stride');
    expect(user).toContain('far right');
    expect(user).toContain('Wall collapsed');
  });

  it('loads last frame guide into system prompt', async () => {
    const { buildLastFramePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const { system } = buildLastFramePrompt({
      firstFramePrompt: 'test first frame',
      lastFrameChanges: '',
      shotDescription: 'test shot',
    });
    expect(system).toContain('END STATE');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Turn-2 ref-extraction helpers (Phase A / B of multi-turn pipeline)
// ──────────────────────────────────────────────────────────────────────────────

describe('shotImagePipeline: buildReferenceMenu', () => {
  it('builds menu entries for character_image / setting_image nodes', async () => {
    const { buildReferenceMenu } = await import('../../src/core/planner/shotImagePipeline.js');
    const menu = buildReferenceMenu(
      [
        { id: 'character_image:ruby', typeId: 'character_image', itemId: 'ruby', status: 'completed' },
        { id: 'setting_image:bus_station', typeId: 'setting_image', itemId: 'bus_station', status: 'completed' },
        { id: 'shot_image:scene_1_shot_1', typeId: 'shot_image', itemId: 'scene_1_shot_1', status: 'completed' },
      ],
      (_type, itemId) => ({ label: itemId.toUpperCase(), description: `desc for ${itemId}` }),
    );
    expect(menu).toHaveLength(2);
    expect(menu[0]?.refId).toBe('character_image:ruby');
    expect(menu[0]?.type).toBe('character');
    expect(menu[1]?.refId).toBe('setting_image:bus_station');
    expect(menu[1]?.type).toBe('setting');
  });

  it('skips uncompleted nodes (lazy refs not visible until rendered)', async () => {
    const { buildReferenceMenu } = await import('../../src/core/planner/shotImagePipeline.js');
    const menu = buildReferenceMenu(
      [
        { id: 'character_image:ruby', typeId: 'character_image', itemId: 'ruby', status: 'pending' },
        { id: 'character_image:angel', typeId: 'character_image', itemId: 'angel', status: 'completed' },
      ],
      (_type, itemId) => ({ label: itemId, description: '' }),
    );
    expect(menu).toHaveLength(1);
    expect(menu[0]?.refId).toBe('character_image:angel');
  });
});

describe('shotImagePipeline: buildTurn2UserMessage', () => {
  it('embeds the menu as JSON in the user message', async () => {
    const { buildTurn2UserMessage } = await import('../../src/core/planner/shotImagePipeline.js');
    const msg = buildTurn2UserMessage([
      { refId: 'character_image:ruby', type: 'character', label: 'Ruby', description: '' },
    ]);
    expect(msg).toContain('character_image:ruby');
    expect(msg).toContain('reference image list');
    expect(msg).toContain('1 for setting');
    expect(msg).not.toContain('over-the-shoulder');
  });

  it('adds OTS hint when otsHint=true', async () => {
    const { buildTurn2UserMessage } = await import('../../src/core/planner/shotImagePipeline.js');
    const msg = buildTurn2UserMessage([], { otsHint: true });
    expect(msg).toContain('over-the-shoulder');
    expect(msg).toContain("side='A'");
    expect(msg).toContain("side='B'");
  });
});

describe('shotImagePipeline: parseTurn2RefsJson', () => {
  it('parses a well-formed references envelope', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const raw = JSON.stringify({
      references: [
        { refId: 'setting_image:bus_station', type: 'setting', imageNumber: 1, status: 'existing' },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2, status: 'existing', side: 'A' },
        { refId: 'character_image:pawn_broker', type: 'character', imageNumber: 3, status: 'new',
          newRefDescription: 'Heavyset, late 50s', side: 'B' },
      ],
    });
    const refs = parseTurn2RefsJson(raw);
    expect(refs).toHaveLength(3);
    expect(refs[1]?.side).toBe('A');
    expect(refs[2]?.status).toBe('new');
    expect(refs[2]?.newRefDescription).toBe('Heavyset, late 50s');
  });

  it('strips markdown fences if the LLM wraps despite instructions', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const raw = '```json\n' + JSON.stringify({ references: [{ refId: 'setting_image:x', type: 'setting', imageNumber: 1 }] }) + '\n```';
    const refs = parseTurn2RefsJson(raw);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.refId).toBe('setting_image:x');
  });

  it('drops dups by refId and imageNumber, keeping first', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2 },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 3 }, // dup refId
        { refId: 'character_image:angel', type: 'character', imageNumber: 2 }, // dup slot
      ],
    }));
    expect(refs).toHaveLength(1);
    expect(refs[0]?.refId).toBe('character_image:ruby');
  });

  it('skips malformed entries (missing refId / imageNumber / bad type)', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { type: 'character', imageNumber: 2 },                              // no refId
        { refId: 'character_image:x', type: 'character' },                  // no imageNumber
        { refId: 'character_image:y', type: 'wrong', imageNumber: 3 },       // bad type
        { refId: 'character_image:good', type: 'character', imageNumber: 2 },
      ],
    }));
    expect(refs).toHaveLength(1);
    expect(refs[0]?.refId).toBe('character_image:good');
  });

  it('returns [] on unparseable input (turn-2 keeps turn-1 refs)', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(parseTurn2RefsJson('not json at all')).toEqual([]);
    expect(parseTurn2RefsJson('')).toEqual([]);
    expect(parseTurn2RefsJson('{"references": "not an array"}')).toEqual([]);
  });
});
