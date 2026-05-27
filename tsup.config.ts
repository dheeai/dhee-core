import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'server/runners/index': 'src/server/runners/index.ts',
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
});
