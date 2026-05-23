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
    expect(msg).toContain('OTS / dialogue framing');
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

  it('drops dups by refId and imageNumber, keeping first (and rejects with [] when no setting at slot 1 results)', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    // All three refs are characters → no setting → 2.4 rejection.
    // (Before the hardening this test allowed a single character to
    // survive; now we require a setting when non-settings are present.)
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2 },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 3 },
        { refId: 'character_image:angel', type: 'character', imageNumber: 2 },
      ],
    }));
    expect(refs).toEqual([]);
  });

  it('drops dups but keeps the surviving char when a setting anchors slot 1', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:bus', type: 'setting', imageNumber: 1 },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2 },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 3 }, // dup refId
        { refId: 'character_image:angel', type: 'character', imageNumber: 2 }, // dup slot
      ],
    }));
    expect(refs).toHaveLength(2);
    expect(refs.map(r => r.refId)).toEqual(['setting_image:bus', 'character_image:ruby']);
  });

  it('skips malformed entries (missing refId / imageNumber / bad type) and rejects when only character refs survive (no setting)', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { type: 'character', imageNumber: 2 },                              // no refId
        { refId: 'character_image:x', type: 'character' },                  // no imageNumber
        { refId: 'character_image:y', type: 'wrong', imageNumber: 3 },       // bad type
        { refId: 'character_image:good', type: 'character', imageNumber: 2 },
      ],
    }));
    // Only 'good' survives normalization, but it's a character with no
    // setting at slot 1 — refs array is unsafe to ship, fall back to
    // turn-1.
    expect(refs).toEqual([]);
  });

  it('returns [] on unparseable input (turn-2 keeps turn-1 refs)', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(parseTurn2RefsJson('not json at all')).toEqual([]);
    expect(parseTurn2RefsJson('')).toEqual([]);
    expect(parseTurn2RefsJson('{"references": "not an array"}')).toEqual([]);
  });

  // ── Should group: 2.x — references resolve cleanly, no missing ones ──

  it('Should 2.1 — caps refs at 4 by sorting on imageNumber (lowest slots survive)', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:s', type: 'setting', imageNumber: 1 },
        { refId: 'character_image:a', type: 'character', imageNumber: 2 },
        { refId: 'character_image:b', type: 'character', imageNumber: 3 },
        { refId: 'character_image:c', type: 'character', imageNumber: 4 },
        // These two should be capped out. parseTurn2RefsJson already
        // drops imageNumber > 4 at the per-entry stage (2.7), so any
        // ref with imageNumber>=5 never reaches the cap step — but the
        // dedup+cap still guards against any pathological input that
        // slipped past (e.g. duplicate slots within 1..4).
        { refId: 'character_image:d', type: 'character', imageNumber: 5 },
        { refId: 'character_image:e', type: 'character', imageNumber: 6 },
      ],
    }));
    expect(refs).toHaveLength(4);
    expect(refs.map(r => r.refId)).toEqual([
      'setting_image:s', 'character_image:a', 'character_image:b', 'character_image:c',
    ]);
  });

  it('Should 2.2 — a setting at the wrong slot is COERCED to slot 1 when slot 1 is free', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:bus', type: 'setting', imageNumber: 3 },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2 },
      ],
    }));
    expect(refs).toHaveLength(2);
    const setting = refs.find(r => r.type === 'setting');
    expect(setting?.imageNumber).toBe(1);
  });

  it('Should 2.2 (swap variant) — setting at wrong slot SWAPS with whoever is at slot 1', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'character_image:ruby', type: 'character', imageNumber: 1 }, // wrong — char at slot 1
        { refId: 'setting_image:bus', type: 'setting', imageNumber: 2 },     // wrong — setting at slot 2
      ],
    }));
    expect(refs).toHaveLength(2);
    expect(refs.find(r => r.type === 'setting')?.imageNumber).toBe(1);
    expect(refs.find(r => r.type === 'character')?.imageNumber).toBe(2);
  });

  it('Should 2.3 — TWO settings → reject ambiguous output, return [] (caller keeps turn-1)', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:bus', type: 'setting', imageNumber: 1 },
        { refId: 'setting_image:street', type: 'setting', imageNumber: 2 },
      ],
    }));
    expect(refs).toEqual([]);
  });

  it('Should 2.4 — character/object refs present but NO setting → reject, return []', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2 },
        { refId: 'character_image:angel', type: 'character', imageNumber: 3 },
      ],
    }));
    // Klein needs slot 1 as a base canvas — shipping char-only refs
    // silently produces an unbound generation. Reject and keep turn-1.
    expect(refs).toEqual([]);
  });

  it('Should 2.4 (text-to-image OK) — empty references array is allowed (pure text-to-image shot with no refs)', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({ references: [] }));
    expect(refs).toEqual([]);
    // Caller treats [] as "keep turn-1" — for a text-to-image shot
    // turn-1 itself will have produced []. The fallback is harmless.
  });

  it('Should 2.5 — invalid `side` values are dropped silently, ref itself is kept', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:bus', type: 'setting', imageNumber: 1, side: 'C' },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2, side: 99 },
      ],
    }));
    expect(refs).toHaveLength(2);
    expect(refs[0]?.side).toBeUndefined();
    expect(refs[1]?.side).toBeUndefined();
  });

  it('Should 2.6 — bare refId without typeId prefix is auto-canonicalized using the entry\'s `type`', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'bus_station', type: 'setting', imageNumber: 1 },
        { refId: 'ruby', type: 'character', imageNumber: 2 },
      ],
    }));
    expect(refs).toHaveLength(2);
    expect(refs.find(r => r.type === 'setting')?.refId).toBe('setting_image:bus_station');
    expect(refs.find(r => r.type === 'character')?.refId).toBe('character_image:ruby');
  });

  it('Should 2.6 (upstream-typed prefix) — `setting:bus` / `character:ruby` are re-prefixed to the image typeId', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting:bus', type: 'setting', imageNumber: 1 },
        { refId: 'character:ruby', type: 'character', imageNumber: 2 },
      ],
    }));
    expect(refs.find(r => r.type === 'setting')?.refId).toBe('setting_image:bus');
    expect(refs.find(r => r.type === 'character')?.refId).toBe('character_image:ruby');
  });

  it('Should 2.7 — imageNumber 0 / negative / non-integer / out-of-range → entry dropped', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:s', type: 'setting', imageNumber: 1 },
        { refId: 'character_image:zero', type: 'character', imageNumber: 0 },
        { refId: 'character_image:neg', type: 'character', imageNumber: -2 },
        { refId: 'character_image:fract', type: 'character', imageNumber: 2.5 },
        { refId: 'character_image:high', type: 'character', imageNumber: 99 },
        { refId: 'character_image:good', type: 'character', imageNumber: 2 },
      ],
    }));
    expect(refs).toHaveLength(2);
    expect(refs.map(r => r.refId).sort()).toEqual([
      'character_image:good', 'setting_image:s',
    ]);
  });

  it('Should 2.8 — status=new without newRefDescription → entry dropped (downstream gen has nothing to render from)', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:bus', type: 'setting', imageNumber: 1 },
        // 'new' with NO description → drop
        { refId: 'character_image:phantom', type: 'character', imageNumber: 2, status: 'new' },
        // 'new' WITH description → keep
        { refId: 'character_image:pawn_broker', type: 'character', imageNumber: 3, status: 'new',
          newRefDescription: 'Heavyset man, late 50s, bald, ink-stained apron.' },
      ],
    }));
    expect(refs.find(r => r.refId === 'character_image:phantom')).toBeUndefined();
    expect(refs.find(r => r.refId === 'character_image:pawn_broker')).toBeDefined();
  });

  it('Should 2.8 (whitespace) — status=new with whitespace-only newRefDescription is also dropped', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:bus', type: 'setting', imageNumber: 1 },
        { refId: 'character_image:x', type: 'character', imageNumber: 2, status: 'new', newRefDescription: '   \n  ' },
      ],
    }));
    expect(refs.find(r => r.refId === 'character_image:x')).toBeUndefined();
  });

  it('Should — happy path: setting + 2 characters with side A/B and Phase D derivedFrom all round-trip cleanly', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:bus_reverse', type: 'setting', imageNumber: 1, status: 'new',
          derivedFrom: 'setting_image:bus',
          newRefDescription: 'Reverse-angle reframe of the bus station — same lighting and palette, camera now at the opposite end.' },
        { refId: 'character_image:angel', type: 'character', imageNumber: 2, side: 'A' },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 3, side: 'B' },
      ],
    }));
    expect(refs).toHaveLength(3);
    expect(refs[0]?.derivedFrom).toBe('setting_image:bus');
    expect(refs[0]?.status).toBe('new');
    expect(refs[1]?.side).toBe('A');
    expect(refs[2]?.side).toBe('B');
  });

  // ── 6.x: Side A/B pairing invariants ─────────────────────────────────
  //
  // Side A and Side B are camera-angle labels for one OTS exchange.
  // They live on CHARACTERS to mark which one is the in-frame subject
  // (side='A') vs. the OTS silhouette (side='B'). The labels are
  // meaningful ONLY when there's an OTS pair — two characters in the
  // same shot, one facing the camera, one with their back to it.
  //
  // The LLM slips in three predictable ways. We defend against all of
  // them in parseTurn2RefsJson so a bad turn-2 emission can't ship to
  // Klein with an internally-inconsistent pairing.

  it('Should 6.1 — two chars both marked side=\'A\' → ALL side labels stripped (no valid A+B pair exists after dedup)', async () => {
    // Dedup removes the duplicate label, but the result has one A and
    // no B — still not a valid pair. The invariant is "side labels must
    // form a complete A+B pair, else strip everything." Better to ship
    // no labels than to ship Klein an asymmetric framing.
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:bus', type: 'setting', imageNumber: 1 },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2, side: 'A' },
        { refId: 'character_image:angel', type: 'character', imageNumber: 3, side: 'A' },
      ],
    }));
    expect(refs).toHaveLength(3);
    expect(refs.find(r => r.refId === 'character_image:ruby')?.side).toBeUndefined();
    expect(refs.find(r => r.refId === 'character_image:angel')?.side).toBeUndefined();
  });

  it('Should 6.1 — two chars both marked side=\'B\' → ALL side labels stripped (no valid A+B pair)', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:bus', type: 'setting', imageNumber: 1 },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2, side: 'B' },
        { refId: 'character_image:angel', type: 'character', imageNumber: 3, side: 'B' },
      ],
    }));
    expect(refs).toHaveLength(3);
    expect(refs.find(r => r.refId === 'character_image:ruby')?.side).toBeUndefined();
    expect(refs.find(r => r.refId === 'character_image:angel')?.side).toBeUndefined();
  });

  it('Should 6.1 — one A and one B → BOTH preserved (this is the only valid OTS pairing)', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:bus', type: 'setting', imageNumber: 1 },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2, side: 'A' },
        { refId: 'character_image:angel', type: 'character', imageNumber: 3, side: 'B' },
      ],
    }));
    expect(refs.find(r => r.refId === 'character_image:ruby')?.side).toBe('A');
    expect(refs.find(r => r.refId === 'character_image:angel')?.side).toBe('B');
  });

  it('Should 6.2 — side label on a SETTING is stripped (sides apply only to characters; settings carry the angle via derivedFrom)', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:bus', type: 'setting', imageNumber: 1, side: 'A' },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2, side: 'A' },
      ],
    }));
    // Setting's side is stripped per 6.2. The lone character's side is
    // ALSO stripped per 6.3 (only one character → no OTS pair possible).
    expect(refs.find(r => r.type === 'setting')?.side).toBeUndefined();
    expect(refs.find(r => r.type === 'character')?.side).toBeUndefined();
  });

  it('Should 6.2 — side label on an OBJECT is stripped for the same reason', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:bus', type: 'setting', imageNumber: 1 },
        { refId: 'object_image:revolver', type: 'object', imageNumber: 2, side: 'B' },
      ],
    }));
    expect(refs.find(r => r.type === 'object')?.side).toBeUndefined();
  });

  it('Should 6.3 — single character ref with a side label → side stripped (OTS labels require a PAIR; one character alone is solo framing)', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:bus', type: 'setting', imageNumber: 1 },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2, side: 'A' },
      ],
    }));
    expect(refs.find(r => r.refId === 'character_image:ruby')?.side).toBeUndefined();
  });

  it('Should 6.3 — same for side=\'B\' alone (orphan silhouette would need a phantom partner)', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:bus', type: 'setting', imageNumber: 1 },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2, side: 'B' },
      ],
    }));
    expect(refs.find(r => r.refId === 'character_image:ruby')?.side).toBeUndefined();
  });

  it('Should 6 — combined: two chars one with side, the other without → side stripped (we need BOTH labelled, not just one)', async () => {
    // If one character is labelled and the other isn\'t, the pair is
    // half-specified. Better to drop the lone label so the prose-level
    // framing speaks for itself than to ship Klein an asymmetric pair.
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:bus', type: 'setting', imageNumber: 1 },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2, side: 'A' },
        { refId: 'character_image:angel', type: 'character', imageNumber: 3 }, // no side
      ],
    }));
    expect(refs.find(r => r.refId === 'character_image:ruby')?.side).toBeUndefined();
    expect(refs.find(r => r.refId === 'character_image:angel')?.side).toBeUndefined();
  });

  it('Should 6 — three characters with valid A+B pair plus a third unlabelled → A/B pair survives, third stays unlabelled', async () => {
    // OTS still works when there's a third character on stage who is
    // neither foreground nor silhouette. The A/B labels mark the two
    // who define the angle; extras are extras.
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = parseTurn2RefsJson(JSON.stringify({
      references: [
        { refId: 'setting_image:bus', type: 'setting', imageNumber: 1 },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2, side: 'A' },
        { refId: 'character_image:angel', type: 'character', imageNumber: 3, side: 'B' },
        { refId: 'character_image:driver', type: 'character', imageNumber: 4 },
      ],
    }));
    expect(refs.find(r => r.refId === 'character_image:ruby')?.side).toBe('A');
    expect(refs.find(r => r.refId === 'character_image:angel')?.side).toBe('B');
    expect(refs.find(r => r.refId === 'character_image:driver')?.side).toBeUndefined();
  });

  it('preserves derivedFrom when LLM emits it on a status=new ref (Phase D); strips redundant side label on the setting', async () => {
    // Note: the LLM sometimes attaches side='B' to the reverse setting,
    // but settings don't carry a `side` label — the reverse angle is
    // encoded by `derivedFrom` itself (6.2 strips the side). This is
    // not data loss — derivedFrom + the canonical `_reverse` refId
    // already mark this as the Side B canvas.
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const raw = JSON.stringify({
      references: [
        { refId: 'setting_image:bus_station_morning_reverse', type: 'setting', imageNumber: 1,
          status: 'new', side: 'B',
          derivedFrom: 'setting_image:bus_station_morning',
          newRefDescription: 'Reverse-angle reframe of the bus station — same lighting, opposite direction.' },
      ],
    });
    const refs = parseTurn2RefsJson(raw);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.derivedFrom).toBe('setting_image:bus_station_morning');
    expect(refs[0]?.status).toBe('new');
    // Side stripped from the setting (6.2). The reverse angle is
    // already signalled by derivedFrom + the `_reverse` suffix.
    expect(refs[0]?.side).toBeUndefined();
  });
});

