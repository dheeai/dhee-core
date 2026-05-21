/**
 * Rasa-driven modifiers for image and motion prompts.
 *
 * Deterministic dict. Each rasa maps to palette/lighting/pacing/lens tokens
 * that the shot_first_frame, shot_last_frame and motion_directive prompt
 * builders inject alongside the project-level ProjectStyle modifier. No LLM
 * — the assembler reads scene.rasa and looks up the row.
 *
 * Source: Bharata's Natyashastra (rasa-bhava chapter) + post-Bharata
 * commentaries that link rasa to colour, season, time-of-day, and tempo.
 * Western-cinematography tokens (DOF, lens) are mapped from rasa
 * by analogy, not from Bharata directly — the linkage is asserted
 * design, not authority.
 */

import type { rasaValues, sattvikaValues, drishtiValues, vyabhichariValues } from './schemas.js';

export type Rasa = typeof rasaValues[number];
export type Sattvika = typeof sattvikaValues[number];
export type Drishti = typeof drishtiValues[number];
export type Vyabhichari = typeof vyabhichariValues[number];

export interface RasaModifier {
  /** Short imagistic palette phrase fed verbatim into image prompts. */
  paletteTokens: string;
  /** Lighting key + quality. */
  lightingKey: string;
  /** Default shot-duration band (seconds). */
  pacingBand: [number, number];
  /** Lens / DOF default. */
  lensPreference: string;
  /** Camera movement bias for the motion directive. */
  cameraBias: string;
  /** Negative-prompt fragment (things to suppress for this rasa). */
  negativePrompt: string;
}

export const RASA_MODIFIERS: Record<Rasa, RasaModifier> = {
  shringara: {
    paletteTokens: 'warm rose and gold, honeyed amber highlights, soft saturation',
    lightingKey: 'golden-hour soft key, low-contrast fill, romantic bloom',
    pacingBand: [5, 7],
    lensPreference: 'medium telephoto, shallow DOF, gentle bokeh',
    cameraBias: 'slow push-in, soft drift, no whip moves',
    negativePrompt: 'harsh shadows, cold blue, desaturated, gritty texture',
  },
  hasya: {
    paletteTokens: 'bright cheerful palette, mid-saturation primaries, lively contrast',
    lightingKey: 'high-key even lighting, minimal shadow',
    pacingBand: [3, 5],
    lensPreference: 'standard lens, deep DOF',
    cameraBias: 'snappy cuts, light handheld, quick reframes',
    negativePrompt: 'somber tones, heavy shadow, slow motion',
  },
  karuna: {
    paletteTokens: 'desaturated pale blue and grey, washed dawn light, muted earth tones',
    lightingKey: 'soft diffuse low-key, overcast quality, low contrast',
    pacingBand: [5, 7],
    lensPreference: 'medium telephoto, shallow DOF on face',
    cameraBias: 'static or very slow drift, no fast moves',
    negativePrompt: 'saturated colour, hard sun, fast cuts',
  },
  raudra: {
    paletteTokens: 'deep crimson and ember red, hot oranges against cold steel, high contrast',
    lightingKey: 'hard directional key, deep shadow, raking side light',
    pacingBand: [3, 4],
    lensPreference: 'wide to standard, deeper DOF, optical distortion welcome',
    cameraBias: 'handheld, whip pans permissible, fast push and tilt',
    negativePrompt: 'pastel palette, soft diffuse light, slow motion',
  },
  veera: {
    paletteTokens: 'burnished gold and bronze, deep navy, banner-saturated reds, monumental tones',
    lightingKey: 'strong key with rim light, low angle catching face',
    pacingBand: [3, 8],  // mixed: 3-4s action, 6-8s resolve
    lensPreference: 'wide low-angle for resolve, telephoto for action',
    cameraBias: 'low-angle push-in on resolve; tracking on action',
    negativePrompt: 'flat lighting, downward angle on hero, pastel palette',
  },
  bhayanaka: {
    paletteTokens: 'absolute black and deep red, sickly green hints, vignette tightening',
    lightingKey: 'low-key chiaroscuro, hard pinprick highlights, large negative space',
    pacingBand: [3, 4],
    lensPreference: 'wide with optical vignette, deep DOF on threat, shallow on protagonist',
    cameraBias: 'creeping push or static hold, occasional whip on reveal',
    negativePrompt: 'bright daylight, warm palette, open framing, balanced exposure',
  },
  bibhatsa: {
    paletteTokens: 'sickly yellow-green and dull bruise purple, organic browns, off-white',
    lightingKey: 'flat fluorescent or hard underlight, unflattering shadow',
    pacingBand: [4, 6],
    lensPreference: 'wide with macro inserts, deep DOF',
    cameraBias: 'static linger, slow uncomfortable holds',
    negativePrompt: 'beautiful, glossy, soft skin, golden light',
  },
  adbhuta: {
    paletteTokens: 'iridescent pearl and prism light, deep indigo with ember accents, atmospheric haze',
    lightingKey: 'soft diffuse from unusual sources, god rays, glowing rim',
    pacingBand: [5, 7],
    lensPreference: 'wide anamorphic, layered atmosphere, deep DOF',
    cameraBias: 'slow rise/reveal, symmetric framing, gradual push',
    negativePrompt: 'mundane lighting, flat composition, fast cuts',
  },
  shanta: {
    paletteTokens: 'cool desaturated greys and pale blues, balanced neutral, low contrast',
    lightingKey: 'soft diffuse top light or window-soft, even exposure',
    pacingBand: [5, 8],
    lensPreference: 'medium telephoto, compressed perspective, shallow DOF',
    cameraBias: 'static, locked off, or imperceptibly slow drift',
    negativePrompt: 'saturated colour, hard shadow, fast camera move, busy frame',
  },
};

