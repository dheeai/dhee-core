/**
 * dhee_critique_node — apply an editorial critique to an LLM-generated
 * bundle node. Two-phase by design:
 *
 *   preview=true (or confirm omitted): walks the DAG from `nodeId`,
 *   returns the cascade impact (every node that would be re-fired if
 *   the critique were applied). DOES NOT mutate. Use this to surface
 *   "this will rebuild N images" before pulling the trigger.
 *
 *   confirm=true: stamps the critique into project.json's
 *   pendingCritiques map, invalidates the target node + walkState
 *   entry, and dispatches the bundle with runOnly: [nodeId]. The
 *   walker cascades downstream automatically. The llm.generate
 *   runner consumes the critique on its next invocation of that
 *   (node, item) and clears it after success.
 *
 * Only operates on nodes with an `llm.*` runner — non-LLM nodes are
 * deterministic given their inputs and can't be fixed by critique.
 * For broken non-text artifacts (images, video), the agent should
 * walk upstream to the nearest LLM node and critique THAT.
 */

import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseBundleSource,
  resolveBundleDir,
  BundleSourceError,
} from '../../../dag/bundleSource.js';
import { loadBundle } from '../../../dag/walker.js';
import {
  computeCascadeImpact,
  type AffectedNode,
} from '../../../dag/cascadeImpact.js';
import { runCritique } from '../../../dag/runCritique.js';
import type { RunProjectViaBundleFn } from '../../../dag/projectRegen.js';
import type { DagBundle } from '../../../dag/schema.js';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
  nodeId: Type.String({
    description:
      "The LLM-generated bundle node to critique. For broken images / videos, walk upstream first and target the prompt node that produced them — non-LLM nodes can't be critiqued directly.",
  }),
  itemId: Type.Optional(
    Type.String({
      description:
        "For collection nodes, the specific item id (e.g. 'scene_1_shot_3'). Omit to critique the whole node.",
    }),
  ),
  critique: Type.String({
    description:
      'A precise description of what went wrong with the current artifact and what should change in the regeneration. Be specific: cite missing tokens, wrong characters, broken composition, identity drift, etc.',
  }),
  confirm: Type.Optional(
    Type.Boolean({
      description:
        'When true, apply the critique (invalidates + re-runs the cascade). When false or omitted, returns a preview of which nodes would be affected. ALWAYS preview first.',
    }),
  ),
});

export interface CritiqueNodeDeps {
  runProjectViaBundle?: RunProjectViaBundleFn;
}