describe('shotImagePipeline: stripSettingFromEditFirstFrameFrames — Invariant I3', () => {
  it('strips setting refs from a frame with generationMode=edit_first_frame', async () => {
    const { stripSettingFromEditFirstFrameFrames } = await import('../../src/core/planner/shotImagePipeline.js');
    const parsed = {
      frames: {
        first_frame: {
          generationMode: 'image_text_to_image',
          references: [
            { refId: 'setting_image:bus', type: 'setting' as const, imageNumber: 1 },
            { refId: 'character_image:ruby', type: 'character' as const, imageNumber: 2 },
          ],
          imagePrompt: 'ignored',
        },
        last_frame: {
          generationMode: 'edit_first_frame',
          references: [
            { refId: 'setting_image:bus', type: 'setting' as const, imageNumber: 1 },
            { refId: 'character_image:ruby', type: 'character' as const, imageNumber: 2 },
          ],
          imagePrompt: 'ignored',
        },
      },
    };
    stripSettingFromEditFirstFrameFrames(parsed);
    // first_frame untouched — not in edit_first_frame mode.
    expect(parsed.frames.first_frame.references.map(r => r.refId)).toEqual([
      'setting_image:bus', 'character_image:ruby',
    ]);
    // last_frame loses the setting; character ref preserved.
    expect(parsed.frames.last_frame.references.map(r => r.refId)).toEqual([
      'character_image:ruby',
    ]);
  });

  it('preserves character + object refs on edit_first_frame frames (only setting is stripped)', async () => {
    const { stripSettingFromEditFirstFrameFrames } = await import('../../src/core/planner/shotImagePipeline.js');
    const parsed = {
      frames: {
        last_frame: {
          generationMode: 'edit_first_frame',
          references: [
            { refId: 'setting_image:bus', type: 'setting' as const, imageNumber: 1 },
            { refId: 'character_image:ruby', type: 'character' as const, imageNumber: 2 },
            { refId: 'character_image:angel', type: 'character' as const, imageNumber: 3 },
            { refId: 'object_image:revolver', type: 'object' as const, imageNumber: 4 },
          ],
        },
      },
    };
    stripSettingFromEditFirstFrameFrames(parsed);
    expect(parsed.frames.last_frame.references.map(r => r.refId)).toEqual([
      'character_image:ruby', 'character_image:angel', 'object_image:revolver',
    ]);
  });

  it('is a no-op on frames whose generationMode is NOT edit_first_frame (image_text_to_image)', async () => {
    const { stripSettingFromEditFirstFrameFrames } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = [
      { refId: 'setting_image:bus', type: 'setting' as const, imageNumber: 1 },
      { refId: 'character_image:ruby', type: 'character' as const, imageNumber: 2 },
    ];
    const parsed = {
      frames: {
        first_frame: { generationMode: 'image_text_to_image', references: refs },
      },
    };
    stripSettingFromEditFirstFrameFrames(parsed);
    expect(parsed.frames.first_frame.references).toHaveLength(2);
    expect(parsed.frames.first_frame.references[0]?.type).toBe('setting');
  });

  it('is a no-op on frames whose generationMode is edit_previous_shot (still fresh-rendered, needs setting)', async () => {
    const { stripSettingFromEditFirstFrameFrames } = await import('../../src/core/planner/shotImagePipeline.js');
    const parsed = {
      frames: {
        first_frame: {
          generationMode: 'edit_previous_shot',
          references: [
            { refId: 'setting_image:bus', type: 'setting' as const, imageNumber: 1 },
            { refId: 'character_image:ruby', type: 'character' as const, imageNumber: 2 },
          ],
        },
      },
    };
    stripSettingFromEditFirstFrameFrames(parsed);
    // edit_previous_shot chains on prior shot's last_frame, but the current
    // shot is still rendered fresh — the setting binds to slot 1 alongside
    // the prior shot's anchor. Don't strip.
    expect(parsed.frames.first_frame.references).toHaveLength(2);
    expect(parsed.frames.first_frame.references[0]?.type).toBe('setting');
  });

  it('handles multiple settings (the parser dedup would normally prevent this, but the strip must still work)', async () => {
    const { stripSettingFromEditFirstFrameFrames } = await import('../../src/core/planner/shotImagePipeline.js');
    const parsed = {
      frames: {
        last_frame: {
          generationMode: 'edit_first_frame',
          references: [
            { refId: 'setting_image:a', type: 'setting' as const, imageNumber: 1 },
            { refId: 'setting_image:b', type: 'setting' as const, imageNumber: 2 },
            { refId: 'character_image:ruby', type: 'character' as const, imageNumber: 3 },
          ],
        },
      },
    };
    stripSettingFromEditFirstFrameFrames(parsed);
    expect(parsed.frames.last_frame.references.map(r => r.type)).toEqual(['character']);
  });

  it('is idempotent — running twice produces the same result as running once', async () => {
    const { stripSettingFromEditFirstFrameFrames } = await import('../../src/core/planner/shotImagePipeline.js');
    const make = () => ({
      frames: {
        last_frame: {
          generationMode: 'edit_first_frame',
          references: [
            { refId: 'setting_image:bus', type: 'setting' as const, imageNumber: 1 },
            { refId: 'character_image:ruby', type: 'character' as const, imageNumber: 2 },
          ],
        },
      },
    });
    const once = stripSettingFromEditFirstFrameFrames(make());
    const twice = stripSettingFromEditFirstFrameFrames(stripSettingFromEditFirstFrameFrames(make()));
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it('handles a frame with no references[] field (defensive)', async () => {
    const { stripSettingFromEditFirstFrameFrames } = await import('../../src/core/planner/shotImagePipeline.js');
    const parsed = {
      frames: {
        last_frame: { generationMode: 'edit_first_frame' },
      },
    } as unknown as Parameters<typeof stripSettingFromEditFirstFrameFrames>[0];
    expect(() => stripSettingFromEditFirstFrameFrames(parsed)).not.toThrow();
  });
});

describe('shotImagePipeline: applyShotImageManifestPostPass (turn-2 ref refinement seam)', () => {
  it('rebuilds the manifest line from the CURRENT references[] after turn-2 swaps refs (the Ruby V3 s1s1 regression)', async () => {
    const { applyShotImageManifestPostPass } = await import('../../src/core/planner/shotImagePipeline.js');
    // Simulate turn-1's output: prose with a stale manifest line built
    // from turn-1's incomplete refs (Ruby only, no setting).
    type R = { refId: string; type: 'character' | 'setting' | 'object'; imageNumber: number };
    const parsed: {
      frames: {
        first_frame: { imagePrompt: string; references: R[] };
        last_frame: { imagePrompt: string; references: R[] };
      };
    } = {
      frames: {
        first_frame: {
          imagePrompt: 'Ruby from image 1.\n\nPhotorealistic cinematic still — Ruby descends from the bus, her green eyes sweep the platform with intense curiosity.',
          references: [{ refId: 'character_image:ruby', type: 'character', imageNumber: 1 }],
        },
        last_frame: {
          imagePrompt: 'Ruby from image 1.\n\nRuby has finished descending, standing on the platform.',
          references: [{ refId: 'character_image:ruby', type: 'character', imageNumber: 1 }],
        },
      },
    };
    // Simulate turn-2: ref refinement swaps the array to put the setting
    // at slot 1 and Ruby at slot 2 (the AUTHORITATIVE refs).
    const turn2Refs: R[] = [
      { refId: 'setting_image:city_bus_station', type: 'setting', imageNumber: 1 },
      { refId: 'character_image:ruby', type: 'character', imageNumber: 2 },
    ];
    parsed.frames.first_frame.references = turn2Refs;
    parsed.frames.last_frame.references = turn2Refs;

    // The post-pass must now rebuild the manifest from the new refs.
    applyShotImageManifestPostPass(parsed);

    // Manifest must lead with the setting at slot 1, Ruby at slot 2.
    expect(parsed.frames.first_frame.imagePrompt).toMatch(
      /^City Bus Station \(setting\) from image 1\. Ruby from image 2\./,
    );
    expect(parsed.frames.last_frame.imagePrompt).toMatch(
      /^City Bus Station \(setting\) from image 1\. Ruby from image 2\./,
    );
    // The stale "Ruby from image 1." from turn-1 must NOT survive
    // mid-prose. The prose body should mention "Ruby" but not bound
    // to a stale slot number.
    expect(parsed.frames.first_frame.imagePrompt).not.toContain('Ruby from image 1.');
    // Setting must be present in the manifest — the original bug was
    // that the setting was silently dropped from Klein's conditioning.
    expect(parsed.frames.first_frame.imagePrompt).toContain('City Bus Station (setting)');
  });

  it('is idempotent — running twice produces the same result as running once', async () => {
    const { applyShotImageManifestPostPass } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = [
      { refId: 'setting_image:bus', type: 'setting' as const, imageNumber: 1 },
      { refId: 'character_image:ruby', type: 'character' as const, imageNumber: 2 },
    ];
    const make = () => ({
      frames: {
        first_frame: {
          imagePrompt: 'Some prior manifest line from image 9.\n\nRuby walks on the platform.',
          references: refs,
        },
      },
    });
    const once = applyShotImageManifestPostPass(make());
    const twice = applyShotImageManifestPostPass(applyShotImageManifestPostPass(make()));
    expect(once.frames.first_frame.imagePrompt).toBe(twice.frames.first_frame.imagePrompt);
  });

  it('handles a frame with no references — no manifest line prepended', async () => {
    const { applyShotImageManifestPostPass } = await import('../../src/core/planner/shotImagePipeline.js');
    const parsed = {
      frames: {
        first_frame: {
          imagePrompt: 'A pure text-to-image scene with no character or setting refs.',
          references: [] as Array<{ refId: string; type: 'character' | 'setting' | 'object'; imageNumber: number }>,
        },
      },
    };
    applyShotImageManifestPostPass(parsed);
    expect(parsed.frames.first_frame.imagePrompt).toBe(
      'A pure text-to-image scene with no character or setting refs.',
    );
  });

  it('does NOT scrub inline `from image N` from the prose body — Klein binds via the top manifest, body is trusted as-is', async () => {
    // Policy: stop grepping the body for slot tokens. The manifest at
    // the top is the single source of slot binding; whatever the LLM
    // emitted in the body is its prose to keep. Trying to launder it
    // is busywork that risks damaging legitimate narrative (and we
    // don't instruct the LLM to write it in the first place — so if it
    // does, it's the LLM's choice, not our problem to clean up).
    const { applyShotImageManifestPostPass } = await import('../../src/core/planner/shotImagePipeline.js');
    const parsed = {
      frames: {
        first_frame: {
          imagePrompt: 'Ruby from image 3 walks past.',
          references: [
            { refId: 'character_image:ruby', type: 'character' as const, imageNumber: 2 },
          ],
        },
      },
    };
    applyShotImageManifestPostPass(parsed);
    // The manifest is rebuilt from references[] (Ruby@2), but the
    // body's "from image 3" is preserved verbatim.
    expect(parsed.frames.first_frame.imagePrompt.startsWith('Ruby from image 2.')).toBe(true);
    expect(parsed.frames.first_frame.imagePrompt).toContain('Ruby from image 3 walks past.');
  });

  it('updates BOTH first_frame and last_frame when each has its own references[]', async () => {
    const { applyShotImageManifestPostPass } = await import('../../src/core/planner/shotImagePipeline.js');
    const parsed = {
      frames: {
        first_frame: {
          imagePrompt: 'Stale manifest from image 1.\n\nFirst frame body.',
          references: [
            { refId: 'setting_image:office', type: 'setting' as const, imageNumber: 1 },
          ],
        },
        last_frame: {
          imagePrompt: 'Another stale from image 7.\n\nLast frame body.',
          references: [
            { refId: 'setting_image:office', type: 'setting' as const, imageNumber: 1 },
            { refId: 'character_image:angel', type: 'character' as const, imageNumber: 2 },
          ],
        },
      },
    };
    applyShotImageManifestPostPass(parsed);
    expect(parsed.frames.first_frame.imagePrompt.startsWith('Office (setting) from image 1.')).toBe(true);
    expect(parsed.frames.last_frame.imagePrompt.startsWith('Office (setting) from image 1. Angel from image 2.')).toBe(true);
  });
});

describe('shotImagePipeline: buildTurn2UserMessage Phase D + dedup guidance', () => {
  it('includes stable naming convention for cross-shot dedup', async () => {
    const { buildTurn2UserMessage } = await import('../../src/core/planner/shotImagePipeline.js');
    const msg = buildTurn2UserMessage([
      { refId: 'setting_image:bus_station_morning', type: 'setting', label: 'Bus Station', description: '' },
    ]);
    expect(msg).toContain('Naming convention');
    expect(msg).toContain('SAME refId');
    expect(msg).toContain('snake_case');
  });

  it('instructs the LLM to use derivedFrom for OTS Side B reverse settings', async () => {
    const { buildTurn2UserMessage } = await import('../../src/core/planner/shotImagePipeline.js');
    const msg = buildTurn2UserMessage(
      [{ refId: 'setting_image:bus_station_morning', type: 'setting', label: 'Bus Station', description: '' }],
      { otsHint: true },
    );
    expect(msg).toContain('derivedFrom');
    expect(msg).toContain('_reverse');
    expect(msg).toContain('REVERSE setting');
  });

  it('teaches the LLM that Side A and Side B are SHOT properties, not character properties', async () => {
    const { buildTurn2UserMessage } = await import('../../src/core/planner/shotImagePipeline.js');
    const msg = buildTurn2UserMessage([], { otsHint: true });
    expect(msg).toContain('TWO');
    expect(msg).toContain('CAMERA ANGLES');
    expect(msg).toContain('NOT character properties');
  });

  it('spells out the setting-variant + character-role interlock (Side A → base setting, Side B → reverse + swap)', async () => {
    const { buildTurn2UserMessage } = await import('../../src/core/planner/shotImagePipeline.js');
    const msg = buildTurn2UserMessage([], { otsHint: true });
    expect(msg).toContain('Side A');
    expect(msg).toContain('BASE setting');
    expect(msg).toContain('Side B');
    expect(msg).toContain('REVERSE setting');
    expect(msg).toContain('swap');
  });

  it('uses the menu description field as visual grounding for OTS framing decisions', async () => {
    const { buildTurn2UserMessage } = await import('../../src/core/planner/shotImagePipeline.js');
    const msg = buildTurn2UserMessage([
      { refId: 'setting_image:bus_station', type: 'setting', label: 'Bus Station',
        description: 'A brutalist concrete terminal with a wide canopy, numbered boarding bays facing the street, payphone near the back wall.' },
    ]);
    expect(msg).toContain('description');
    expect(msg).toContain('brutalist concrete terminal');
  });
});

describe('shotImagePipeline: normalizeDerivedFromRefId (Must 3.6 / 3.7)', () => {
  it('passes through a fully-qualified image-typed refId unchanged', async () => {
    const { normalizeDerivedFromRefId } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(normalizeDerivedFromRefId('setting_image:bus_station', 'setting')).toBe('setting_image:bus_station');
    expect(normalizeDerivedFromRefId('character_image:ruby', 'character')).toBe('character_image:ruby');
  });

  it('coerces a bare itemId by prefixing the image typeId for the given refType', async () => {
    const { normalizeDerivedFromRefId } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(normalizeDerivedFromRefId('bus_station_morning', 'setting')).toBe('setting_image:bus_station_morning');
    expect(normalizeDerivedFromRefId('ruby', 'character')).toBe('character_image:ruby');
    expect(normalizeDerivedFromRefId('silver_revolver', 'object')).toBe('object_image:silver_revolver');
  });

  it('re-prefixes an upstream-typed refId (e.g. `setting:X`) to the image typeId', async () => {
    const { normalizeDerivedFromRefId } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(normalizeDerivedFromRefId('setting:bus_station', 'setting')).toBe('setting_image:bus_station');
    expect(normalizeDerivedFromRefId('character:ruby', 'character')).toBe('character_image:ruby');
  });
});

describe('shotImagePipeline: resolveDerivedFromBase (Must 3.1 / 3.2 / 3.4)', () => {
  type Node = { typeId: string; itemId?: string; outputPath?: string; artifactId?: string; metadata?: { derivedFrom?: string } };

  it('returns {ref: null, reason: "no-derived-from"} when derivedFrom is undefined or empty', async () => {
    const { resolveDerivedFromBase } = await import('../../src/core/planner/shotImagePipeline.js');
    const res = resolveDerivedFromBase(undefined, () => undefined);
    expect(res.ref).toBeNull();
    expect(res.reason).toBe('no-derived-from');
  });

  it('returns {ref: null, reason: "missing-parent"} when the parent node does not exist (Must 3.1)', async () => {
    const { resolveDerivedFromBase } = await import('../../src/core/planner/shotImagePipeline.js');
    const res = resolveDerivedFromBase(
      'setting_image:nonexistent',
      (_id) => undefined,
    );
    expect(res.ref).toBeNull();
    expect(res.reason).toBe('missing-parent');
  });

  it('returns {ref: null, reason: "no-output"} when the parent has no outputPath yet (Must 3.2 — still pending)', async () => {
    const { resolveDerivedFromBase } = await import('../../src/core/planner/shotImagePipeline.js');
    const nodes: Record<string, Node> = {
      'setting_image:bus_station': { typeId: 'setting_image', itemId: 'bus_station', artifactId: 'artif-1' },
    };
    const res = resolveDerivedFromBase('setting_image:bus_station', (id) => nodes[id]);
    expect(res.ref).toBeNull();
    expect(res.reason).toBe('no-output');
  });

  it('returns {ref: null, reason: "no-artifact"} when the parent has an outputPath but no artifactId', async () => {
    const { resolveDerivedFromBase } = await import('../../src/core/planner/shotImagePipeline.js');
    const nodes: Record<string, Node> = {
      'setting_image:bus_station': { typeId: 'setting_image', itemId: 'bus_station', outputPath: '/p/x.png' },
    };
    const res = resolveDerivedFromBase('setting_image:bus_station', (id) => nodes[id]);
    expect(res.ref).toBeNull();
    expect(res.reason).toBe('no-artifact');
  });

  it('returns the immediate parent as a ChainedEditRef when the parent is fully rendered', async () => {
    const { resolveDerivedFromBase } = await import('../../src/core/planner/shotImagePipeline.js');
    const nodes: Record<string, Node> = {
      'setting_image:bus_station': {
        typeId: 'setting_image',
        itemId: 'bus_station',
        outputPath: '/projects/X/assets/images/settings/bus_station.png',
        artifactId: 'artif-bus-1',
      },
    };
    const res = resolveDerivedFromBase('setting_image:bus_station', (id) => nodes[id]);
    expect(res.ref).not.toBeNull();
    expect(res.ref!.type).toBe('setting');
    expect(res.ref!.artifactId).toBe('artif-bus-1');
    expect(res.ref!.name).toBe('bus_station');
    expect(res.ref!.parentOutputPath).toBe('/projects/X/assets/images/settings/bus_station.png');
  });

  it('detects a direct cycle (A → B → A) and returns {ref: null, reason: "cycle"} — Must 3.4 (no infinite loop)', async () => {
    const { resolveDerivedFromBase } = await import('../../src/core/planner/shotImagePipeline.js');
    const nodes: Record<string, Node> = {
      'setting_image:a': { typeId: 'setting_image', itemId: 'a', outputPath: '/x/a.png', artifactId: 'a1', metadata: { derivedFrom: 'setting_image:b' } },
      'setting_image:b': { typeId: 'setting_image', itemId: 'b', outputPath: '/x/b.png', artifactId: 'b1', metadata: { derivedFrom: 'setting_image:a' } },
    };
    const res = resolveDerivedFromBase('setting_image:a', (id) => nodes[id]);
    expect(res.ref).toBeNull();
    expect(res.reason).toBe('cycle');
  });

  it('detects a longer cycle (A → B → C → A)', async () => {
    const { resolveDerivedFromBase } = await import('../../src/core/planner/shotImagePipeline.js');
    const nodes: Record<string, Node> = {
      'setting_image:a': { typeId: 'setting_image', itemId: 'a', outputPath: '/p/a', artifactId: 'a', metadata: { derivedFrom: 'setting_image:b' } },
      'setting_image:b': { typeId: 'setting_image', itemId: 'b', outputPath: '/p/b', artifactId: 'b', metadata: { derivedFrom: 'setting_image:c' } },
      'setting_image:c': { typeId: 'setting_image', itemId: 'c', outputPath: '/p/c', artifactId: 'c', metadata: { derivedFrom: 'setting_image:a' } },
    };
    const res = resolveDerivedFromBase('setting_image:a', (id) => nodes[id]);
    expect(res.ref).toBeNull();
    expect(res.reason).toBe('cycle');
  });

  it('walks a non-cyclic chain and returns only the IMMEDIATE parent (Klein handles the rest via successive edits)', async () => {
    const { resolveDerivedFromBase } = await import('../../src/core/planner/shotImagePipeline.js');
    const nodes: Record<string, Node> = {
      'setting_image:grandparent': { typeId: 'setting_image', itemId: 'grandparent', outputPath: '/p/g.png', artifactId: 'g1' },
      'setting_image:parent': { typeId: 'setting_image', itemId: 'parent', outputPath: '/p/p.png', artifactId: 'p1', metadata: { derivedFrom: 'setting_image:grandparent' } },
    };
    const res = resolveDerivedFromBase('setting_image:parent', (id) => nodes[id]);
    expect(res.ref).not.toBeNull();
    expect(res.ref!.name).toBe('parent');
    expect(res.ref!.parentOutputPath).toBe('/p/p.png');
  });

  it('respects maxDepth so a pathological chain cannot stall the resolver', async () => {
    const { resolveDerivedFromBase } = await import('../../src/core/planner/shotImagePipeline.js');
    const nodes: Record<string, Node> = {};
    for (let i = 0; i < 20; i++) {
      nodes[`setting_image:n${i}`] = {
        typeId: 'setting_image',
        itemId: `n${i}`,
        outputPath: `/p/${i}`,
        artifactId: `a${i}`,
        metadata: { derivedFrom: `setting_image:n${i + 1}` },
      };
    }
    const res = resolveDerivedFromBase('setting_image:n0', (id) => nodes[id], { maxDepth: 5 });
    expect(res.ref).toBeNull();
    expect(res.reason).toBe('depth-exceeded');
  });

  it('coerces character_image parents to type=character on the returned ref', async () => {
    const { resolveDerivedFromBase } = await import('../../src/core/planner/shotImagePipeline.js');
    const nodes: Record<string, Node> = {
      'character_image:ruby_younger': {
        typeId: 'character_image', itemId: 'ruby_younger',
        outputPath: '/p/ry.png', artifactId: 'ry1',
      },
    };
    const res = resolveDerivedFromBase('character_image:ruby_younger', (id) => nodes[id]);
    expect(res.ref?.type).toBe('character');
  });
});

describe('shotImagePipeline: applyShotImageManifestPostPass — Must 1.4 (idempotent across N runs)', () => {
  it('produces a stable fixed point after 3+ consecutive runs (the post-pass may be invoked multiple times during repair / retry)', async () => {
    const { applyShotImageManifestPostPass } = await import('../../src/core/planner/shotImagePipeline.js');
    const refs = [
      { refId: 'setting_image:bus_station', type: 'setting' as const, imageNumber: 1 },
      { refId: 'character_image:ruby', type: 'character' as const, imageNumber: 2 },
      { refId: 'character_image:angel', type: 'character' as const, imageNumber: 3 },
    ];
    const make = () => ({
      frames: {
        first_frame: {
          imagePrompt: 'Ruby from image 9.\n\nProse body about Ruby and Angel at the station.',
          references: refs,
        },
      },
    });
    const r1 = applyShotImageManifestPostPass(make()).frames.first_frame.imagePrompt;
    const r2 = applyShotImageManifestPostPass(applyShotImageManifestPostPass(make())).frames.first_frame.imagePrompt;
    const r3 = applyShotImageManifestPostPass(applyShotImageManifestPostPass(applyShotImageManifestPostPass(make()))).frames.first_frame.imagePrompt;
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    // And the manifest at the top must reflect THE refs, not some intermediate state.
    expect(r3.startsWith('Bus Station (setting) from image 1. Ruby from image 2. Angel from image 3.')).toBe(true);
  });
});

describe('shotImagePipeline: applyShotImageManifestPostPass — Must 7.3 (narrative prose preservation)', () => {
  it('does NOT strip a narrative sentence that happens to contain "Name from image N" as part of a longer clause', async () => {
    const { applyShotImageManifestPostPass } = await import('../../src/core/planner/shotImagePipeline.js');
    // This is a single narrative sentence with "from image N" embedded mid-clause,
    // NOT a manifest block. The leading-paragraph strip must leave it alone.
    const parsed = {
      frames: {
        first_frame: {
          imagePrompt: 'Ruby from image 1 leaped over the wall, then Angel from image 2 ran ahead through the rain-slick street.',
          references: [
            { refId: 'setting_image:street', type: 'setting' as const, imageNumber: 1 },
            { refId: 'character_image:ruby', type: 'character' as const, imageNumber: 2 },
          ],
        },
      },
    };
    applyShotImageManifestPostPass(parsed);
    // The narrative survives entirely — we don't grep the body for slot
    // tokens anymore. The leading-manifest detector only matches a
    // contiguous run of "Name from image N." sentences ENDING with a
    // blank line, which doesn't happen here (the prose continues into
    // "leaped over the wall, then..."). A fresh manifest leads the prose.
    expect(parsed.frames.first_frame.imagePrompt).toContain('leaped over the wall');
    expect(parsed.frames.first_frame.imagePrompt).toContain('ran ahead through');
    // The whole original sentence — including its "from image N" tokens —
    // is preserved verbatim in the body.
    expect(parsed.frames.first_frame.imagePrompt).toContain('Ruby from image 1 leaped over the wall');
    expect(parsed.frames.first_frame.imagePrompt).toContain('Angel from image 2 ran ahead through');
    expect(parsed.frames.first_frame.imagePrompt.startsWith('Street (setting) from image 1. Ruby from image 2.')).toBe(true);
  });

  it('strips a TRUE manifest paragraph (multiple "Name from image N." sentences followed by a blank line)', async () => {
    const { applyShotImageManifestPostPass } = await import('../../src/core/planner/shotImagePipeline.js');
    const parsed = {
      frames: {
        first_frame: {
          imagePrompt: 'Old Setting (setting) from image 1. Old Char from image 2.\n\nThe real prose begins here.',
          references: [
            { refId: 'setting_image:new_setting', type: 'setting' as const, imageNumber: 1 },
            { refId: 'character_image:new_char', type: 'character' as const, imageNumber: 2 },
          ],
        },
      },
    };
    applyShotImageManifestPostPass(parsed);
    // Stale manifest gone, new manifest in place, body intact.
    expect(parsed.frames.first_frame.imagePrompt).not.toContain('Old Setting');
    expect(parsed.frames.first_frame.imagePrompt).not.toContain('Old Char');
    expect(parsed.frames.first_frame.imagePrompt).toContain('New Setting (setting) from image 1. New Char from image 2.');
    expect(parsed.frames.first_frame.imagePrompt).toContain('The real prose begins here.');
  });

  it('does NOT strip a leading sentence that mentions "image" in a non-slot context ("she stares at the image of her mother")', async () => {
    const { applyShotImageManifestPostPass } = await import('../../src/core/planner/shotImagePipeline.js');
    const parsed = {
      frames: {
        first_frame: {
          imagePrompt: 'She stares at the image of her mother, then turns away.',
          references: [
            { refId: 'character_image:ruby', type: 'character' as const, imageNumber: 1 },
          ],
        },
      },
    };
    applyShotImageManifestPostPass(parsed);
    expect(parsed.frames.first_frame.imagePrompt).toContain('image of her mother');
  });
});

describe('shotImagePipeline: parseTurn2RefsJson — Must 1.1 (null/empty fallback)', () => {
  it('returns [] on an empty references array — caller falls back to turn-1 refs', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(parseTurn2RefsJson(JSON.stringify({ references: [] }))).toEqual([]);
  });

  it('returns [] when references is missing entirely from the JSON', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(parseTurn2RefsJson(JSON.stringify({ other_field: 'x' }))).toEqual([]);
  });

  it('returns [] when every entry is malformed — caller MUST treat this as "keep turn-1 refs"', async () => {
    const { parseTurn2RefsJson } = await import('../../src/core/planner/shotImagePipeline.js');
    const allBad = JSON.stringify({
      references: [
        { type: 'character' }, { refId: 'x' }, { imageNumber: 1 },
        { refId: 'y', type: 'invalid', imageNumber: 1 },
      ],
    });
    expect(parseTurn2RefsJson(allBad)).toEqual([]);
  });

  it('documents derivedFrom field in the output schema', async () => {
    const { buildTurn2UserMessage } = await import('../../src/core/planner/shotImagePipeline.js');
    const msg = buildTurn2UserMessage([]);
    expect(msg).toContain('`derivedFrom`');
  });
});

