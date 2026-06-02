/**
 * dhee_write_input — write bytes to a bundle-declared input file.
 *
 * The agent passes `inputId` (e.g. 'story_input', 'character_ref_lara');
 * the tool resolves the canonical path from the bundle's `inputs[]`
 * declaration and writes the bytes there. Emits an `inputs.provided`
 * event so the projection records the change and downstream nodes
 * cascade on the next walk.
 *
 * Why not a generic path-based write? Inputs are typed (file vs project
 * field) and have known locations. Letting the agent pick paths means
 * grepping the bundle to find the right one, plus there's no defense
 * against accidental writes to project.json / .dhee/.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { openEventLog } from '../../../dag/eventLog/EventLog.js';
import { loadBundle } from '../../../dag/walker.js';
import { parseBundleSource, resolveBundleDir } from '../../../dag/bundleSource.js';
import type { BundleInputDecl, DagBundle } from '../../../dag/schema.js';
import { resolveWritePayload, WritePayloadSchema, type WritePayload } from './writePayload.js';

const Params = Type.Object({
  projectDir: Type.String({
    description: 'Absolute path to the dhee project directory (the one with project.json).',
  }),
  inputId: Type.String({
    description:
      'Which input to write, by id. Must match an entry in the bundle\'s `inputs[]` with `kind: "file"`. Call dhee_list_bundles + read bundle.json (or inspect via dhee_describe_bundle once that lands) to learn the input ids.',
  }),
  payload: WritePayloadSchema,
  reason: Type.Optional(
    Type.String({
      description: 'Short note recorded on the event log entry. Helps human + future-you understand WHY the input was rewritten.',
    }),
  ),
});

export interface WriteInputDeps {
  /** Override the bundle loader for tests. Resolves projectDir → DagBundle. */
  loadBundleForProject?: (projectDir: string) => DagBundle;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

function loadBundleFromProject(projectDir: string): DagBundle {
  const pjPath = join(projectDir, 'project.json');
  const pj = JSON.parse(readFileSync(pjPath, 'utf8')) as { bundleSource?: string };
  if (typeof pj.bundleSource !== 'string') {
    throw new Error(`project.json at ${pjPath} has no bundleSource field.`);
  }
  const src = parseBundleSource(pj.bundleSource);
  const bundleDir = resolveBundleDir(src);
  // bundleDir may point at either a directory containing bundle.json
  // or directly at a single-file bundle (.json). loadBundle wants the
  // JSON path.
  let manifestPath = bundleDir;
  try {
    if (statSync(bundleDir).isDirectory()) {
      manifestPath = join(bundleDir, 'bundle.json');
    }
  } catch {
    // fall through; loadBundle will error
  }
  return loadBundle(manifestPath);
}

export function makeWriteInputTool(deps: WriteInputDeps = {}) {
  const loadBundleFn = deps.loadBundleForProject ?? loadBundleFromProject;

  return defineTool({
    name: 'dhee_write_input',
    label: 'Write input',
    description:
      "Write content to a bundle-declared input file (e.g. inputs/story.md, inputs/character_refs/<name>.png). Pass `inputId` (from the bundle's `inputs[]` list) and a `payload` with one of three shapes: { kind: 'text', content } for text, { kind: 'base64', contentBase64 } for small binary, { kind: 'localFile', sourcePath } to copy from a path the desktop staged for you. Emits an inputs.provided event so the projection picks up the change on the next walk.",
    parameters: Params,
    async execute(_id, params) {
      // 1. Project directory + project.json sanity checks.
      if (!existsSync(params.projectDir)) {
        return textResult(`projectDir not found: ${params.projectDir}`, true);
      }
      const pjPath = join(params.projectDir, 'project.json');
      if (!existsSync(pjPath)) {
        return textResult(`project.json missing at ${pjPath} — is this a dhee project?`, true);
      }

      // 2. Resolve the bundle's input decl.
      let bundle: DagBundle;
      try {
        bundle = loadBundleFn(params.projectDir);
      } catch (e) {
        return textResult(
          `Failed to load bundle for project: ${e instanceof Error ? e.message : String(e)}`,
          true,
        );
      }
      const decls: BundleInputDecl[] = (bundle.inputs ?? []) as BundleInputDecl[];
      if (decls.length === 0) {
        return textResult(
          `Bundle '${bundle.id}' declares no inputs[]. There is nothing to write via dhee_write_input.`,
          true,
        );
      }
      const decl = decls.find((d) => d.id === params.inputId);
      if (!decl) {
        const known = decls.map((d) => d.id).join(', ');
        return textResult(
          `Unknown inputId '${params.inputId}'. Bundle '${bundle.id}' inputs: ${known}.`,
          true,
        );
      }
      if (decl.kind !== 'file') {
        return textResult(
          `Input '${params.inputId}' has kind='${decl.kind}', not 'file'. dhee_write_input only writes file-kind inputs; project-kind inputs are fields in project.json and not yet editable via this tool.`,
          true,
        );
      }

      // 3. Path safety: declared path is relative to projectDir and must
      //    resolve back inside projectDir (no '../' escapes).
      if (isAbsolute(decl.path)) {
        return textResult(
          `Input '${params.inputId}' has an absolute path '${decl.path}' in the bundle declaration — refusing.`,
          true,
        );
      }
      const targetAbs = resolve(params.projectDir, decl.path);
      const projectAbs = resolve(params.projectDir);
      const rel = relative(projectAbs, targetAbs);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return textResult(
          `Input '${params.inputId}' resolves to '${targetAbs}' which is outside the project dir. Path traversal — refusing.`,
          true,
        );
      }

      // 4. Materialize bytes from payload.
      let bytes: Buffer;
      try {
        bytes = resolveWritePayload(params.payload as WritePayload);
      } catch (e) {
        return textResult(
          `Failed to resolve payload: ${e instanceof Error ? e.message : String(e)}`,
          true,
        );
      }

      // 5. Auto-create parent dir + write.
      mkdirSync(dirname(targetAbs), { recursive: true });
      writeFileSync(targetAbs, bytes);

      // 6. Append inputs.provided event so projections cascade.
      const log = openEventLog(params.projectDir);
      log.append({
        kind: 'inputs.provided',
        actor: 'agent',
        branchId: 'main',
        payload: {
          inputs: { [params.inputId]: { path: decl.path, bytes: bytes.length, reason: params.reason ?? null } },
        },
      });

      return textResult(
        `Wrote ${bytes.length} bytes to ${decl.path} for input '${params.inputId}'.`,
      );
    },
  });
}

export const dheeWriteInputTool = makeWriteInputTool();
