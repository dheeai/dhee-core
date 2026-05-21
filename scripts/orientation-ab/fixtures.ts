/**
 * Test shots for the orientation A/B sweep.
 *
 * Each fixture captures what dhee's `generateShotImagePromptPipeline`
 * would receive for that shot: shotBrief from
 * `<project>/prompts/videos/scenes/scene_X.shots/Y.json`, the saved
 * `frames.first_frame` references from the corresponding
 * `<project>/prompts/images/shots/scene-X-shot-Y.json`, and the
 * resolved file path for each refId from `project.executorState.nodes`.
 *
 * Fixtures are inlined deliberately — keeps the harness self-contained
 * and lets us run it without bootstrapping the project graph at runtime.
 */

import path from 'path';

export const PROJECT_DIR = '/Users/ganaraj/dhee-studios/Ruby V3';

/** refId → relative path within project assets (as recorded in executorState) */
export const REF_PATH_MAP: Record<string, string> = {
  'character_image:ruby': 'assets/images/CharRef_ruby_zimage_HBKPPQ.png',
  'character_image:angel': 'assets/images/CharRef_angel_zimage_CRjELc.png',
  'character_image:owner': 'assets/images/CharRef_owner_zimage_B45ayq.png',
  'character_image:driver': 'assets/images/CharRef_driver_zimage__tIP7G.png',
  'setting_image:city_bus_station': 'assets/images/SettingRef_citybusstation_zimage_KScGBh.png',
  'setting_image:pawn_shop_exterior': 'assets/images/SettingRef_pawnshopexterior_zimage_TkdJOn.png',
  'setting_image:pawn_shop_interior': 'assets/images/SettingRef_pawnshopinterior_zimage_dewgU1.png',
  'setting_image:street': 'assets/images/SettingRef_street_zimage_f1-iEv.png',
  'setting_image:street_corner': 'assets/images/SettingRef_streetcorner_zimage_pzgfCj.png',
};

export interface Reference {
  imageNumber: number;
  type: 'character' | 'setting' | 'object';
  refId: string;
}

export interface ShotFixture {
  /** scene-X-shot-Y form used in filenames */
  shotId: string;
  /** From shot_breakdown (videos/scenes/scene_N.shots/M.json) */
  shotDescription: string;
  cameraWork: string;
  purpose: string;
  perspective: string;
  /** From saved first_frame in prompts/images/shots/scene-X-shot-Y.json */
  generationMode: 'image_text_to_image' | 'edit_previous_shot' | 'text_to_image';
  references: Reference[];
  /** Why this shot is in the test set */
  category: 'orientation' | 'hallucination_regression';
  /** Hypothesis-specific expectation for VLM judge */
  expectation: string;
}

