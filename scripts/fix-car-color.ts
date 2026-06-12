import { invalidateNodes } from '../src/dag/projectRegen.js';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const PROJ = '/Users/ganaraj/dhee-studios/concept-car';
// 1. pin characters_plan as user so the walker never re-LLM's it (keeps black)
const pj = JSON.parse(readFileSync(join(PROJ,'project.json'),'utf8'));
const cp = pj.walkState.nodes['characters_plan'];
if (cp) { cp.generation = { tool: 'user', toolVersion: '0.1.0' }; }
writeFileSync(join(PROJ,'project.json'), JSON.stringify(pj,null,2));
// 2. invalidate all shot_image_prompt items → cascades to shot_image, scene_clip, final_video
const shots = readdirSync(join(PROJ,'prompts/shot_image'))
  .filter(f => /^scene_\d+_shot_\d+\.json$/.test(f)).map(f => 'shot_image_prompt:'+f.replace('.json',''));
const r = await invalidateNodes({ projectDir: PROJ, nodeIds: shots, source: 'fix-car-color' });
console.log('invalidated', r.invalidated.length, 'keys; notFound', r.notFound.length);
console.log(r.invalidated.join('\n'));
