/**
 * dhee_apply_workflow_aliases — persist agent-decided model
 * remappings + class swaps to the per-endpoint alias store. Constrained
 * write: the alias schema is narrow (string→string name swaps and
 * per-workflow per-node class_type swaps), so the agent cannot
 * accidentally edit graph topology, change a seed, rewire inputs,
 * etc. Safety enforced by the store's `applyAliases` impl.
 *
 * Safety rail for class swaps: before persisting, the tool queries
 * the target Comfy's /object_info and verifies each proposed
 * (newClass, sameField) is actually offered. A nonsense class name
 * is rejected with a clear error — the agent retries with a valid
 * pick, or gives up and tells the user.
 *
 * Pair with dhee_check_workflow — the agent reads the available
 * classes from check's `available_by_class`, decides the mapping,
 * passes it here.
 */

import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { resolve } from 'node:path';
import {
  writeAliases,
  readAliases,
  type WorkflowAliases,
} from '../../../dag/workflowAliases.js';

const ClassSwap = Type.Object({
  workflowKey: Type.String({ description: 'Same workflowKey the check tool returned (e.g. workflows/qwen_edit_multi.json).' }),
  nodeId: Type.String({ description: 'Node id within the workflow (e.g. UNET, CLIP, LORA_LIGHT).' }),
  newClass: Type.String({ description: 'New class_type to swap to (e.g. UnetLoaderGGUF). Must exist on the target Comfy.' }),
  field: Type.String({ description: 'The model-name input field whose presence on newClass we verify (e.g. unet_name).' }),
});

const Params = Type.Object({
  endpoint: Type.String({ description: 'HTTP URL of the target ComfyUI; aliases are stored per endpoint.' }),
  name_aliases: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: 'Map of bundle-canonical name → local actual name. Use when the user has the same logical model under a different filename. Global per-endpoint.',
    }),
  ),
  class_swaps: Type.Optional(
    Type.Array(ClassSwap, {
      description: 'Per-node class_type swaps (e.g. UNETLoader → UnetLoaderGGUF). Each swap is scoped to one (workflowKey, nodeId). The tool validates that newClass + field actually exists on the target Comfy before persisting.',
    }),
  ),
});

function textResult(text: string, details: Record<string, unknown> = {}, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

interface ObjectInfo {
  [className: string]: {
    input?: {
      required?: Record<string, [unknown, unknown]>;
    };
  };
}

async function fetchObjectInfo(endpoint: string): Promise<ObjectInfo> {
  const resp = await fetch(`${endpoint.replace(/\/$/, '')}/object_info`);
  if (!resp.ok) throw new Error(`/object_info returned ${resp.status}`);
  return (await resp.json()) as ObjectInfo;
}

function classOffersField(info: ObjectInfo, className: string, fieldName: string): boolean {
  const cls = info[className];
  if (!cls?.input?.required) return false;
  return fieldName in cls.input.required;
}

export function makeApplyWorkflowAliasesTool() {
  return defineTool({
    name: 'dhee_apply_workflow_aliases',
    label: 'Persist workflow aliases',
    description:
      "Persist your decided model-name remappings + class swaps so the runner uses them on the next dispatch. Constrained write: only string→string name swaps and per-node class_type swaps are accepted; you cannot edit graph topology or non-name inputs. Class swaps are validated against the target Comfy — a newClass that doesn't actually exist (or doesn't offer the same field name) is rejected. Call AFTER dhee_check_workflow once you've decided the mapping (use the agent's intelligence to pick from `available_by_class`).",
    parameters: Params,
    async execute(_id, params) {
      const aliasesDir = process.env['DHEE_WORKFLOW_ALIASES_DIR']
        || resolve(process.env['HOME'] ?? '', '.dhee', 'workflow-aliases');

      // Safety rail: validate any proposed class swaps against the
      // live /object_info. Reject the whole call if any swap names a
      // class that doesn't exist or doesn't offer the declared field.
      if (params.class_swaps && params.class_swaps.length > 0) {
        let info: ObjectInfo;
        try {
          info = await fetchObjectInfo(params.endpoint);
        } catch (err) {
          return textResult(
            `Cannot validate class swaps — /object_info fetch failed: ${(err as Error).message}. ` +
              `Try again when the Comfy is reachable.`,
            {},
            true,
          );
        }
        const violations: string[] = [];
        for (const swap of params.class_swaps) {
          if (!classOffersField(info, swap.newClass, swap.field)) {
            violations.push(
              `class '${swap.newClass}' does not offer field '${swap.field}' on ${params.endpoint} (or the class itself is missing)`,
            );
          }
        }
        if (violations.length > 0) {
          return textResult(
            `Class-swap validation failed:\n${violations.map((v) => '  - ' + v).join('\n')}\n\n` +
              `Pick a different class from \`available_by_class\` in the dhee_check_workflow result.`,
            { violations },
            true,
          );
        }
      }

      // Build the patch + write (merge semantics handled by the store).
      const patch: WorkflowAliases = {};
      if (params.name_aliases && Object.keys(params.name_aliases).length > 0) {
        patch.name_aliases = params.name_aliases;
      }
      if (params.class_swaps && params.class_swaps.length > 0) {
        const grouped: Record<string, Record<string, string>> = {};
        for (const swap of params.class_swaps) {
          grouped[swap.workflowKey] ??= {};
          grouped[swap.workflowKey]![swap.nodeId] = swap.newClass;
        }
        patch.class_swaps = grouped;
      }
      if (!patch.name_aliases && !patch.class_swaps) {
        return textResult(`Nothing to apply — pass at least one of name_aliases or class_swaps.`, {}, true);
      }
      writeAliases(aliasesDir, params.endpoint, patch);

      const finalAliases = readAliases(aliasesDir, params.endpoint);
      const summary = [
        `Persisted to ${aliasesDir} (endpoint: ${params.endpoint}).`,
        ...(patch.name_aliases ? [`Added ${Object.keys(patch.name_aliases).length} name alias(es).`] : []),
        ...(patch.class_swaps
          ? [`Added ${Object.values(patch.class_swaps).reduce((sum, m) => sum + Object.keys(m).length, 0)} class swap(s).`]
          : []),
        '',
        'Effective on the next runner dispatch. Retry the workflow now.',
      ].join('\n');
      return textResult(summary, { applied: patch, current: finalAliases });
    },
  });
}

export const dheeApplyWorkflowAliasesTool = makeApplyWorkflowAliasesTool();