// Sattvika cue → physical-description phrase injected into image prompts.
export const SATTVIKA_CUES: Record<Sattvika, string> = {
  vepathu: 'visible trembling, white-knuckled grip, slight tremor in the hands',
  sveda: 'beads of sweat on the forehead and temple, glistening skin',
  stambha: 'absolute stillness, frozen posture, feet planted, breath held',
  romancha: 'visible gooseflesh on the arms and nape, raised hair',
  vaivarnya: 'pallor or flush across the face, blood draining or rising',
  ashru: 'tears welling at the lashline, single tear track on the cheek',
};

// Drishti → gaze direction phrase injected into image prompts when face is focal.
export const DRISHTI_CUES: Record<Drishti, string> = {
  sama: 'level direct gaze straight ahead, unblinking, steady',
  alokita: 'sidelong glance, eyes turned to the corner of the orbit',
  sachi: 'over-the-shoulder back-look, head turned away from camera',
  nimilita: 'half-closed inward gaze, eyes lowered, downcast',
  unmilita: 'eyes wide and alert, full whites visible, brow raised',
  kuncita: 'shrinking fearful eyes, partially squeezed shut, head tilted away',
  roudri: 'fierce predatory gaze, narrowed eyes, focused like a hunter',
  lalita: 'soft affectionate eyes, slight smile reaching the eyes, warm gaze',
};

// Vyabhichari → micro-emotional descriptor injected into the prompt.
export const VYABHICHARI_CUES: Record<Vyabhichari, string> = {
  smriti: 'a brief flicker of recollection across the face, eyes momentarily unfocused',
  cinta: 'subtle worry creasing the brow, distracted weight in the eyes',
  sanka: 'narrowed suspicion in the eyes, head slightly tilted',
  nirveda: 'hollow despair settling in the features, gaze gone empty',
  harsha: 'a sudden involuntary flash of joy, brief upturn of the mouth',
  autsukya: 'longing in the eyes, leaning weight toward the unseen object',
  garva: 'lifted chin, slight smirk, pride sitting visibly in the jaw',
  glani: 'visible weariness in the shoulders and eyes, drawn-down corners',
  lajja: 'shame flushing the cheeks, eyes averted downward',
};

/**
 * Compose all available Bharata cues for a shot into a single descriptor
 * string suitable for appending to an image prompt. Returns empty string
 * when nothing is tagged.
 */
export function composeBharataCues(input: {
  sattvika?: Sattvika | null;
  drishti?: Drishti | null;
  vyabhichariBhava?: Vyabhichari | null;
}): string {
  const parts: string[] = [];
  if (input.sattvika) parts.push(SATTVIKA_CUES[input.sattvika]);
  if (input.drishti) parts.push(DRISHTI_CUES[input.drishti]);
  if (input.vyabhichariBhava) parts.push(VYABHICHARI_CUES[input.vyabhichariBhava]);
  return parts.join('; ');
}
