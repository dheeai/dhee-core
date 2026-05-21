/**
 * Hand-crafted "ideal" Klein prompts for each test shot.
 *
 * No LLM involved. The prose below is what I (the human/Claude) want Klein
 * to render, written directly. Render these via the existing renderPrompts.ts
 * pipeline to test whether Klein actually honors the directives.
 *
 * Once the Klein output matches the user's intent for each shot, we'll
 * reverse-engineer the LLM-guide changes needed to make DeepSeek emit
 * these patterns.
 *
 * Run with COMFY env overrides for zrok:
 *   COMFYUI_BASE_URL=https://comfyui.share.zrok.io COMFY_MODE=local \
 *     npx tsx scripts/orientation-ab/handCraftedPrompts.ts [--shot scene-X-shot-Y]
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(SCRIPT_DIR, 'results', 'prompts');

interface HandCrafted {
  shotId: string;
  variantTag: string; // appears in the filename so we can iterate
  bodyProse: string; // post-manifest prose; the renderer prepends the manifest itself
  rationale: string; // why this prose
}

// v1 hand-crafted attempts. Iterate by adding more entries with new variantTags.
const PROMPTS: HandCrafted[] = [
  {
    shotId: 'scene-2-shot-1',
    variantTag: 'hand_v1',
    bodyProse:
      "Ruby (red-haired, leather jacket) and Angel (Black man, dark hoodie) seen FROM BEHIND, their backs to camera in the foreground, walking up to the weathered pawn shop facade that rises ahead of them in the deep-focus background. Medium wide eye-level shot, the camera at shoulder-height behind them. We see the back of Ruby's red hair catching the harsh overhead midday sun on the left of the frame, and the back of Angel's dark hood on the right. The pawn shop's barred window, faded gold lettering, and dead pink neon 'O' visible AHEAD of them. Hard white-hot sunlight from directly overhead, razor-sharp shadows at their feet, heat shimmer rising off the sun-bleached asphalt between camera and characters. Mood: suspended tension, a pact held in the half-second before action — read entirely from the set of their shoulders and the stillness of their stance.",
    rationale:
      'Back-to-camera, explicit "FROM BEHIND" + "their backs to camera". Both characters get inline visual hooks on first mention. Destination explicitly AHEAD. Posture-only cues, zero face/eye/expression words.',
  },
  {
    shotId: 'scene-2-shot-9',
    variantTag: 'hand_v1',
    bodyProse:
      "Over-the-shoulders shot: Ruby (red-haired, leather jacket) and Angel (Black man, dark hoodie) both seen FROM BEHIND in the immediate foreground, their backs filling the lower left and lower right of the frame respectively, both blurred in soft focus. Between their silhouetted backs, the owner (balding white man, button-up shirt) stands razor-sharp in the midground behind the long wooden counter, his face pale with terror, both hands jerked upward above his head, palms forward, surrendering — the only sharp face in the frame. Medium wide eye-level shot, shallow depth of field. The pawn shop interior recedes into shallow-DoF blur: cluttered shelves, the long counter glinting under the sickly green-white fluorescent tube overhead. Mood: cold thrill of a robbery underway.",
    rationale:
      'OTS-of-robbers framing. Explicitly "seen FROM BEHIND" + "backs filling the lower left and lower right". Owner gets the only face-description (he is focal). Multi-char inline hooks on Ruby and Angel and the owner.',
  },
  {
    // v2: lead with Ruby through the windshield as the focal subject.
    // v1 led with "A sleek green Lamborghini fills the left half" — Klein
    // treated the car as the subject and dropped Ruby (slot 2) entirely.
    shotId: 'scene-4-shot-5',
    variantTag: 'hand_v2',
    bodyProse:
      "Through the driver-side windshield of a green Lamborghini parked at the curb, Ruby (red-haired, leather jacket) is clearly visible seated in the driver's seat — both hands gripping the steering wheel, her red hair catching the harsh midday sun streaming through the glass, her body twisted toward the windshield. The car's emerald-green hood fills the lower-left foreground; the chrome bumper and front wheels turned sharply right are visible. To the right of the car on the sidewalk stands Angel (Black man, dark hoodie, short coiled hair), mid-stride, the small red crystal clutched in his right hand. Medium side-angle shot, eye-level, deep focus keeps both Ruby's face through the windshield and Angel sharp. Sun-bleached street facade behind. Mood: coiled violence in the half-second before impact.",
    rationale:
      'v2: lead with Ruby IN the car (focal subject), not the car. v1 led with the Lambo and Klein dropped Ruby. Now Ruby is the first noun + has the most detail. Angel still gets inline hook + concrete position.',
  },
  {
    shotId: 'scene-4-shot-5',
    variantTag: 'hand_v1',
    bodyProse:
      "Medium side-angle shot under harsh midday sun. A sleek green Lamborghini fills the left half of the frame, its emerald-green hood and chrome bumper gleaming, front wheels turned sharply to the right toward the sidewalk. Inside the driver's seat, Ruby (red-haired, leather jacket) grips the steering wheel with both hands, body twisted toward the windshield, her red hair visible through the side window. Angel (Black man, dark hoodie) is on the sidewalk to the right of the car, mid-stride, the small red crystal clutched in his right hand, head turned toward the oncoming car. Hard white sunlight rakes across the scene from above, heat shimmer rising from the asphalt. Sun-bleached street facade behind. Mood: coiled violence, the moment before impact.",
    rationale:
      'No "blurred" / "barely visible" for slotted characters — Ruby is described concretely INSIDE the car. Both characters get inline hooks. Green Lambo described from text (no slot for it). Avoids radical pose transformation.',
  },
  {
    shotId: 'scene-4-shot-6',
    variantTag: 'hand_v1',
    bodyProse:
      'Wide low-angle shot. The green Lamborghini has mounted the curb, its chrome front bumper pressed against the waist of Angel (Black man, dark hoodie, short coiled hair), whose body is folded forward over the hood. The small red crystal still clutched in his hand. Harsh midday sun from camera-left, deep shadows pooling under the car, dust kicked up from the curb. Sun-bleached street and pawn shop facade in the deep-focus background.',
    rationale:
      'Limits Angel to a single near-static pose ("folded forward over the hood") rather than mid-flight body-launched-spinning. Reference ref shows standing pose; this pose is close enough that Klein can transform it without losing identity.',
  },
  {
    shotId: 'scene-4-shot-11',
    variantTag: 'hand_v1',
    bodyProse:
      "Extreme close-up of Angel (Black man, clean-shaven, short coiled hair, dark hoodie) lying on his back on the sun-bleached asphalt, his face filling the frame, eyes open and looking directly up into the camera. A streak of blood traces from his right temple down to his jaw. High-angle, the camera looking straight down at his face. Razor-sharp focus on Angel's face. The gritty asphalt texture is softly blurred around him. Harsh midday sun from directly overhead, razor-sharp shadow of the camera/Ruby faintly across his face.",
    rationale:
      'MINIMAL prose to keep Angel reference dominant. Explicit visual descriptors ("clean-shaven, short coiled hair") to lock identity against the bearded-old-man hallucination production produced. The setting is described in one sentence so the setting slot doesn\'t fight the close-up.',
  },
];

interface Args {
  shot?: string;
  variant?: string;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const out: Args = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--shot' && a[i + 1]) out.shot = a[++i];
    else if (a[i] === '--variant' && a[i + 1]) out.variant = a[++i];
  }
  return out;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const argv = parseArgs();
  let written = 0;
  for (const p of PROMPTS) {
    if (argv.shot && p.shotId !== argv.shot) continue;
    if (argv.variant && p.variantTag !== argv.variant) continue;
    const out = path.join(OUT_DIR, `${p.shotId}__${p.variantTag}.json`);
    if (existsSync(out)) {
      console.log(`[skip] ${path.basename(out)} (exists — delete to regenerate)`);
      continue;
    }
    writeFileSync(
      out,
      JSON.stringify(
        {
          shotId: p.shotId,
          condition: p.variantTag,
          llmResponse: p.bodyProse,
          rationale: p.rationale,
          handCrafted: true,
          timestamp: Date.now(),
        },
        null,
        2,
      ),
    );
    console.log(`[ok ] wrote ${path.basename(out)} (${p.bodyProse.length} chars body)`);
    written++;
  }
  console.log(`\n[done] ${written} hand-crafted prompts written. Render with:`);
  console.log(
    `  COMFYUI_BASE_URL=https://comfyui.share.zrok.io COMFY_MODE=local npx tsx scripts/orientation-ab/renderPrompts.ts --condition hand_v1`,
  );
}

main();
