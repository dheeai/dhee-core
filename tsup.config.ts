import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      // Embed entries — dhee-desktop (and other Electron hosts) load
      // these as ESM via dynamic `import()`. They MUST be ESM because
      // their transitive deps (`@mariozechner/pi-coding-agent`, `pi-ai`)
      // are ESM-only packages with no CJS `require` exports.
      'server/manager': 'src/server/manager.ts',
      'server/runners/index': 'src/server/runners/index.ts',
      'agent/pi/index': 'src/agent/pi/index.ts',
      'core/llm/index': 'src/core/llm/index.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    target: 'node20',
    outDir: 'dist',
    // Some transitive deps still use CommonJS-style `require()` even
    // when the bundle is ESM. esbuild's ESM output replaces those with
    // a "Dynamic require not supported" stub. The banner reinstates a
    // working `require` via `createRequire(import.meta.url)`.
    banner: {
      js: "import { createRequire as __dhee_createRequire } from 'module'; const require = __dhee_createRequire(import.meta.url);",
    },
  },
  {
    entry: {
      'server/cli': 'src/server/cli.ts',
      'server/index': 'src/server/index.ts',
    },
    format: ['cjs'],
    // ESM-only `@mariozechner/pi-*` packages omit `exports.require`. If esbuild
    // leaves them as externals, `node dist/server/cli.cjs` throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED. Force them into the CJS bundle.
    noExternal: [
      '@mariozechner/pi-coding-agent',
      '@mariozechner/pi-ai',
      '@mariozechner/pi-agent-core',
      '@mariozechner/pi-tui',
    ],
    // Maps import.meta.url to a __filename-based URL in CJS output (avoids empty-import-meta warnings and broken paths).
    shims: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    target: 'node20',
    outDir: 'dist',
    outExtension() {
      return {
        js: '.cjs',
      };
    },
  },
]);
