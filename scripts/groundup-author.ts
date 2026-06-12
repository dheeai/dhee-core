/* Build groundup30 bottom-up via applyPlanItemEdit (the core behind
 * dhee_add_item / dhee_remove_item). One item at a time. */
import { applyPlanItemEdit } from '../src/dag/planItems.js';

const PROJ = '/Users/ganaraj/dhee-studios/groundup30';
function add(nodeId: string, item: unknown, itemKey?: string) {
  const r = applyPlanItemEdit({ projectDir: PROJ, nodeId, op: 'add', item, ...(itemKey ? { itemKey } : {}) });
  console.log(r.ok ? `+ ${nodeId}: ${(r as { itemId: string }).itemId}` : `! ${nodeId}: ${(r as { error: string }).error}`);
  if (!r.ok) process.exit(1);
}

// 1 character
add('characters_plan', {
  id: 'lighthouse_keeper',
  name: 'The Lighthouse Keeper',
  description:
    'A weathered man in his late 60s, thick grey beard, deep-set tired blue eyes, ruddy windburned skin, heavy navy wool sweater and oilskin coat, slow deliberate movements, lantern-lit face.',
});

// 1 setting
add('settings_plan', {
  id: 'lamp_room',
  name: 'The Lamp Room',
  description:
    'The glass-walled lamp room at the top of an old stone lighthouse at night: the great brass-and-glass Fresnel lens at center, slow sweeping beam, salt-fogged windows, weathered controls, moonlit sea beyond.',
});

// 1 scene (itemKey override — different shape from the fan-out shot schema)
add('scenes_plan', {
  id: 'scene_1',
  title: 'The Last Watch',
  mainSubject: 'lighthouse_keeper',
  narrativeMode: 'setup',
  settingId: 'lamp_room',
}, 'scenes');

// 5 shots × 6s = 30s
const shots = [
  'Wide establishing shot of the lamp room, the keeper a small silhouette against the great lens, beam sweeping out to sea.',
  'Medium shot of the keeper climbing the spiral stair into the lamp room, lantern in hand.',
  'Close-up of his weathered hands wiping condensation from the brass housing.',
  'Over-the-shoulder shot looking out through the salt-fogged glass at the dark sea and the rotating beam.',
  'Slow push-in on the keeper’s face, lit amber by the lamp, watching the light he will tend for the last time.',
];
shots.forEach((desc, i) =>
  add('scenes_plan', {
    id: `scene_1_shot_${i + 1}`,
    scene: 1,
    shotNumber: i + 1,
    duration: 6,
    description: desc,
    cameraWork: ['wide', 'medium', 'close-up', 'over-the-shoulder', 'slow push-in'][i],
    mainSubject: 'lighthouse_keeper',
  }, 'shots'),
);

console.log('DONE authoring groundup30 bottom-up.');
