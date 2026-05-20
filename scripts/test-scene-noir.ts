import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { LLMClient } from '../src/core/llm/index.js';

const PROJECT_DIR = 'noir_detective_story_setup-3.dhee';
const GUIDE_PATH = 'prompts/skills/defaults/scene_guide.md';
const OUTPUT_DIR = 'test-output/autoresearch-scene-noir';

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

const story = readFileSync(join(PROJECT_DIR, 'chapters/chapter_1/plans/story.md'), 'utf-8');
const characters: string[] = [];
const charDir = join(PROJECT_DIR, 'characters');
if (existsSync(charDir)) for (const f of readdirSync(charDir)) { if (f.endsWith('.md')) characters.push(readFileSync(join(charDir, f), 'utf-8')); }
const settings: string[] = [];
const setDir = join(PROJECT_DIR, 'settings');
if (existsSync(setDir)) for (const f of readdirSync(setDir)) { if (f.endsWith('.md')) settings.push(readFileSync(join(setDir, f), 'utf-8')); }

const sceneSummaries = [
  { sceneNumber: 1, title: 'The Broken Ring', summary: 'Arjan crawls through marketplace debris at night. He finds a cracked bronze signet ring smeared with blood. He examines it under lamplight.' },
  { sceneNumber: 2, title: 'The Shadow', summary: 'A distorted shadow creeps toward Arjan. A hooded Figure steps into the lamplight gripping a bronze blade. Arjan freezes.' },
];

const llm = new LLMClient({
  baseUrl: process.env['OPENAI_BASE_URL'] || process.env['LLM_BASE_URL'],
  apiKey: process.env['OPENAI_API_KEY'] || process.env['LLM_API_KEY'],
  model: process.env['OPENAI_MODEL'] || process.env['LLM_MODEL'],
});

async function generateScene(guide: string, sceneNum: number): Promise<string> {
  const scene = sceneSummaries[sceneNum - 1]!;
  const allSummaries = sceneSummaries.map(s => `Scene ${s.sceneNumber}: "${s.title}" — ${s.summary}`).join('\n');

  const response = await llm.generate({
    messages: [
      { role: 'system', content: `You create detailed scene descriptions for cinematic video production.\n\n<model_skills>\n${guide}\n</model_skills>` },
      { role: 'user', content: `Create Scene ${sceneNum}: "${scene.title}"\n\n<scene_assignment>\nYOUR SCENE: Scene ${sceneNum} — "${scene.title}"\nSUMMARY: ${scene.summary}\n\nYou must ONLY write shots for the beats in YOUR SUMMARY.\nDo NOT include events from other scenes.\n\nALL SCENES:\n${allSummaries}\n</scene_assignment>\n\n<context>\n### Story\n${story}\n\n### Characters\n${characters.join('\n\n---\n\n')}\n\n### Settings\n${settings.join('\n\n---\n\n')}\n</context>` },
    ],
    temperature: 0.7,
  });
  return response.content || '';
}

async function main() {
  console.log('Testing scene guide on NOIR project (generalization test)');
  const guide = readFileSync(GUIDE_PATH, 'utf-8');

  for (let s = 1; s <= 2; s++) {
    console.log(`\nGenerating scene ${s}...`);
    const text = await generateScene(guide, s);
    writeFileSync(join(OUTPUT_DIR, `scene-${s}.md`), text);
    
    const shots = (text.match(/Duration: \d+s/g) || []).length;
    const totalDur = (text.match(/Duration: (\d+)s/g) || []).map(m => parseInt(m.match(/\d+/)![0])).reduce((a, b) => a + b, 0);
    const hasDialogue = text.includes('ARJAN:') || text.includes('FIGURE:');
    const hasBoundaryViolation = s === 1 && (text.toLowerCase().includes('figure steps') || text.toLowerCase().includes('bronze blade') || text.toLowerCase().includes('hooded'));
    
    console.log(`  ${shots} shots, ${totalDur}s total`);
    console.log(`  Dialogue: ${hasDialogue ? 'YES' : 'none'}`);
    console.log(`  Boundary violation: ${hasBoundaryViolation ? 'YES — Scene 1 includes Scene 2 beats!' : 'clean'}`);
    console.log(`  First 200 chars: ${text.substring(0, 200)}...`);
  }
  
  console.log('\nOutputs saved to', OUTPUT_DIR);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
