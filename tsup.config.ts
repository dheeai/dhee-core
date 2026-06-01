import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'server/runners/index': 'src/server/runners/index.ts',
    // Phase 6.4: `./manager` entry deleted along with the no-op
    // ConversationManager stub. Embed hosts import the surviving
    // helpers (configurePostHogRuntime / loadDevEnv / analytics) from
    // the main `dhee-core` barrel.
    'core/llm/index': 'src/core/llm/index.ts',
    'dag/index': 'src/dag/walker.ts',
  },
  format: ['esm'],
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
  banner: {
    js: "import { createRequire as __dhee_createRequire } from 'module'; const require = __dhee_createRequire(import.meta.url);",
  },
  // Copy the pi-agent skill files into the dist tree so the bundled
  // `SKILL_DIR = resolve(__dirname, 'skill')` resolves to a real
  // directory at runtime. Without this, `loadSkillsFromDir` returns []
  // and the agent runs without our SKILL.md system prompt.
  async onSuccess() {
    const { cpSync, existsSync, rmSync } = await import('node:fs');
    const dst = 'dist/skill';
    if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
    cpSync('src/agent/pi/skill', dst, { recursive: true });
  },
});