function textResult(text: string, details: Record<string, unknown> = {}, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

function loadProjectBundle(
  projectDir: string,
): { ok: true; bundle: DagBundle } | { ok: false; error: string } {
  const projectJsonPath = join(projectDir, 'project.json');
  if (!existsSync(projectJsonPath)) {
    return { ok: false, error: `project.json not found at ${projectJsonPath}` };
  }
  let project: { bundleSource?: string };
  try {
    project = JSON.parse(readFileSync(projectJsonPath, 'utf-8')) as { bundleSource?: string };
  } catch (err) {
    return { ok: false, error: `project.json malformed: ${(err as Error).message}` };
  }
  if (!project.bundleSource) {
    return { ok: false, error: 'project.json does not declare a bundleSource' };
  }
  try {
    const source = parseBundleSource(project.bundleSource);
    const dirOrFile = resolveBundleDir(source);
    const isDir = statSync(dirOrFile).isDirectory();
    const bundleJsonPath = isDir ? join(dirOrFile, 'bundle.json') : dirOrFile;
    const bundle = loadBundle(bundleJsonPath);
    return { ok: true, bundle };
  } catch (err) {
    if (err instanceof BundleSourceError) return { ok: false, error: err.message };
    return { ok: false, error: `bundle load failed: ${(err as Error).message}` };
  }
}

function formatPreview(
  nodeId: string,
  itemId: string | undefined,
  critique: string,
  affected: AffectedNode[],
): string {
  const target = itemId ? `${nodeId} (item: ${itemId})` : nodeId;
  const imageOrVideo = affected.filter((a) => a.format === 'image' || a.format === 'video');
  const lines = [
    `Preview — critique on ${target}`,
    '',
    `Critique: ${critique}`,
    '',
    `If applied, the following ${affected.length} node(s) will be invalidated + re-run:`,
    ...affected.map(
      (a) => `  - ${a.nodeId}  [runner: ${a.runner}, format: ${a.format}]`,
    ),
    '',
    `Image/video impact: ${imageOrVideo.length} node(s).`,
    imageOrVideo.length > 1
      ? 'IMPORTANT: more than one image/video node will be rebuilt. Ask the user for explicit confirmation before applying.'
      : 'Single image/video impact — agent may proceed to confirm=true without asking the user.',
  ];
  return lines.join('\n');
}

export function makeCritiqueNodeTool(deps: CritiqueNodeDeps = {}) {
  return defineTool({
    name: 'dhee_critique_node',
    label: 'Critique LLM node',
    description:
      "Apply an editorial critique to an LLM-generated bundle node. The runner prepends the critique to the next regeneration as a 'fix the previous output' instruction; the walker cascades downstream automatically. Two-phase: call FIRST with confirm omitted to preview the cascade impact, then with confirm=true to apply. Only works on nodes with llm.* runners — walk upstream from broken images/videos to find the right prompt node.",
    parameters: Params,
    async execute(_id, params, signal) {
      const load = loadProjectBundle(params.projectDir);
      if (!load.ok) {
        return textResult(`critique failed: ${load.error}`, {}, true);
      }
      const bundle = load.bundle;

      // Validate target node + runner before any side effects.
      const node = bundle.nodes.find((n) => n.id === params.nodeId);
      if (!node) {
        return textResult(`unknown node: '${params.nodeId}' is not in bundle '${bundle.id}'`, {}, true);
      }
      if (!node.runner.tool.startsWith('llm.')) {
        return textResult(
          `Cannot critique node '${params.nodeId}' — its runner is '${node.runner.tool}', not llm.*. ` +
            `Walk upstream via the bundle's inputs[] graph and critique the nearest llm.* node instead.`,
          { runner: node.runner.tool },
          true,
        );
      }

      // Phase 1: preview.
      const impact = computeCascadeImpact({
        bundle,
        nodeId: params.nodeId,
        ...(params.itemId ? { itemId: params.itemId } : {}),
      });
      if (impact.error) {
        return textResult(`critique preview failed: ${impact.error}`, {}, true);
      }
      const imageOrVideoCount = impact.affectedNodes.filter(
        (a) => a.format === 'image' || a.format === 'video',
      ).length;

      if (!params.confirm) {
        return textResult(
          formatPreview(params.nodeId, params.itemId, params.critique, impact.affectedNodes),
          {
            preview: true,
            affectedNodes: impact.affectedNodes,
            imageOrVideoCount,
            confirmationRecommended: imageOrVideoCount > 1,
          },
        );
      }

      // Phase 2: apply.
      const result = await runCritique({
        projectDir: params.projectDir,
        bundle,
        nodeId: params.nodeId,
        ...(params.itemId ? { itemId: params.itemId } : {}),
        critique: params.critique,
        ...(signal ? { signal } : {}),
        ...(deps.runProjectViaBundle ? { runProjectViaBundle: deps.runProjectViaBundle as never } : {}),
      });
      const target = params.itemId ? `${params.nodeId}:${params.itemId}` : params.nodeId;
      if (!result.ok) {
        return textResult(
          `critique apply failed on '${target}': ${result.error ?? '(no error)'}`,
          { applied: false },
          true,
        );
      }
      return textResult(
        `Critique applied to '${target}'. Pending critique stamped in project.json; node invalidated; bundle re-dispatched with runOnly: ['${params.nodeId}']. Downstream nodes will cascade-rerun via the walker.`,
        { applied: true, affectedNodes: impact.affectedNodes, target },
      );
    },
  });
}

export const dheeCritiqueNodeTool = makeCritiqueNodeTool();
