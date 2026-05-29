/**
 * dhee_check_workflow — given a ComfyUI workflow file + an endpoint
 * URL, return the raw facts the agent needs to make decisions about
 * model-availability:
 *
 *   - workflow_refs:        every model reference in the workflow
 *   - missing_refs:         subset NOT available on the target Comfy
 *                           (after applying any saved aliases)
 *   - available_by_class:   every <class>.<field> the Comfy exposes
 *                           (includes UnetLoaderGGUF / GGUF clip / etc.
 *                           so the agent can see cross-class options)
 *
 * No verdicts, no fuzzy matching. The agent's intelligence picks
 * which available model maps to which missing ref (or asks the user
 * when ambiguous).
 *
 * Pairs with dhee_apply_workflow_aliases — once the agent decides
 * the mapping, it calls that tool to persist + take effect on the
 * next run.
 */

import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkWorkflow, type ComfyWorkflow } from '../../../dag/workflowVerify.js';
import { readAliases } from '../../../dag/workflowAliases.js';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory (used to resolve workflowPath relative to the bundle).' }),
  workflowPath: Type.String({
    description:
      "Path to the workflow JSON, either absolute OR relative to the bundle dir. The check tool resolves it from projectDir's bundleSource if not absolute.",
  }),
  endpoint: Type.String({
    description: 'HTTP URL of the target ComfyUI (e.g. https://comfyui.share.zrok.io). The /object_info endpoint is appended for the query.',
  }),
});

interface ResolvedBundle {
  bundleDir: string;
}

async function resolveBundleDir(projectDir: string): Promise<ResolvedBundle | null> {
  const projectJsonPath = resolve(projectDir, 'project.json');
  if (!existsSync(projectJsonPath)) return null;
  try {
    const project = JSON.parse(readFileSync(projectJsonPath, 'utf8')) as { bundleSource?: string };
    if (!project.bundleSource) return null;
    const bundleSourceMod = await import('../../../dag/bundleSource.js');
    const source = bundleSourceMod.parseBundleSource(project.bundleSource);
    const dirOrFile = bundleSourceMod.resolveBundleDir(source);
    const { statSync } = await import('node:fs');
    const isDir = statSync(dirOrFile).isDirectory();
    return { bundleDir: isDir ? dirOrFile : resolve(dirOrFile, '..') };
  } catch {
    return null;
  }
}

