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
import { join } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { getBundleSearchRoots } from '../../../dag/bundleSource.js';
import { titleizeBundleId, summaryOf } from '../../../dag/bundleDisplay.js';
import {
  bundleRuntimeSupport,
  type BundleRuntimeSupport,
} from '../../../dag/bundleRuntimeSupport.js';
import type { DagBundle } from '../../../dag/schema.js';

export interface ListBundlesDeps {
  /**
   * Override the bundles directory(s); useful for tests. Returns one
   * or more roots; each root is scanned in order, and a bundle id
   * seen first wins (matches resolveBundleDir precedence — USER fork
   * shadows APP shipped default).
   */
  bundlesDir?: () => string | string[];
}

export interface BundleEntry {
  id: string;
  version: string;
  description: string;
  /** Human-readable label for the picker (always non-empty; derived from id if bundle.json omits). */
  displayName: string;
  /** Short tagline for the picker card (≤120 chars; derived from description if bundle.json omits). */
  summary: string;
  runtimeSupport: BundleRuntimeSupport;
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} };
}

interface BundleJsonShape {
  id?: string;
  version?: string;
  description?: string;
  displayName?: string;
  summary?: string;
  runtimeSupport?: unknown;
  nodes?: DagBundle['nodes'];
}

function readBundleJson(path: string): BundleEntry | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as BundleJsonShape;
    if (typeof parsed.id !== 'string' || parsed.id.length === 0) return null;
    if (typeof parsed.version !== 'string' || parsed.version.length === 0) return null;
    const description = typeof parsed.description === 'string' ? parsed.description : '';
    const displayName =
      typeof parsed.displayName === 'string' && parsed.displayName.trim().length > 0
        ? parsed.displayName.trim()
        : titleizeBundleId(parsed.id);
    const summary = summaryOf({
      ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
      ...(description ? { description } : {}),
    });
    return {
      id: parsed.id,
      version: parsed.version,
      description,
      displayName,
      summary,
      runtimeSupport: bundleRuntimeSupport(parsed),
    };
  } catch {
    return null;
  }
}

export function makeListBundlesTool(deps: ListBundlesDeps = {}) {
  const dirFn = deps.bundlesDir ?? (() => getBundleSearchRoots());
  return defineTool({
    name: 'dhee_list_bundles',
    label: 'List bundles',
    description:
      'List every available bundle (pipeline) — first-party defaults shipped with the app PLUS any forks / community bundles the user has dropped into their bundles dir. Each entry has { id, version, description }. Use this BEFORE picking a bundleId for dhee_create_project — read the descriptions and pick the one whose strengths match the user\'s story (e.g. action/motion → relay, dialogue/precise composition → shot-by-shot).',
    parameters: Type.Object({}),
    async execute() {
      const dirResult = dirFn();
      const roots = Array.isArray(dirResult) ? dirResult : [dirResult];
      const entries: BundleEntry[] = [];
      const seen = new Set<string>();
      for (const root of roots) {
        if (!root || !existsSync(root)) continue;
        let names: string[];
        try {
          names = readdirSync(root);
        } catch {
          continue;
        }
        for (const name of names) {
          const full = join(root, name);
          let st: ReturnType<typeof statSync>;
          try {
            st = statSync(full);
          } catch {
            continue;
          }
          let entry: BundleEntry | null = null;
          if (st.isDirectory()) {
            const manifestPath = join(full, 'bundle.json');
            if (!existsSync(manifestPath)) continue;
            entry = readBundleJson(manifestPath);
          } else if (st.isFile() && name.endsWith('.json')) {
            entry = readBundleJson(full);
          }
          if (!entry) continue;
          // First root wins — matches resolveBundleDir precedence so
          // a user's fork shadows the shipped default in the listing.
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
          entries.push(entry);
        }
      }
      entries.sort((a, b) => a.id.localeCompare(b.id));
      return textResult(JSON.stringify(entries));
    },
  });
}

export const dheeListBundlesTool = makeListBundlesTool();
