/**
 * Tier-1-simulated shot briefs: what `scene_breakdown_shot_guide.md` SHOULD
 * produce as `description` after the upstream fix. These replace the
 * original Ruby V3 descriptions that contained face-cues for what should
 * be back-to-camera approach beats.
 *
 * cameraWork / purpose / perspective / references are unchanged from the
 * actual production breakdowns. Only `shotDescription` is rewritten.
 */

import type { ShotFixture } from './fixtures.js';
import { SHOTS as ORIGINAL_SHOTS } from './fixtures.js';

/** Per-shot description rewrites (what Tier 1 should produce). */
const CORRECTED_DESCRIPTIONS: Record<string, string> = {
  'scene-2-shot-1':
    "Ruby and Angel walk up to the weathered pawn shop entrance from the sidewalk, both seen from behind, approaching the door under the harsh midday sun. Heat shimmer distorts the air between them and the facade.",
  'scene-2-shot-9':
    "Over the shoulders of Ruby and Angel — both seen from behind in the foreground — the owner stands frozen behind the long wooden counter, pale and terrified, hands raised in surrender. The robbery is underway.",
  'scene-4-shot-5':
    "Ruby, seated in the driver's seat of a green Lamborghini, grips the steering wheel as she spots Angel sprinting along the sidewalk with the red crystal clutched in his hand. She jerks the wheel sharply, aiming the car at him.",
  'scene-4-shot-6':
    "The green Lamborghini mounts the curb, its chrome bumper pressed against Angel at waist height, his body folded forward over the hood at the moment of impact.",
  'scene-4-shot-11':
    "Close-up of Angel lying on his back on the sun-bleached asphalt, looking up at the camera. A streak of blood traces from his temple. Ruby (the camera's POV) speaks from above — her face is NOT visible in the frame.",
};

/** Build corrected fixtures by merging original cameraWork/refs/etc with rewritten descriptions. */
export const CORRECTED_SHOTS: ShotFixture[] = ORIGINAL_SHOTS.map(s => {
  const fixed = CORRECTED_DESCRIPTIONS[s.shotId];
  if (!fixed) return s;
  return { ...s, shotDescription: fixed };
});

/** Pattern checklist for grading each shot's LLM output. */
export interface PatternCheck {
  name: string;
  /** true = passes, false = fails. Pure-function check on the prose. */
  test: (prose: string) => boolean;
  /** Required for this shot's category. If false, check is informational only. */
  required: boolean;
}

const lower = (s: string) => s.toLowerCase();
const banContains = (s: string, phrases: string[]) =>
  !phrases.some(p => lower(s).includes(lower(p)));
const mustContain = (s: string, phrases: string[]) =>
  phrases.some(p => lower(s).includes(lower(p)));

const FACE_VOCAB = [
  'face set', 'her face', 'his face', 'their faces',
  'eyes locked', 'eyes meet', 'her eyes', 'his eyes', 'their eyes',
  'gazes lock', 'gazes meet', 'her gaze', 'his gaze',
  'exchanging a look', 'exchange a look', 'final look',
  'shared glance', 'locked eyes', 'fix on', 'fixed on',
  'jaw clenched', 'jaw tight', 'jaw set',
  'brow furrowed', 'lips pressed', 'expression',
  'face to face', 'facing each other', 'in profile', 'side angle',
];

const BACK_VOCAB = [
  'from behind', 'backs to camera', 'back to camera',
  'rear three-quarter', 'rear view', 'seen from behind',
  'walking toward', 'approaching the', 'walking up to',
  'back of', 'backs of', 'shoulder-height', 'over-the-shoulder',
  'over the shoulder', 'their backs', 'ots',
];

const WEASEL_VOCAB = [
  'barely visible', 'barely discernible', 'a dark silhouette',
  'a smeared silhouette', 'almost out of frame as a smear',
  'a smeared figure', 'ghost-like', 'indistinct',
];

