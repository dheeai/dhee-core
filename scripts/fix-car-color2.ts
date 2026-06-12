import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { invalidateNodes } from '../src/dag/projectRegen.js';
const PROJ = '/Users/ganaraj/dhee-studios/concept-car';
const dir = join(PROJ,'prompts/shot_image');
const recolor = (s:string)=> s
  .replace(/matte silver/gi,'gloss black')
  .replace(/silver(?:-grey|-gray)?/gi,'black')
  .replace(/polished metal/gi,'polished black bodywork')
  .replace(/curved silver bodywork/gi,'curved black bodywork');
const files = readdirSync(dir).filter(f=>/^scene_\d+_shot_\d+\.json$/.test(f));
const pj = JSON.parse(readFileSync(join(PROJ,'project.json'),'utf8'));
for (const f of files) {
  const p = join(dir,f); const d = JSON.parse(readFileSync(p,'utf8'));
  if (typeof d.imagePrompt==='string') d.imagePrompt = recolor(d.imagePrompt);
  writeFileSync(p, JSON.stringify(d,null,2));
  // pin the prompt as user so the walker won't LLM-regenerate (silver) it
  const key='shot_image_prompt:'+f.replace('.json','');
  if (pj.walkState.nodes[key]) pj.walkState.nodes[key].generation={tool:'user',toolVersion:'0.1.0'};
  else pj.walkState.nodes[key]={status:'completed',outputPath:`prompts/shot_image/${f}`,generation:{tool:'user',toolVersion:'0.1.0'}};
}
writeFileSync(join(PROJ,'project.json'), JSON.stringify(pj,null,2));
// invalidate the renders that depend on the prompts (images→clips→final); prompts stay (pinned black)
const shotImgs = files.map(f=>'shot_image:'+f.replace('.json',''));
const r = await invalidateNodes({ projectDir: PROJ, nodeIds: shotImgs, source:'recolor-black' });
console.log('recolored', files.length, 'prompts; invalidated', r.invalidated.length, 'render keys');