describe('shotImagePipeline: isHoldingBeat — holding-beat detection for skip-LF', () => {
  it('returns true for hold_emotion with static cameraWork', async () => {
    const { isHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(isHoldingBeat('hold_emotion', 'medium close-up, eye-level')).toBe(true);
  });

  it('returns true for show_reaction without motion verbs', async () => {
    const { isHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(isHoldingBeat('show_reaction', 'close-up, slight low angle')).toBe(true);
  });

  it('returns true for set_the_mood, set_the_world, show_dialogue, show_clue, punctuate when static', async () => {
    const { isHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(isHoldingBeat('set_the_mood', 'wide')).toBe(true);
    expect(isHoldingBeat('set_the_world', 'extreme wide establishing')).toBe(true);
    expect(isHoldingBeat('show_dialogue', 'medium two-shot')).toBe(true);
    expect(isHoldingBeat('show_clue', 'insert macro')).toBe(true);
    expect(isHoldingBeat('punctuate', 'cut to black')).toBe(true);
  });

  it('returns false when cameraWork includes a motion verb', async () => {
    const { isHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(isHoldingBeat('hold_emotion', 'slow push in on her face')).toBe(false);
    expect(isHoldingBeat('show_reaction', 'tracking shot following her')).toBe(false);
    expect(isHoldingBeat('set_the_mood', 'crane up over the city')).toBe(false);
    expect(isHoldingBeat('show_dialogue', 'dolly back as they walk')).toBe(false);
  });

  it('returns false for action-y purposes regardless of cameraWork', async () => {
    const { isHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(isHoldingBeat('show_action', 'static medium')).toBe(false);
    expect(isHoldingBeat('show_change', 'static medium')).toBe(false);
    expect(isHoldingBeat('meet_character', 'static medium')).toBe(false);
    expect(isHoldingBeat('show_passage', 'static medium')).toBe(false);
    expect(isHoldingBeat('show_tension', 'static medium')).toBe(false);
  });

  it('returns false on unknown / empty purpose', async () => {
    const { isHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(isHoldingBeat('', 'medium')).toBe(false);
    expect(isHoldingBeat('not_a_real_purpose', 'medium')).toBe(false);
  });

  it('returns true when cameraWork is empty (trusts the purpose alone)', async () => {
    const { isHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(isHoldingBeat('hold_emotion', '')).toBe(true);
  });
});

describe('shotImagePipeline: assembleShotImagePrompt — skip-LF path', () => {
  it('omits last_frame and forces generationStrategy=i2v when lastFramePrompt is empty', async () => {
    const { assembleShotImagePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = assembleShotImagePrompt({
      shotNumber: 2,
      generationStrategy: 'flfv',
      firstFrameMode: 'image_text_to_image',
      firstFramePrompt: 'A close-up of her face from image 1, evening light...',
      firstFrameRefs: [{ imageNumber: 1, type: 'character' as const, refId: 'character_image:ruby' }],
      lastFramePrompt: '',
      negativePrompt: 'blurry, cartoon',
    });

    expect(result.frames.last_frame).toBeUndefined();
    expect(result.frames.first_frame).toBeDefined();
    expect(result.generationStrategy).toBe('i2v');

    // Still passes the schema (last_frame is optional)
    const validation = validateWithSchema('shot_image_prompt', result);
    expect(validation.valid).toBe(true);
  });

  it('omits last_frame when lastFramePrompt is whitespace-only', async () => {
    const { assembleShotImagePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = assembleShotImagePrompt({
      shotNumber: 3,
      generationStrategy: 'flfv',
      firstFrameMode: 'image_text_to_image',
      firstFramePrompt: 'A wide of the empty street...',
      firstFrameRefs: [{ imageNumber: 1, type: 'setting' as const, refId: 'setting_image:street' }],
      lastFramePrompt: '   \n\t  ',
      negativePrompt: 'blurry',
    });

    expect(result.frames.last_frame).toBeUndefined();
    expect(result.generationStrategy).toBe('i2v');
  });

  it('retains last_frame when prompt is non-empty (no skip)', async () => {
    const { assembleShotImagePrompt } = await import('../../src/core/planner/shotImagePipeline.js');
    const result = assembleShotImagePrompt({
      shotNumber: 4,
      generationStrategy: 'flfv',
      firstFrameMode: 'image_text_to_image',
      firstFramePrompt: 'Ruby running toward the door...',
      firstFrameRefs: [{ imageNumber: 1, type: 'character' as const, refId: 'character_image:ruby' }],
      lastFramePrompt: 'Ruby has reached the door, hand on the handle...',
      negativePrompt: 'blurry',
    });

    expect(result.frames.last_frame).toBeDefined();
    expect(result.frames.last_frame!.imagePrompt).toContain('door');
    expect(result.generationStrategy).toBe('flfv');
  });
});

describe('shotImagePipeline: stripLastFrameForHoldingBeat — pure JSON mutation', () => {
  // Case 1: happy path — holding-beat detected, LF stripped, strategy flipped
  it('strips frames.last_frame and sets generationStrategy=i2v for a holding beat', async () => {
    const { stripLastFrameForHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    const input = JSON.stringify({
      shotNumber: 1,
      generationStrategy: 'flfv',
      frames: {
        first_frame: { imagePrompt: 'FF prose', generationMode: 'image_text_to_image', references: [] },
        last_frame: { imagePrompt: 'LF prose', generationMode: 'edit_first_frame', references: [] },
      },
      negativePrompt: 'blurry',
      aspectRatio: '16:9',
    });
    const out = stripLastFrameForHoldingBeat(input, 'hold_emotion', 'medium close-up, static');
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.frames.last_frame).toBeUndefined();
    expect(parsed.frames.first_frame).toBeDefined();
    expect(parsed.generationStrategy).toBe('i2v');
    expect(parsed.shotNumber).toBe(1);
  });

  // Case 2: holding purpose + cameraWork has motion verb → null
  it('returns null when cameraWork contains a motion verb', async () => {
    const { stripLastFrameForHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    const input = JSON.stringify({
      frames: { first_frame: {}, last_frame: {} },
      generationStrategy: 'flfv',
    });
    expect(stripLastFrameForHoldingBeat(input, 'hold_emotion', 'slow push-in')).toBeNull();
    expect(stripLastFrameForHoldingBeat(input, 'show_reaction', 'tracking shot')).toBeNull();
    expect(stripLastFrameForHoldingBeat(input, 'set_the_mood', 'crane up')).toBeNull();
  });

  // Case 3: non-holding purpose + static cameraWork → null
  it('returns null for action-y purposes regardless of cameraWork', async () => {
    const { stripLastFrameForHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    const input = JSON.stringify({
      frames: { first_frame: {}, last_frame: {} },
      generationStrategy: 'flfv',
    });
    expect(stripLastFrameForHoldingBeat(input, 'show_action', 'static medium')).toBeNull();
    expect(stripLastFrameForHoldingBeat(input, 'meet_character', 'static medium')).toBeNull();
    expect(stripLastFrameForHoldingBeat(input, 'show_change', 'static medium')).toBeNull();
  });

  // Case 4: empty purpose → null
  it('returns null when purpose is empty/unknown', async () => {
    const { stripLastFrameForHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    const input = JSON.stringify({ frames: { first_frame: {}, last_frame: {} } });
    expect(stripLastFrameForHoldingBeat(input, '', 'medium')).toBeNull();
    expect(stripLastFrameForHoldingBeat(input, 'not_a_purpose', 'medium')).toBeNull();
  });

  // Case 5: empty cameraWork + holding purpose → still strips (trust purpose)
  it('strips when cameraWork is empty and purpose is in holding set', async () => {
    const { stripLastFrameForHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    const input = JSON.stringify({
      frames: { first_frame: { imagePrompt: 'FF' }, last_frame: { imagePrompt: 'LF' } },
      generationStrategy: 'flfv',
    });
    const out = stripLastFrameForHoldingBeat(input, 'hold_emotion', '');
    expect(out).not.toBeNull();
    expect(JSON.parse(out!).frames.last_frame).toBeUndefined();
  });

  // Case 6: malformed JSON → null (don't crash the executor)
  it('returns null on malformed JSON without throwing', async () => {
    const { stripLastFrameForHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(stripLastFrameForHoldingBeat('{not json', 'hold_emotion', 'static')).toBeNull();
    expect(stripLastFrameForHoldingBeat('', 'hold_emotion', 'static')).toBeNull();
    expect(stripLastFrameForHoldingBeat('   ', 'hold_emotion', 'static')).toBeNull();
  });

  // Case 7: code-fenced content — strip fences then mutate
  it('strips ```json code fences before parsing', async () => {
    const { stripLastFrameForHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    const inner = JSON.stringify({
      frames: { first_frame: { imagePrompt: 'FF' }, last_frame: { imagePrompt: 'LF' } },
      generationStrategy: 'flfv',
    });
    const fenced = '```json\n' + inner + '\n```';
    const out = stripLastFrameForHoldingBeat(fenced, 'show_dialogue', 'static medium');
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.frames.last_frame).toBeUndefined();
    expect(parsed.generationStrategy).toBe('i2v');
  });

  // Case 8: JSON has frames but no last_frame already — still flip strategy
  it('still flips generationStrategy=i2v when last_frame is already absent', async () => {
    const { stripLastFrameForHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    const input = JSON.stringify({
      frames: { first_frame: { imagePrompt: 'FF' } },
      generationStrategy: 'flfv',
    });
    const out = stripLastFrameForHoldingBeat(input, 'hold_emotion', 'static');
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.frames.last_frame).toBeUndefined();
    expect(parsed.generationStrategy).toBe('i2v');
  });

  // Case 9: no frames key at all → null
  it('returns null when frames key is missing entirely', async () => {
    const { stripLastFrameForHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(stripLastFrameForHoldingBeat('{"shotNumber": 1}', 'hold_emotion', 'static')).toBeNull();
    expect(stripLastFrameForHoldingBeat('"a string"', 'hold_emotion', 'static')).toBeNull();
    expect(stripLastFrameForHoldingBeat('[]', 'hold_emotion', 'static')).toBeNull();
    expect(stripLastFrameForHoldingBeat('null', 'hold_emotion', 'static')).toBeNull();
  });

  // Case 10: overwrites a pre-existing generationStrategy of any value
  it('overwrites generationStrategy regardless of prior value', async () => {
    const { stripLastFrameForHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    for (const prior of ['flfv', 'fmlfv', 'v2v_extend', undefined]) {
      const input = JSON.stringify({
        frames: { first_frame: { imagePrompt: 'FF' }, last_frame: { imagePrompt: 'LF' } },
        ...(prior ? { generationStrategy: prior } : {}),
      });
      const out = stripLastFrameForHoldingBeat(input, 'set_the_world', 'wide locked-off');
      expect(out, `prior=${prior}`).not.toBeNull();
      expect(JSON.parse(out!).generationStrategy, `prior=${prior}`).toBe('i2v');
    }
  });

  // Case 11: mid_frame is preserved (not stripped) when present
  it('preserves mid_frame; only last_frame is removed', async () => {
    const { stripLastFrameForHoldingBeat } = await import('../../src/core/planner/shotImagePipeline.js');
    const input = JSON.stringify({
      frames: {
        first_frame: { imagePrompt: 'FF' },
        mid_frame: { imagePrompt: 'MID' },
        last_frame: { imagePrompt: 'LF' },
      },
      generationStrategy: 'fmlfv',
    });
    const out = stripLastFrameForHoldingBeat(input, 'show_clue', 'insert macro');
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.frames.last_frame).toBeUndefined();
    expect(parsed.frames.mid_frame).toBeDefined();
    expect(parsed.frames.first_frame).toBeDefined();
    expect(parsed.generationStrategy).toBe('i2v');
  });
});

/**
 * Feature flag: project.features.skipHoldingBeatLF
 *
 * Skip-LF for holding beats is new behavior — default OFF. A project
 * opts in by setting `features.skipHoldingBeatLF: true` in
 * project.json. Everything calling the holding-beat skip path must
 * first check this flag and bail when it's not true; absent /
 * undefined / false / wrong-type all mean OFF.
 *
 * Strict boolean equality (not truthiness) so a hand-edited
 * "skipHoldingBeatLF": "true" (string) doesn't silently turn it on.
 */
describe('shotImagePipeline: isSkipHoldingBeatLFEnabled — opt-in feature flag', () => {
  it('returns false when project is undefined / null', async () => {
    const { isSkipHoldingBeatLFEnabled } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(isSkipHoldingBeatLFEnabled(undefined)).toBe(false);
    expect(isSkipHoldingBeatLFEnabled(null as unknown as Record<string, unknown>)).toBe(false);
  });

  it('returns false when features is absent (legacy projects unaffected)', async () => {
    const { isSkipHoldingBeatLFEnabled } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(isSkipHoldingBeatLFEnabled({})).toBe(false);
    expect(isSkipHoldingBeatLFEnabled({ title: 'old project' } as Parameters<typeof isSkipHoldingBeatLFEnabled>[0])).toBe(false);
  });

  it('returns false when features object exists but skipHoldingBeatLF is not set', async () => {
    const { isSkipHoldingBeatLFEnabled } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(isSkipHoldingBeatLFEnabled({ features: {} })).toBe(false);
    expect(isSkipHoldingBeatLFEnabled({ features: { otherFlag: true } as Record<string, unknown> })).toBe(false);
  });

  it('returns false when explicitly false', async () => {
    const { isSkipHoldingBeatLFEnabled } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(isSkipHoldingBeatLFEnabled({ features: { skipHoldingBeatLF: false } })).toBe(false);
  });

  it('returns true ONLY when explicitly true (strict boolean)', async () => {
    const { isSkipHoldingBeatLFEnabled } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(isSkipHoldingBeatLFEnabled({ features: { skipHoldingBeatLF: true } })).toBe(true);
  });

  it('returns false for truthy non-boolean values — defends against hand-edit typos', async () => {
    // A hand-edited project.json with "skipHoldingBeatLF": "true" or 1
    // would be silently surprising as "on" if we used truthiness. Force
    // people to write the literal boolean to opt in.
    const { isSkipHoldingBeatLFEnabled } = await import('../../src/core/planner/shotImagePipeline.js');
    expect(isSkipHoldingBeatLFEnabled({ features: { skipHoldingBeatLF: 'true' as unknown as boolean } })).toBe(false);
    expect(isSkipHoldingBeatLFEnabled({ features: { skipHoldingBeatLF: 1 as unknown as boolean } })).toBe(false);
    expect(isSkipHoldingBeatLFEnabled({ features: { skipHoldingBeatLF: {} as unknown as boolean } })).toBe(false);
  });
});
