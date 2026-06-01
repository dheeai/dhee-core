/**
 * dhee_create_project — create a fresh project directory with a
 * minimal project.json pinned to the chosen bundleId.
 *
 * Not destructive: refuses to overwrite an existing project name.
 * Validation of bundleId is best-effort — the canonical list lives in
 * src/dag/bundles/. If `knownBundleIds` is injected we check against it;
 * otherwise we trust the caller (the walker will produce a clearer
 * error at run time if the bundle doesn't resolve).
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { getProjectsDir } from '../paths.js';

const Params = Type.Object({
  name: Type.String({
    description:
      'Short project name. Becomes the display name and (in legacy mode) the directory name under the dhee projects dir. Letters/numbers/underscores recommended.',
  }),
  bundleId: Type.String({
    description:
      "Bundle id to pin (e.g. 'narrative_qwen_chain_relay', 'narrative_prompt_relay', 'narrative_shot_by_shot'). Written to project.json as 'built-in:<bundleId>'. Use dhee_list_bundles first to see what's available.",
  }),
  description: Type.Optional(
    Type.String({
      description: 'Optional human-readable description; recorded on the project for UI display.',
    }),
  ),
  existingDir: Type.Optional(
    Type.String({
      description:
        'Absolute path of a folder the caller has already created (typically by the desktop\'s "+New Project" button). The tool will populate project.json INTO this folder rather than creating a new one under the projects dir. Refuses if the folder already contains a project.json.',
    }),
  ),
});

export interface CreateProjectDeps {
  /** Defaults to paths.getProjectsDir(). Override in tests. */
  getProjectsDir?: typeof getProjectsDir;
  /** When provided, the tool rejects any bundleId not in the list. */
  knownBundleIds?: string[];
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

export function makeCreateProjectTool(deps: CreateProjectDeps = {}) {
  const dirFn = deps.getProjectsDir ?? getProjectsDir;
  return defineTool({
    name: 'dhee_create_project',
    label: 'Create project',
    description:
      'Create a fresh dhee project directory pinned to a specific bundle. Writes project.json with bundleSource = built-in:<bundleId>. Does NOT start a run — call dhee_run_bundle for that.',
    parameters: Params,
    async execute(_id, params) {
      if (deps.knownBundleIds && !deps.knownBundleIds.includes(params.bundleId)) {
        return textResult(
          `unknown bundle '${params.bundleId}'. Known: ${deps.knownBundleIds.join(', ')}`,
          true,
        );
      }

      let projectDir: string;
      if (params.existingDir) {
        if (!existsSync(params.existingDir)) {
          return textResult(
            `existingDir '${params.existingDir}' not found. The caller must create the folder before calling dhee_create_project.`,
            true,
          );
        }
        try {
          if (!statSync(params.existingDir).isDirectory()) {
            return textResult(
              `existingDir '${params.existingDir}' is not a directory.`,
              true,
            );
          }
        } catch (e) {
          return textResult(
            `existingDir '${params.existingDir}' not accessible: ${e instanceof Error ? e.message : String(e)}.`,
            true,
          );
        }
        if (existsSync(join(params.existingDir, 'project.json'))) {
          return textResult(
            `project.json already exists at ${params.existingDir}. Refusing to overwrite.`,
            true,
          );
        }
        projectDir = params.existingDir;
      } else {
        projectDir = join(dirFn(), params.name);
        if (existsSync(projectDir)) {
          return textResult(
            `Project '${params.name}' already exists at ${projectDir}. Pick a different name or delete it first.`,
            true,
          );
        }
        mkdirSync(projectDir, { recursive: true });
      }

      const project = {
        name: params.name,
        bundleSource: `built-in:${params.bundleId}`,
        ...(params.description ? { description: params.description } : {}),
        createdAt: new Date().toISOString(),
      };
      writeFileSync(join(projectDir, 'project.json'), JSON.stringify(project, null, 2), 'utf8');
      return textResult(
        `Created project '${params.name}' at ${projectDir} (bundle: ${params.bundleId}).`,
      );
    },
  });
}

export const dheeCreateProjectTool = makeCreateProjectTool();
