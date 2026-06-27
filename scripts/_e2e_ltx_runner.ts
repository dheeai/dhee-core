// End-to-end: invoke the EXTERNAL dhee-runner-ltx-director exactly as the
// engine would (load its published entry, call runner.run(ctx)) against real
// Comfy, using the migrated built-in workflow in single-still mode.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ext from 'dhee-runner-ltx-director'; // resolved via node_modules (the engine's path)

const WT = resolve(import.meta.dirname, '..');
const projectDir = '/Users/ganaraj/.kshana/bundles/_ltx_e2e_test';
mkdirSync(projectDir, { recursive: true });

const runner = (ext as any).runners[0].runner;
const node = {
  id: 'e2e_ltx',
  runner: {
    tool: 'comfy.ltx_director',
    config: {
      workflowPath: 'workflows/built-in/ltx23_director_local.json',
      outputPath: 'e2e_out.mp4',
      imageInput: 'image',
      endpoint: 'self.local',
      width: 1280, height: 720, fps: 24, duration: 3, guideStrength: 0.4,
      globalPrompt: 'Cinematic photoreal, ancient battle, warm volumetric light, slow dramatic push-in. No talking.',
    },
  },
  inputs: [],
  outputs: { format: 'video', pattern: 'e2e_out.mp4' },
};
const ctx: any = {
  projectDir,
  bundleDir: WT,
  node,
  inputs: { image: '/Users/ganaraj/.kshana/bundles/_krea2_shots/edits/king_closeup_1920x1080_s7.png' },
  log: (m: string) => console.log('  [runner]', m),
};

console.log('Invoking external runner.run() against real Comfy…');
const res = await runner.run(ctx);
console.log('\nRESULT:', JSON.stringify(res, null, 2));
process.exit(res?.ok ? 0 : 1);
