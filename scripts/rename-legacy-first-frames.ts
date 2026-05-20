#!/usr/bin/env tsx
/**
 * Rename any shot_image first_frame file still using the legacy
 * `Scene{N}_{model}_{nanoid}.png` naming to the current shot-aware
 * `s{N}shot{M}_first_frame_{model}_{nanoid}.png` convention. Updates
 * both the on-disk filename and the project.json references.
 *
 * Safe no-op: only touches files whose current name starts with
 * `Scene{N}_` (not the new `s{N}shot{M}_` pattern). Preserves the
 * nanoid token so the file's generation history is still traceable.
 *
 * Usage:
 *   pnpm tsx scripts/rename-legacy-first-frames.ts <project>
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join, resolve, dirname } from 'path';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

function parseLegacy(filename: string): { model: string; nanoid: string } | null {
  // Scene{N}_{model}_{nanoid}.png — e.g., Scene1_klein_26hloH.png
  const m = filename.match(/^Scene\d+_([A-Za-z0-9]+)_([A-Za-z0-9_-]+)\.png$/);
  if (!m) return null;
  return { model: m[1]!, nanoid: m[2]! };
}

function main() {
  const projectArg = process.argv[2];
  if (!projectArg) {
    console.error('Usage: pnpm tsx scripts/rename-legacy-first-frames.ts <project>');
    process.exit(1);
  }
  const name = projectArg.endsWith('.dhee') ? projectArg : `${projectArg}.dhee`;
  const projectDir = join(REPO_ROOT, name);
  const jsonPath = join(projectDir, 'project.json');
  const project = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  const nodes = project.executorState?.nodes ?? {};

  let renamed = 0;
  for (const [nodeId, node] of Object.entries(nodes) as Array<[string, any]>) {
    if (!nodeId.startsWith('shot_image:scene_')) continue;
    const itemId: string = node.itemId ?? '';
    const sceneMatch = itemId.match(/scene_(\d+)/);
    const shotMatch = itemId.match(/shot_(\d+)/);
    if (!sceneMatch || !shotMatch) continue;
    const sceneN = sceneMatch[1];
    const shotM = shotMatch[1];

    for (const frameKey of ['first_frame', 'mid_frame', 'last_frame'] as const) {
      const relPath: string | undefined = node.outputPaths?.[frameKey];
      if (!relPath) continue;
      const fname = relPath.split('/').pop()!;
      const parsed = parseLegacy(fname);
      if (!parsed) continue;
      const newFname = `s${sceneN}shot${shotM}_${frameKey}_${parsed.model}_${parsed.nanoid}.png`;
      const newRel = relPath.replace(fname, newFname);
      const oldAbs = join(projectDir, relPath);
      const newAbs = join(projectDir, newRel);
      if (!existsSync(oldAbs)) {
        console.warn(`  missing on disk: ${relPath}`);
        continue;
      }
      renameSync(oldAbs, newAbs);
      node.outputPaths[frameKey] = newRel;
      if (node.outputPath === relPath) node.outputPath = newRel;
      console.log(`  ${nodeId} / ${frameKey}: ${fname} → ${newFname}`);
      renamed++;
    }
  }
  writeFileSync(jsonPath, JSON.stringify(project, null, 2));
  console.log(`\nRenamed ${renamed} file(s).`);
}

main();
