/**
 * dhee_list_bundles — return the built-in bundle catalog so pi-agent
 * can pick one during onboarding without the desktop pre-composing a
 * choice. Each entry has { id, version, description } — the agent
 * reads `description` and decides which bundle fits the story.
 *
 * The tool does no inference itself. It is a pure read of bundle.json
 * files; the agent does the matching.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// REPO_ROOT = .../kshana-core (this file is src/agent/pi/tools/dheeListBundles.ts)
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_BUNDLES_DIR = resolve(REPO_ROOT, 'src/dag/bundles');

export interface ListBundlesDeps {
  /** Override the bundles directory; useful for tests. */
  bundlesDir?: () => string;
}

export interface BundleEntry {
  id: string;
  version: string;
  description: string;
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} };
}

function readBundleJson(path: string): BundleEntry | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BundleEntry>;
    if (typeof parsed.id !== 'string' || parsed.id.length === 0) return null;
    if (typeof parsed.version !== 'string' || parsed.version.length === 0) return null;
    return {
      id: parsed.id,
      version: parsed.version,
      description: typeof parsed.description === 'string' ? parsed.description : '',
    };
  } catch {
    return null;
  }
}

export function makeListBundlesTool(deps: ListBundlesDeps = {}) {
  const dirFn = deps.bundlesDir ?? (() => DEFAULT_BUNDLES_DIR);
  return defineTool({
    name: 'dhee_list_bundles',
    label: 'List bundles',
    description:
      'List every built-in bundle (pipeline) shipped with kshana. Each entry has { id, version, description }. Use this BEFORE picking a bundleId for dhee_create_project — read the descriptions and pick the one whose strengths match the user\'s story (e.g. action/motion → relay, dialogue/precise composition → shot-by-shot).',
    parameters: Type.Object({}),
    async execute() {
      const root = dirFn();
      if (!existsSync(root)) return textResult('[]');
      const entries: BundleEntry[] = [];
      let names: string[];
      try {
        names = readdirSync(root);
      } catch {
        return textResult('[]');
      }
      for (const name of names) {
        const full = join(root, name);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          const manifestPath = join(full, 'bundle.json');
          if (!existsSync(manifestPath)) continue;
          const entry = readBundleJson(manifestPath);
          if (entry) entries.push(entry);
        } else if (st.isFile() && name.endsWith('.json')) {
          const entry = readBundleJson(full);
          if (entry) entries.push(entry);
        }
      }
      entries.sort((a, b) => a.id.localeCompare(b.id));
      return textResult(JSON.stringify(entries));
    },
  });
}

export const dheeListBundlesTool = makeListBundlesTool();
