import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const PROJ='/Users/ganaraj/dhee-studios/concept-car';
const dir=join(PROJ,'prompts/shot_image');
const recolor=(s:string)=>s
  .replace(/matte silver/gi,'gloss black')
  .replace(/silver(?:-grey|-gray)?/gi,'black')
  .replace(/polished metal/gi,'polished black bodywork')
  .replace(/(curved|smooth|sleek) silver/gi,'$1 black')
  .replace(/silver/gi,'black');
const shots=['scene_1_shot_1','scene_1_shot_2','scene_1_shot_3','scene_2_shot_1','scene_2_shot_2','scene_2_shot_3','scene_3_shot_1','scene_3_shot_2','scene_3_shot_3'];
const pj=JSON.parse(readFileSync(join(PROJ,'project.json'),'utf8'));
const N=pj.walkState.nodes;
for(const s of shots){
  const canon=join(dir,`${s}.json`);
  let src=canon;
  if(!existsSync(canon)){ // pick newest version
    const vs=readdirSync(dir).filter(f=>f.startsWith(s+'.v')&&f.endsWith('.json')).sort();
    src=join(dir,vs[vs.length-1]);
  }
  const d=JSON.parse(readFileSync(src,'utf8'));
  if(typeof d.imagePrompt==='string') d.imagePrompt=recolor(d.imagePrompt);
  writeFileSync(canon,JSON.stringify(d,null,2));
  N['shot_image_prompt:'+s]={status:'completed',outputPath:`prompts/shot_image/${s}.json`,generation:{tool:'user',toolVersion:'0.1.0'}};
  // reset the image render so it re-renders from the black prompt + black photo
  const imgKey='shot_image:'+s; const img=N[imgKey];
  if(img){ const op=img.outputPath; if(op&&existsSync(join(PROJ,op))) rmSync(join(PROJ,op)); delete N[imgKey]; }
  // also remove first-frame file if present
  const ff=join(PROJ,`assets/images/shots/${s}_first.png`); if(existsSync(ff)) rmSync(ff);
}
// reset clips + final
for(const k of Object.keys(N)){ if(k.startsWith('scene_clip:')||k==='final_video'){ const op=N[k].outputPath; if(op&&existsSync(join(PROJ,op))) rmSync(join(PROJ,op)); delete N[k]; } }
writeFileSync(join(PROJ,'project.json'),JSON.stringify(pj,null,2));
console.log('reconstructed 9 black prompts (pinned), reset shot_image/scene_clip/final');
