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
  // Bundle the workspace SDK INLINE into dist so the shipped dhee-core is
  // self-contained — the desktop loads dist/ and won't need a separate
  // @dhee_ai/runner-sdk install. (It's a workspace dep, otherwise external.)
  noExternal: ['@dhee_ai/runner-sdk'],
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
  //
  // Also copy the curated first-party bundles so the packaged desktop
  // can ship them as built-in defaults (resolved at runtime via
  // DHEE_APP_BUNDLES_DIR → <app>/Resources/bundles, lifted by the
  // desktop's electron-builder extraResources config from this
  // dist/bundles directory).
  async onSuccess() {
    const { cpSync, existsSync, rmSync, mkdirSync } = await import('node:fs');
    const dstSkill = 'dist/skill';
    if (existsSync(dstSkill)) rmSync(dstSkill, { recursive: true, force: true });
    cpSync('src/agent/pi/skill', dstSkill, { recursive: true });

    // Curated default bundles shipped inside the packaged desktop app.
    // Narrative bundles live under src/dag/bundles; product bundles under
    // bundles/ at the dhee-core package root (same tree dev uses via
    // DHEE_USER_BUNDLES_DIR → <dhee-core>/bundles).
    const DAG_BUNDLES = ['narrative_prompt_relay', 'narrative_shot_by_shot'];
    const PACKAGE_BUNDLES = [
      'cartoon_explainer',
      'satire_lineup',
      'ugc_ad_product_v2',
      'upsc_explainer',
      'openrouter_youtube_documentary',
    ];
    const dstBundles = 'dist/bundles';
    if (existsSync(dstBundles)) rmSync(dstBundles, { recursive: true, force: true });
    mkdirSync(dstBundles, { recursive: true });
    for (const id of DAG_BUNDLES) {
      cpSync(`src/dag/bundles/${id}`, `${dstBundles}/${id}`, { recursive: true });
    }
    for (const id of PACKAGE_BUNDLES) {
      cpSync(`bundles/${id}`, `${dstBundles}/${id}`, { recursive: true });
    }
  },
});
