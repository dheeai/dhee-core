/**
 * dhee_set_project_field — persist a project-kind bundle input
 * (e.g. targetDuration, style, aspect) to project.json.
 *
 * Closes the gap that lost "make it 3 minutes": projects created via
 * the agent (dhee_create_project) carried no duration, so the walker
 * fell back to the bundle default. The Production Slate writes these
 * fields up front; this is the symmetric tool for when the user states
 * a setting in CHAT ("actually make it 3 minutes", "switch to noir").
 *
 * Scoped + safe: only writes fields the active bundle declares as
 * `kind: 'project'` inputs. It will NOT write arbitrary keys — so the
 * agent can't clobber bundleSource / walkState / name. Use
 * dhee_write_input for `kind: 'file'` inputs (story.md etc.).
 *
 * Does NOT cascade. A project-kind input is re-read fresh at every
 * walk, but already-completed nodes are skipped (state-as-truth), so
 * a change only takes effect on nodes generated AFTER it. If a plan
 * already exists, the result tells the agent to regenerate from the
 * first node that consumes the field (e.g. plot / scenes_plan for
 * targetDuration).
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { loadBundle } from '../../../dag/walker.js';
import { parseBundleSource, resolveBundleDir } from '../../../dag/bundleSource.js';
import type { BundleInputDecl, DagBundle } from '../../../dag/schema.js';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the dhee project directory.' }),
  inputId: Type.String({
    description:
      "The bundle input id to set (e.g. 'targetDuration', 'style', 'aspect'). Must be a `kind:'project'` input declared by the active bundle — call dhee_describe_bundle to see them. For file inputs (story_input) use dhee_write_input instead.",
  }),
  value: Type.Union([Type.String(), Type.Number(), Type.Boolean()], {
    description:
      "The value to set (e.g. 180 for targetDuration, 'noir' for style). Numeric inputs accept a numeric string too — it's coerced.",
  }),
});

export interface SetProjectFieldDeps {
  loadBundleForProject?: (projectDir: string) => DagBundle;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

function loadBundleFromProject(projectDir: string): DagBundle {
  const pj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')) as { bundleSource?: string };
  if (typeof pj.bundleSource !== 'string') {
    throw new Error('project.json has no bundleSource field.');
  }
  const dirOrJson = resolveBundleDir(parseBundleSource(pj.bundleSource));
  const manifestPath = statSync(dirOrJson).isDirectory() ? join(dirOrJson, 'bundle.json') : dirOrJson;
  return loadBundle(manifestPath);
}

function setDeep(target: Record<string, unknown>, dottedField: string, value: unknown): void {
  const parts = dottedField.split('.').filter(Boolean);
  let node: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = node[key];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      const fresh: Record<string, unknown> = {};
      node[key] = fresh;
      node = fresh;
    } else {
      node = next as Record<string, unknown>;
    }
  }
  node[parts[parts.length - 1]!] = value;
}

/** A project-kind input decl (the only kind this tool writes). */
type ProjectInputDecl = Extract<BundleInputDecl, { kind: 'project' }>;

export function makeSetProjectFieldTool(deps: SetProjectFieldDeps = {}) {
  const loadBundleFn = deps.loadBundleForProject ?? loadBundleFromProject;

  return defineTool({
    name: 'dhee_set_project_field',
    label: 'Set project field',
    description:
      "Persist a project-level setting (targetDuration, style, aspect, …) to project.json when the user states it in chat. Only writes inputs the active bundle declares as kind:'project' — it can't touch bundleSource/walkState. Does not cascade: a change applies to nodes generated AFTER it, so if a plan already exists, regenerate the first node that uses the setting (e.g. dhee_regenerate_node('plot') / ('scenes_plan') for targetDuration). For file inputs (the story) use dhee_write_input.",
    parameters: Params,
    async execute(_id, params) {
      if (!existsSync(params.projectDir)) {
        return textResult(`projectDir not found: ${params.projectDir}`, true);
      }
      const pjPath = join(params.projectDir, 'project.json');
      if (!existsSync(pjPath)) {
        return textResult(`project.json missing at ${pjPath}.`, true);
      }

      let bundle: DagBundle;
      try {
        bundle = loadBundleFn(params.projectDir);
      } catch (e) {
        return textResult(`Failed to load bundle: ${e instanceof Error ? e.message : String(e)}`, true);
      }

      const decls = (bundle.inputs ?? []) as BundleInputDecl[];
      const projectInputs = decls.filter((d): d is ProjectInputDecl => d.kind === 'project');
      const decl = projectInputs.find((d) => d.id === params.inputId);

      if (!decl) {
        // Distinguish "it's a file input" from "no such input" for a useful error.
        const asFile = decls.find(
          (d): d is Extract<BundleInputDecl, { kind: 'file' }> =>
            d.id === params.inputId && d.kind === 'file',
        );
        if (asFile) {
          return textResult(
            `'${params.inputId}' is a file input (path: ${asFile.path}). Use dhee_write_input for that, not dhee_set_project_field.`,
            true,
          );
        }
        const allowed = projectInputs.map((d) => d.id).join(', ') || '(none)';
        return textResult(
          `'${params.inputId}' is not a project-kind input of bundle '${bundle.id}'. Settable fields: ${allowed}.`,
          true,
        );
      }

      // Coerce numeric option values: if the input's options are all
      // numbers (e.g. durations) and the agent passed a numeric string,
      // store a number so the prompt-template substitution + any numeric
      // consumers behave.
      let value: unknown = params.value;
      const optionsAllNumeric =
        Array.isArray(decl.options) &&
        decl.options.length > 0 &&
        decl.options.every((o) => typeof o.value === 'number');
      if (optionsAllNumeric && typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
        value = Number(value);
      }

      // Soft validation against declared options — write regardless, but
      // note it so the agent can flag an unusual value to the user.
      let optionNote = '';
      if (Array.isArray(decl.options) && decl.options.length > 0) {
        const known = decl.options.some((o) => o.value === value);
        if (!known) {
          const opts = decl.options.map((o) => o.value).join(', ');
          optionNote = ` (note: not one of the usual options [${opts}] — applied anyway)`;
        }
      }

      const pj = JSON.parse(readFileSync(pjPath, 'utf8')) as Record<string, unknown>;
      setDeep(pj, decl.field, value);
      writeFileSync(pjPath, JSON.stringify(pj, null, 2), 'utf8');

      // Heuristic: has anything been generated yet? If walkState has any
      // completed node, the existing plan predates this change.
      const ws = pj['walkState'] as { nodes?: Record<string, { status?: string }> } | undefined;
      const hasGenerated = !!ws?.nodes && Object.values(ws.nodes).some((n) => n?.status === 'completed');
      const applyNote = hasGenerated
        ? ` A plan already exists, so this won't change existing nodes — regenerate the first node that uses it (e.g. dhee_regenerate_node for 'plot' or 'scenes_plan') to apply it.`
        : ` It'll be used when the pipeline runs.`;

      return textResult(
        `Set ${decl.field} = ${JSON.stringify(value)} on project.json${optionNote}.${applyNote}`,
      );
    },
  });
}

export const dheeSetProjectFieldTool = makeSetProjectFieldTool();
