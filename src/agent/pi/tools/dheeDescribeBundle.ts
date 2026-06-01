/**
 * dhee_describe_bundle — return one bundle's shape (inputs, goal,
 * nodes) so the agent doesn't have to read bundle.json via the
 * built-in `read` tool to learn input ids and DAG topology.
 *
 * Companion to `dhee_list_bundles`: list to choose, describe to
 * understand.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_BUNDLES_DIR = resolve(REPO_ROOT, 'src/dag/bundles');

export interface DescribeBundleDeps {
  bundlesDir?: () => string;
}

interface BundleManifest {
  id: string;
  version?: string;
  description?: string;
  goal?: string;
  inputs?: Array<Record<string, unknown>>;
  nodes?: Array<{
    id: string;
    inputs?: Array<{ from?: string }>;
    outputs?: { format?: string; pattern?: string };
    runner?: { tool?: string };
  }>;
}

interface DescribeResult {
  id: string;
  version: string;
  description: string;
  goal: string;
  inputs: Array<Record<string, unknown>>;
  nodes: Array<{
    id: string;
    runner: string;
    format: string;
    outputPattern: string;
    upstream: string[];
  }>;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

function readManifestFromBundlesDir(bundlesDir: string, bundleId: string): BundleManifest | null {
  const subdir = join(bundlesDir, bundleId);
  if (existsSync(subdir) && statSync(subdir).isDirectory()) {
    const manifestPath = join(subdir, 'bundle.json');
    if (existsSync(manifestPath)) {
      try {
        return JSON.parse(readFileSync(manifestPath, 'utf8')) as BundleManifest;
      } catch {
        return null;
      }
    }
  }
  const flat = join(bundlesDir, `${bundleId}.json`);
  if (existsSync(flat)) {
    try {
      return JSON.parse(readFileSync(flat, 'utf8')) as BundleManifest;
    } catch {
      return null;
    }
  }
  return null;
}

export function makeDescribeBundleTool(deps: DescribeBundleDeps = {}) {
  const dirFn = deps.bundlesDir ?? (() => DEFAULT_BUNDLES_DIR);
  return defineTool({
    name: 'dhee_describe_bundle',
    label: 'Describe bundle',
    description:
      'Inspect ONE built-in bundle in detail. Returns { id, version, description, goal, inputs, nodes }. Use AFTER the user picks a bundle (from dhee_list_bundles) to learn which input ids to write via dhee_write_input and what the DAG looks like. The `nodes[].upstream` list shows where each node\'s inputs come from.',
    parameters: Type.Object({
      bundleId: Type.String({
        description:
          "Bundle id (e.g. 'narrative_prompt_relay'). The 'built-in:' prefix is accepted and stripped.",
      }),
    }),
    async execute(_id, params) {
      const root = dirFn();
      let bundleId = params.bundleId;
      if (bundleId.startsWith('built-in:')) bundleId = bundleId.slice('built-in:'.length);

      const manifest = readManifestFromBundlesDir(root, bundleId);
      if (!manifest) {
        return textResult(
          `Bundle '${bundleId}' not found in ${root}. Call dhee_list_bundles to see what's available.`,
          true,
        );
      }

      const result: DescribeResult = {
        id: manifest.id ?? bundleId,
        version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
        description: typeof manifest.description === 'string' ? manifest.description : '',
        goal: typeof manifest.goal === 'string' ? manifest.goal : '',
        inputs: Array.isArray(manifest.inputs) ? manifest.inputs : [],
        nodes: (manifest.nodes ?? []).map((n) => ({
          id: n.id,
          runner: n.runner?.tool ?? '',
          format: n.outputs?.format ?? '',
          outputPattern: n.outputs?.pattern ?? '',
          upstream: (n.inputs ?? [])
            .map((i) => (typeof i.from === 'string' ? i.from : ''))
            .filter((s) => s.length > 0),
        })),
      };

      return textResult(JSON.stringify(result));
    },
  });
}

export const dheeDescribeBundleTool = makeDescribeBundleTool();
