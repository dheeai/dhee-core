/**
 * bundleDigest — a compact, project-specific briefing appended to the
 * agent's system prompt when a project is focused (#147).
 *
 * The static SKILL.md teaches the generic engine + tools; this fills in
 * what the agent can only know per-project: which bundle is loaded, what
 * its nodes/capabilities are, which plan nodes are agentEditable (and the
 * shape + current count of their items), and the bundle's own agentGuide.
 * Without it the agent has to call dhee_describe_bundle and guess what's
 * editable; with it, bottom-up authoring is obvious from turn one.
 *
 * Pure projection over the bundle + on-disk plan files. Best-effort:
 * any failure yields '' so the system prompt is never broken.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseBundleSource, resolveBundleDir } from '../../dag/bundleSource.js';
import { loadBundle } from '../../dag/walker.js';
import { titleizeBundleId } from '../../dag/bundleDisplay.js';
import { extractPlanItems } from '../../dag/planItemDiff.js';
import type { DagBundle, NodeDef } from '../../dag/schema.js';

/** Required-field names from a JSON-schema-ish itemSchema (best-effort). */
function requiredFields(itemSchema: Record<string, unknown> | undefined): string[] {
  const req = itemSchema?.['required'];
  return Array.isArray(req) ? req.filter((r): r is string => typeof r === 'string') : [];
}

function fanOutKeyFor(bundle: DagBundle, node: NodeDef): string | undefined {
  if (node.itemKey) return node.itemKey;
  return (bundle.nodes).find((n) => n.itemSource === node.id && n.itemKey)?.itemKey;
}

/**
 * Build the digest markdown for a focused project, or '' when the
 * project/bundle can't be resolved.
 */
export function buildBundleDigest(projectDir: string): string {
  try {
    const pjPath = join(projectDir, 'project.json');
    if (!existsSync(pjPath)) return '';
    const pj = JSON.parse(readFileSync(pjPath, 'utf8')) as { bundleSource?: string };
    if (typeof pj.bundleSource !== 'string') return '';
    const dirOrFile = resolveBundleDir(parseBundleSource(pj.bundleSource));
    const manifest = statSync(dirOrFile).isDirectory() ? join(dirOrFile, 'bundle.json') : dirOrFile;
    const bundle = loadBundle(manifest);
    const nodes = bundle.nodes;

    const title = bundle.displayName ?? titleizeBundleId(bundle.id);
    const lines: string[] = [`# Current project: ${title} (bundle: ${bundle.id})`];

    const editable = nodes.filter((n) => n.agentEditable);
    if (editable.length > 0) {
      lines.push('', 'Agent-editable plan nodes (build bottom-up with dhee_add_item / dhee_remove_item):');
      for (const n of editable) {
        const key = fanOutKeyFor(bundle, n);
        // Count current items from the on-disk plan file (best-effort).
        let count = 0;
        try {
          const abs = join(projectDir, n.outputs.pattern);
          if (existsSync(abs)) count = extractPlanItems(JSON.parse(readFileSync(abs, 'utf8')), key).length;
        } catch {
          /* leave count 0 */
        }
        const fields = requiredFields(n.itemSchema);
        const fieldStr = fields.length ? ` — item fields: ${fields.join(', ')}` : '';
        lines.push(`  - ${n.id}${key ? ` (items under '${key}')` : ''}: ${count} item(s)${fieldStr}`);
      }
    }

    if (typeof bundle.agentGuide === 'string' && bundle.agentGuide.trim()) {
      lines.push('', '## Bundle guidance', bundle.agentGuide.trim());
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}
