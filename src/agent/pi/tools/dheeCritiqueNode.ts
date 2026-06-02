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
 *   entry (and every transitive consumer via cascade-invalidation),
 *   then dispatches the bundle. Post-cascade-refactor: dispatch
 *   carries no runOnly — the walker is state-as-truth. The
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
  applyOnly: Type.Optional(
    Type.Boolean({
      description:
        'BATCH MODE. When true, stamps the critique + invalidates the target but does NOT dispatch the bundle. Use when you have many critiques to apply in a row — each call returns in milliseconds instead of waiting on the full cascade. After the last batched critique, call dhee_run_bundle ONCE to process every pending critique in a single walker pass. Ignored if confirm is not also true.',
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

interface ProjectLoad {
  bundle: DagBundle;
  walkState?: {
    nodes?: Record<string, { status?: string; outputPath?: string } | undefined>;
  };
}

function loadProjectBundle(
  projectDir: string,
): { ok: true; load: ProjectLoad } | { ok: false; error: string } {
  const projectJsonPath = join(projectDir, 'project.json');
  if (!existsSync(projectJsonPath)) {
    return { ok: false, error: `project.json not found at ${projectJsonPath}` };
  }
  let project: { bundleSource?: string; walkState?: ProjectLoad['walkState'] };
  try {
    project = JSON.parse(readFileSync(projectJsonPath, 'utf-8')) as {
      bundleSource?: string;
      walkState?: ProjectLoad['walkState'];
    };
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
    return {
      ok: true,
      load: { bundle, ...(project.walkState ? { walkState: project.walkState } : {}) },
    };
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
  affectedNonTextArtifacts: AffectedNode[],
): string {
  const target = itemId ? `${nodeId} (item: ${itemId})` : nodeId;
  const lines = [
    `Preview — critique on ${target}`,
    '',
    `Critique: ${critique}`,
    '',
    `Full structural cascade — ${affected.length} node(s) the walker would visit:`,
    ...affected.map(
      (a) => `  - ${a.nodeId}  [runner: ${a.runner}, format: ${a.format}]`,
    ),
    '',
    `Real impact — non-text artifacts that have actually been generated and would be destroyed: ${affectedNonTextArtifacts.length}`,
    ...(affectedNonTextArtifacts.length === 0
      ? ['  (none — nothing downstream has rendered yet, or all downstream is text/json)']
      : affectedNonTextArtifacts.map(
          (a) => `  - ${a.nodeId}  [${a.format}, runner: ${a.runner}]`,
        )),
    '',
    affectedNonTextArtifacts.length > 1
      ? 'IMPORTANT: more than one already-rendered non-text artifact will be destroyed. Ask the user for explicit confirmation before applying.'
      : 'At most one already-rendered non-text artifact will be affected — agent may proceed to confirm=true without asking the user.',
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
      const loadRes = loadProjectBundle(params.projectDir);
      if (!loadRes.ok) {
        return textResult(`critique failed: ${loadRes.error}`, {}, true);
      }
      const { bundle, walkState } = loadRes.load;

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

      // Phase 1: preview. Pass walkState so the impact view filters
      // to non-text artifacts that have actually been generated.
      // Confirmation gate keys off the walkState-aware count, NOT the
      // structural count — text-only or never-rendered downstream
      // shouldn't trigger a "stop and ask" since there's nothing to
      // destroy.
      const impact = computeCascadeImpact({
        bundle,
        nodeId: params.nodeId,
        ...(params.itemId ? { itemId: params.itemId } : {}),
        ...(walkState ? { walkState } : {}),
      });
      if (impact.error) {
        return textResult(`critique preview failed: ${impact.error}`, {}, true);
      }
      const realImpactCount = impact.affectedNonTextArtifacts.length;

      if (!params.confirm) {
        return textResult(
          formatPreview(
            params.nodeId,
            params.itemId,
            params.critique,
            impact.affectedNodes,
            impact.affectedNonTextArtifacts,
          ),
          {
            preview: true,
            affectedNodes: impact.affectedNodes,
            affectedNonTextArtifacts: impact.affectedNonTextArtifacts,
            realImpactCount,
            confirmationRecommended: realImpactCount > 1,
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
        ...(params.applyOnly ? { applyOnly: true } : {}),
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
      const message = params.applyOnly
        ? `Critique batched for '${target}'. pendingCritique stamped + node invalidated; dispatch SKIPPED (applyOnly). Call dhee_run_bundle when all batched critiques are queued.`
        : `Critique applied to '${target}'. Pending critique stamped in project.json; node + downstream cascade invalidated via event-derived dep graph; bundle re-dispatched (walker re-runs everything pending).`;
      return textResult(message, {
        applied: true,
        applyOnly: params.applyOnly === true,
        affectedNodes: impact.affectedNodes,
        affectedNonTextArtifacts: impact.affectedNonTextArtifacts,
        target,
      });
    },
  });
}

export const dheeCritiqueNodeTool = makeCritiqueNodeTool();