export const SHOTS: ShotFixture[] = [
  // ── Orientation cases (user expects backs of characters) ──────────────
  {
    shotId: 'scene-2-shot-1',
    shotDescription:
      'Ruby and Angel stand before the weathered pawn shop facade under the harsh midday sun. They exchange a final look of shared determination, heat shimmer distorting the air around them.',
    cameraWork: 'Medium wide shot, eye-level, static, heat haze visible, deep focus',
    purpose: 'meet_character',
    perspective: 'observer',
    generationMode: 'image_text_to_image',
    references: [
      { imageNumber: 1, type: 'setting', refId: 'setting_image:pawn_shop_exterior' },
      { imageNumber: 2, type: 'character', refId: 'character_image:ruby' },
      { imageNumber: 3, type: 'character', refId: 'character_image:angel' },
    ],
    category: 'orientation',
    expectation:
      "User wants Ruby and Angel from BEHIND (back-to-camera), facing the pawn shop facade. NOT facing camera, NOT facing each other 'exchanging a look'.",
  },
  {
    shotId: 'scene-2-shot-9',
    shotDescription:
      'The owner stands frozen, pale as a ghost, as Ruby and Angel, flush with adrenaline, survey the shop with predatory calm. The power dynamic is sealed—fear vs. the thrill of a robbery begun.',
    cameraWork:
      "Medium wide shot, eye-level, static with a slight slow push-in, shallow depth of field keeping the owner's face sharp while Ruby and Angel remain slightly blurred in the foreground.",
    purpose: 'hold_emotion',
    perspective: 'observer',
    generationMode: 'edit_previous_shot',
    references: [
      { imageNumber: 1, type: 'setting', refId: 'setting_image:pawn_shop_interior' },
      { imageNumber: 2, type: 'character', refId: 'character_image:owner' },
      { imageNumber: 3, type: 'character', refId: 'character_image:ruby' },
      { imageNumber: 4, type: 'character', refId: 'character_image:angel' },
    ],
    category: 'orientation',
    expectation:
      'User wants the backs of Ruby and Angel in the foreground (camera behind the robbers), owner sharp in the center behind the counter with hands up. NOT Ruby+Angel facing camera.',
  },

  // ── Hallucination regression checks ──────────────────────────────────
  {
    shotId: 'scene-4-shot-5',
    shotDescription:
      "From an observer's angle, Ruby inside the green Lamborghini spots Angel sprinting along the sidewalk, the red crystal clutched in his hand. She jerks the wheel, aiming the car directly at him.",
    cameraWork:
      "Medium shot, side angle, capturing Ruby turning the wheel as the car veers toward the sidewalk, Angel in the frame's depth.",
    purpose: 'show_tension',
    perspective: 'observer',
    generationMode: 'edit_previous_shot',
    // Drop the green_lamborghini object ref — never persisted in executorState
    references: [
      { imageNumber: 1, type: 'setting', refId: 'setting_image:street' },
      { imageNumber: 2, type: 'character', refId: 'character_image:ruby' },
      { imageNumber: 3, type: 'character', refId: 'character_image:angel' },
    ],
    category: 'hallucination_regression',
    expectation:
      'Both characters visible and recognizable: Ruby inside the green Lambo (driver seat), Angel sprinting on the sidewalk with red crystal. Lambo present and green.',
  },
  {
    shotId: 'scene-4-shot-6',
    shotDescription:
      "The Lamborghini's chrome bumper catches Angel at waist height, folding his torso over the hood before his body is launched backward, spinning through the air. He hits the asphalt with a heavy thud and skids to a stop.",
    cameraWork:
      'Wide shot, low angle, fast pan following the car as it mounts the curb, capturing the impact with brutal clarity.',
    purpose: 'show_action',
    perspective: 'observer',
    generationMode: 'edit_previous_shot',
    references: [
      { imageNumber: 1, type: 'setting', refId: 'setting_image:street' },
      { imageNumber: 2, type: 'character', refId: 'character_image:angel' },
    ],
    category: 'hallucination_regression',
    expectation:
      'Wide low-angle shot, green Lamborghini mounting curb hitting recognizable Angel (Black man, dark hoodie, short coiled hair). Angel identity is the key check.',
  },
  {
    shotId: 'scene-4-shot-11',
    shotDescription:
      'Ruby locks eyes with the bloodied Angel, her expression cold and resolute. She delivers the line with finality.',
    cameraWork:
      "Close-up, high angle, looking down at Angel's face from Ruby's perspective, steady.",
    purpose: 'show_dialogue',
    perspective: 'main_subject',
    generationMode: 'edit_previous_shot',
    references: [
      { imageNumber: 1, type: 'setting', refId: 'setting_image:street' },
      { imageNumber: 2, type: 'character', refId: 'character_image:angel' },
    ],
    category: 'hallucination_regression',
    expectation:
      "Close-up of the SAME Angel (Black man, clean-shaven young face from ref) on asphalt, bloodied but identity intact. POV implies we do NOT see Ruby's face. This shot famously hallucinated a bearded older man in production.",
  },
];

/** Resolve a refId to an absolute file path on disk. Throws if unmapped. */
export function refIdToPath(refId: string): string {
  const rel = REF_PATH_MAP[refId];
  if (!rel) throw new Error(`Unmapped refId: ${refId}`);
  return path.join(PROJECT_DIR, rel);
}

/** Same seeds used across conditions so Klein noise is identical for fair A/B. */
export const SEEDS: number[] = [424242, 712233, 998877];
