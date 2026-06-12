/**
 * dhee_list_assets — list the items the user has already built, by
 * capability (#147). A pure projection over the bundle + walkState
 * (reusing findByCapability) — no new state. The asset registry the
 * agent consults before adding more ("what characters exist already?").
 */
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseBundleSource, resolveBundleDir } from '../../../dag/bundleSource.js';
import { loadBundle } from '../../../dag/walker.js';
import { findByCapability, type ProjectStateLike } from '../../../dag/capabilities.js';
import type { DagBundle } from '../../../dag/schema.js';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the dhee project directory.' }),
  type: Type.Optional(
    Type.String({
      description:
        "Optional capability-domain filter, e.g. 'character', 'setting', 'shot'. Matches displayCapability prefixes (character → character.image, character.prompt). Omit to list everything.",
    }),
  ),
});

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

function loadProject(projectDir: string): { bundle: DagBundle; state?: ProjectStateLike } {
  const pj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')) as {
    bundleSource?: string;
    walkState?: ProjectStateLike;
  };
  if (typeof pj.bundleSource !== 'string') throw new Error('project.json has no bundleSource.');
  const dirOrFile = resolveBundleDir(parseBundleSource(pj.bundleSource));
  const manifest = statSync(dirOrFile).isDirectory() ? join(dirOrFile, 'bundle.json') : dirOrFile;
  return { bundle: loadBundle(manifest), ...(pj.walkState ? { state: pj.walkState } : {}) };
}

export function makeListAssetsTool() {
  return defineTool({
    name: 'dhee_list_assets',
    label: 'List assets',
    description:
      "List the items already built in this project, grouped by capability (characters, settings, shots, …) with each item's id, status, and output path. Read-only projection over the event-sourced graph. Use it before dhee_add_item to see what exists and reuse ids (e.g. reference an existing character by id in a shot prompt).",
    parameters: Params,
    async execute(_id, params) {
      if (!existsSync(join(params.projectDir, 'project.json'))) {
        return textResult(`project.json not found in ${params.projectDir}.`, true);
      }
      let bundle: DagBundle;
      let state: ProjectStateLike | undefined;
      try {
        ({ bundle, state } = loadProject(params.projectDir));
      } catch (e) {
        return textResult(`Failed to load project bundle: ${e instanceof Error ? e.message : String(e)}`, true);
      }

      // Every distinct displayCapability declared in the bundle.
      const caps = [
        ...new Set(
          (bundle.nodes)
            .map((n) => n.displayCapability)
            .filter((c): c is string => typeof c === 'string'),
        ),
      ].filter((c) => !params.type || c.startsWith(params.type));

      if (caps.length === 0) {
        return textResult(
          params.type
            ? `No '${params.type}' assets — bundle '${bundle.id}' declares no matching capabilities.`
            : `Bundle '${bundle.id}' declares no display capabilities.`,
        );
      }

      const lines: string[] = [];
      for (const cap of caps.sort()) {
        const nodes = findByCapability(bundle, state, cap);
        const items: string[] = [];
        for (const cn of nodes) {
          for (const inst of cn.instances) {
            const id = inst.itemId ?? '(stage)';
            const mark = inst.status === 'completed' ? '✓' : inst.status;
            items.push(`    ${mark} ${id}${inst.outputPath ? ` → ${inst.outputPath}` : ''}`);
          }
        }
        lines.push(`${cap}:`);
        lines.push(items.length ? items.join('\n') : '    (none yet)');
      }
      return textResult(lines.join('\n'));
    },
  });
}

export const dheeListAssetsTool = makeListAssetsTool();
