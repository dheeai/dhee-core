/**
 * gen-bundle-requirements — auto-stub a bundle's `requirements` block
 * (models + custom nodes) from its workflow JSONs, so a bundle author
 * curates download URLs / sizes / install hints instead of typing the
 * model + node lists by hand.
 *
 * Run:  pnpm tsx scripts/gen-bundle-requirements.ts <bundleDir> [--write] [--core-from <vanilla-comfy-url>]
 *
 *   <bundleDir>            path to the bundle (the dir containing bundle.json)
 *   --write               merge the derived `requirements` into bundle.json
 *                         (preserves any curation already present)
 *   --core-from <url>     fetch a VANILLA ComfyUI's /object_info and use its
 *                         class keys as the core set, so only genuinely-custom
 *                         node classes land in customNodes. Without it, a
 *                         built-in heuristic (CORE_COMFY_CLASSES) is used.
 *
 * Models are derived fully (filename + loader field + inferred type).
 * Custom nodes are referenced classes minus the core set; downloadUrl /
 * sizeGb / pack / installVia / note are left blank for the author.
 * allNodeClasses is printed so the author can sanity-check the cut.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  deriveBundleRequirements,
  type DeriveOpts,
} from '../src/dag/bundleRequirements.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const bundleDirArg = args.find((a) => !a.startsWith('--'));
  if (!bundleDirArg) {
    console.error('usage: gen-bundle-requirements <bundleDir> [--write] [--core-from <url>]');
    process.exit(1);
  }
  const bundleDir = resolve(bundleDirArg);
  const bundleJson = join(bundleDir, 'bundle.json');
  if (!existsSync(bundleJson)) {
    console.error(`No bundle.json at ${bundleJson}`);
    process.exit(1);
  }

  const opts: DeriveOpts = {};
  const coreFromIdx = args.indexOf('--core-from');
  if (coreFromIdx >= 0 && args[coreFromIdx + 1]) {
    const url = args[coreFromIdx + 1]!.replace(/\/$/, '');
    const resp = await fetch(`${url}/object_info`);
    if (!resp.ok) {
      console.error(`/object_info from ${url} returned ${resp.status}`);
      process.exit(1);
    }
    const info = (await resp.json()) as Record<string, unknown>;
    opts.coreClasses = new Set(Object.keys(info));
    console.error(`Using ${opts.coreClasses.size} core classes from ${url}`);
  }

  const derived = deriveBundleRequirements(bundleDir, opts);
  const requirements = { customNodes: derived.customNodes, models: derived.models };

  console.error(`\nAll referenced node classes (${derived.allNodeClasses.length}):`);
  console.error('  ' + derived.allNodeClasses.join(', '));
  console.error(`\nDerived requirements: ${requirements.models?.length ?? 0} models, ${requirements.customNodes?.length ?? 0} custom nodes (after core-class cut).\n`);

  if (args.includes('--write')) {
    const bundle = JSON.parse(readFileSync(bundleJson, 'utf8')) as Record<string, unknown>;
    bundle['requirements'] = requirements;
    writeFileSync(bundleJson, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
    console.error(`Wrote requirements into ${bundleJson} — curate downloadUrl / sizeGb / pack / installVia / note.`);
  } else {
    // stdout = the requirements block, so it can be piped / inspected.
    console.log(JSON.stringify(requirements, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
