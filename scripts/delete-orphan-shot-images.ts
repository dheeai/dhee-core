#!/usr/bin/env tsx
/**
 * Delete all image files in a project's assets/images/ folder EXCEPT
 * the character_image and setting_image outputs referenced by
 * project.json. Useful after a shot_image stage reset to clean up
 * orphaned renders so the next regen starts from a fresh Finder view.
 *
 * Usage:
 *   pnpm tsx scripts/delete-orphan-shot-images.ts <project>
 */
import { readFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

function main() {
  const projectArg = process.argv[2];
  if (!projectArg) {
    console.error('Usage: pnpm tsx scripts/delete-orphan-shot-images.ts <project>');
    process.exit(1);
  }
  const name = projectArg.endsWith('.dhee') ? projectArg : `${projectArg}.dhee`;
  const projectDir = join(REPO_ROOT, name);
  const assetsDir = join(projectDir, 'assets', 'images');
  const projectJsonPath = join(projectDir, 'project.json');

  const project = JSON.parse(readFileSync(projectJsonPath, 'utf-8'));
  const nodes = project.executorState?.nodes ?? {};

  // Build the keep-set: character_image + setting_image output paths
  const keep = new Set<string>();
  for (const [id, node] of Object.entries(nodes) as Array<[string, any]>) {
    if (!id.startsWith('character_image:') && !id.startsWith('setting_image:')) continue;
    const p = node.outputPath;
    if (typeof p === 'string') {
      keep.add(p.split('/').pop()!);
    }
    const paths = node.outputPaths;
    if (paths && typeof paths === 'object') {
      for (const v of Object.values(paths)) {
        if (typeof v === 'string') keep.add(v.split('/').pop()!);
      }
    }
  }
  console.log(`Keep ${keep.size} ref image(s):`);
  for (const k of keep) console.log(`  ${k}`);

  const files = readdirSync(assetsDir).filter(f => {
    const full = join(assetsDir, f);
    try { return statSync(full).isFile(); } catch { return false; }
  });

  let kept = 0, deleted = 0;
  for (const f of files) {
    if (keep.has(f)) { kept++; continue; }
    unlinkSync(join(assetsDir, f));
    deleted++;
  }
  console.log('');
  console.log(`Kept: ${kept}   Deleted: ${deleted}   Total scanned: ${files.length}`);
}

main();