function textResult(text: string, details: Record<string, unknown> = {}, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

export function makeCheckWorkflowTool() {
  return defineTool({
    name: 'dhee_check_workflow',
    label: 'Check workflow model availability',
    description:
      "For a ComfyUI workflow + endpoint, returns the raw facts: model refs in the workflow, missing refs (not on the target Comfy), and the full available-models-per-class map (including UnetLoaderGGUF / CLIPLoaderGGUF / NF4 / etc.). Use BEFORE running a comfy workflow when you suspect the user's local Comfy may not match the bundle author's setup. Pure read — no side effects. Pair with dhee_apply_workflow_aliases to persist your remap decisions.",
    parameters: Params,
    async execute(_id, params) {
      // Resolve workflowPath relative to bundle dir if not absolute.
      let absWfPath = params.workflowPath;
      if (!absWfPath.startsWith('/')) {
        const resolved = await resolveBundleDir(params.projectDir);
        if (!resolved) {
          return textResult(
            `Could not resolve bundle directory from project at ${params.projectDir}. Pass an absolute workflowPath instead.`,
            {},
            true,
          );
        }
        absWfPath = resolve(resolved.bundleDir, params.workflowPath);
      }
      if (!existsSync(absWfPath)) {
        return textResult(`Workflow file not found at ${absWfPath}`, {}, true);
      }

      let workflow: ComfyWorkflow;
      try {
        workflow = JSON.parse(readFileSync(absWfPath, 'utf8')) as ComfyWorkflow;
      } catch (err) {
        return textResult(`Workflow JSON malformed: ${(err as Error).message}`, {}, true);
      }

      // Pull any existing endpoint aliases so they're applied before
      // the diff — refs already remapped to an installed name aren't
      // reported as missing.
      const aliasesDir = process.env['DHEE_WORKFLOW_ALIASES_DIR']
        || resolve(process.env['HOME'] ?? '', '.dhee', 'workflow-aliases');
      const existing = readAliases(aliasesDir, params.endpoint);

      const result = await checkWorkflow({
        workflow,
        endpoint: params.endpoint,
        fetchObjectInfo: async (url) => {
          const resp = await fetch(`${url.replace(/\/$/, '')}/object_info`);
          if (!resp.ok) throw new Error(`/object_info returned ${resp.status}`);
          return (await resp.json()) as Record<string, unknown>;
        },
        ...(existing.name_aliases ? { endpointAliases: existing.name_aliases } : {}),
      });

      // Render a concise summary in `text` and the full data in `details`.
      // The agent picks from `details.available_by_class` to construct a
      // remap proposal.
      if (result.error) {
        return textResult(
          `dhee_check_workflow failed: ${result.error}\nendpoint: ${params.endpoint}`,
          { error: result.error },
          true,
        );
      }
      // Per-missing-ref section: rank candidates by simple shared-
      // token overlap with the missing name so the agent sees the
      // RELEVANT options first, not 22 alphabetized names. Tight
      // output — the agent's job is to pick from a short shortlist,
      // not skim every model on the user's Comfy.
      const TOP_SAME_CLASS = 8;
      const TOP_CROSS_CLASS_PER_KEY = 3;
      function tokens(s: string): string[] {
        return s
          .toLowerCase()
          .replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|sft)$/, '')
          .split(/[-_.\s]+/)
          .filter((t) => t.length > 0);
      }
      function rankByOverlap(target: string, names: string[]): string[] {
        const tTok = new Set(tokens(target));
        return names
          .map((n) => {
            let shared = 0;
            for (const t of tokens(n)) if (tTok.has(t)) shared += 1;
            return { name: n, shared };
          })
          .sort((a, b) => b.shared - a.shared)
          .map((x) => x.name);
      }
      function renderForRef(r: typeof result.missing_refs[number]): string[] {
        const sameKey = `${r.nodeType}.${r.inputField}`;
        const sameAll = result.available_by_class[sameKey] ?? [];
        const sameRanked = rankByOverlap(r.current_value, sameAll).slice(0, TOP_SAME_CLASS);
        const lines: string[] = [
          `MISSING: ${r.nodeType}.${r.inputField}[${r.nodeId}] = ${r.current_value}`,
          sameAll.length === 0
            ? `  Same-class options: (none — class missing or empty on this Comfy)`
            : `  Same-class options (top ${sameRanked.length} of ${sameAll.length} ranked by name similarity):`,
          ...sameRanked.map((n) => `    - ${n}`),
        ];
        // Cross-class: other classes offering the same field name. Show
        // the class name + top few candidates each (ranked by relevance).
        const crossEntries = Object.entries(result.available_by_class)
          .filter(([key]) => key !== sameKey && key.endsWith('.' + r.inputField));
        if (crossEntries.length > 0) {
          lines.push(`  Cross-class options (same field "${r.inputField}" on other classes):`);
          for (const [key, names] of crossEntries) {
            const ranked = rankByOverlap(r.current_value, names).slice(0, TOP_CROSS_CLASS_PER_KEY);
            lines.push(`    ${key}  (${names.length} total):`);
            for (const n of ranked) lines.push(`      - ${n}`);
          }
        }
        return lines;
      }
      const summary = [
        `Workflow: ${params.workflowPath}`,
        `Endpoint: ${params.endpoint}`,
        `Refs: ${result.workflow_refs.length} model references in workflow`,
        `Missing: ${result.missing_refs.length}`,
        ...(result.missing_refs.length === 0
          ? ['All referenced models are available on this Comfy.']
          : [
              '',
              ...result.missing_refs.flatMap((r) => [...renderForRef(r), '']),
              'Decide on a mapping using your judgment, then call dhee_apply_workflow_aliases.',
              '  - same-class candidate that is clearly the same logical model → name_aliases',
              '  - cross-class candidate (e.g. .gguf via UnetLoaderGGUF) → class_swaps + name_aliases',
              '  - ambiguous: ASK THE USER which to use',
              '  - no candidate at all anywhere: tell the user the model is missing + name it.',
            ]),
      ].join('\n');

      return textResult(summary, {
        ok: result.ok,
        workflow_refs: result.workflow_refs,
        missing_refs: result.missing_refs,
        available_by_class: result.available_by_class,
        existing_aliases: existing,
        workflowKey: params.workflowPath,
      });
    },
  });
}

export const dheeCheckWorkflowTool = makeCheckWorkflowTool();