/** Per-shot checks. */
export const CHECKS_BY_SHOT: Record<string, PatternCheck[]> = {
  'scene-2-shot-1': [
    { name: 'no face vocab', test: p => banContains(p, FACE_VOCAB), required: true },
    { name: 'has back-to-camera vocab', test: p => mustContain(p, BACK_VOCAB), required: true },
    { name: 'destination AHEAD/in front', test: p => /\b(ahead|in front of|rises ahead|visible ahead)\b/i.test(p), required: true },
    { name: 'Ruby inline hook', test: p => /Ruby\s*\([^)]+(red|hair|jacket|leather)[^)]*\)/i.test(p), required: true },
    { name: 'Angel inline hook', test: p => /Angel\s*\([^)]*(Black|dark|hoodie|hood|coiled|afro|denim)[^)]*\)/i.test(p), required: true },
    { name: 'no weasel words', test: p => banContains(p, WEASEL_VOCAB), required: true },
    { name: 'length 60-220 words', test: p => { const w = p.split(/\s+/).length; return w >= 60 && w <= 220; }, required: false },
  ],
  'scene-2-shot-9': [
    // Face-vocab check: only flag face words attached to Ruby or Angel,
    // since owner SHOULD have face/eyes described (he's the focal subject).
    // IMPORTANT: ignore matches inside parenthetical inline visual hooks —
    // "Angel (Black man, dark hoodie, short coiled hair)" is REQUIRED and the
    // word "hair" inside the descriptor must NOT trigger the face-vocab ban.
    { name: 'no face vocab attached to Ruby or Angel', test: p => {
      // Strip parenthetical hooks before checking.
      const stripped = p.replace(/\([^)]*\)/g, '');
      const bad = /(Ruby|Angel)['']?s?\s+(face|eyes|gaze|expression|jaw|brow|lips)\b|(Ruby|Angel)[^.,]{0,80}\b(face|eyes locked|gazes|her face|his face|their faces|her eyes|his eyes|their eyes|jaw clenched|brow furrowed)\b/i;
      return !bad.test(stripped);
    }, required: true },
    { name: 'has back-to-camera vocab', test: p => mustContain(p, BACK_VOCAB), required: true },
    { name: 'owner face/expression mentioned', test: p => /owner[^.]*\b(face|pale|terror|trembling|wide eyes)\b/i.test(p) || /\b(pale|terror|trembling|wide eyes)\b[^.]*owner/i.test(p), required: true },
    { name: 'Ruby inline hook', test: p => /Ruby\s*\([^)]+(red|hair|jacket|leather)[^)]*\)/i.test(p), required: true },
    { name: 'Angel inline hook', test: p => /Angel\s*\([^)]*(Black|dark|hoodie|hood|coiled|afro|denim)[^)]*\)/i.test(p), required: true },
    { name: 'owner inline hook', test: p => /owner\s*\([^)]+\)/i.test(p), required: true },
    { name: 'no weasel words', test: p => banContains(p, WEASEL_VOCAB), required: true },
  ],
  'scene-4-shot-5': [
    { name: 'leads with Ruby (not Lambo)', test: p => {
      // First 60 chars of body should mention Ruby before "Lamborghini" as a subject noun.
      const head = p.slice(0, 120);
      const rubyIdx = head.search(/\bRuby\b/);
      const lamboIdx = head.search(/\b(green Lamborghini|sleek green|emerald-green) (fills|hood|frame|body|car)/i);
      return rubyIdx >= 0 && (lamboIdx < 0 || rubyIdx < lamboIdx);
    }, required: true },
    { name: 'Ruby inline hook', test: p => /Ruby\s*\([^)]+(red|hair|jacket|leather)[^)]*\)/i.test(p), required: true },
    { name: 'Angel inline hook', test: p => /Angel\s*\([^)]*(Black|dark|hoodie|hood|coiled|afro|denim)[^)]*\)/i.test(p), required: true },
    { name: 'Ruby concretely IN the car', test: p => /Ruby[^.]*(driver|windshield|steering wheel|driver-side|driver's seat)/i.test(p), required: true },
    { name: 'no weasel words', test: p => banContains(p, WEASEL_VOCAB), required: true },
  ],
  'scene-4-shot-6': [
    { name: 'Angel inline hook', test: p => /Angel\s*\([^)]*(Black|dark|hoodie|hood|coiled|afro|denim)[^)]*\)/i.test(p), required: true },
    { name: 'Angel pose constrained (not extreme)', test: p => !/(spinning|launched|flung|hurled|tumbling|cartwheel|airborne|mid-air)/i.test(p), required: true },
    { name: 'no weasel words', test: p => banContains(p, WEASEL_VOCAB), required: true },
  ],
  'scene-4-shot-11': [
    { name: 'Angel inline hook with identity descriptors', test: p => /Angel\s*\([^)]+(Black|clean-shaven|short coiled|hoodie)[^)]+\)/i.test(p), required: true },
    { name: 'length under 130 words (close-up)', test: p => p.split(/\s+/).length <= 130, required: true },
    { name: 'NO Ruby face mentioned (POV shot)', test: p => {
      // Reject only if Ruby is described WITH a face feature.
      // Allow phrases like "Ruby's voice from above — no face visible".
      const bad = /Ruby['']s\s+(face|expression|eyes|gaze|jaw|brow|lips)\b/i;
      const ban = /Ruby\s+(?:[^.,]{0,40}?)(?:locks eyes|gaze|her face|fierce expression)/i;
      return !bad.test(p) && !ban.test(p);
    }, required: true },
    { name: 'no weasel words', test: p => banContains(p, WEASEL_VOCAB), required: true },
  ],
};
