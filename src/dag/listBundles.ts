/**
 * listBundles — pure read of every available bundle's metadata, callable
 * from the desktop main process via IPC (the Production Slate screen
 * renders bundle cards from this).
 *
 * Scans the bundle search root chain (DHEE_USER_BUNDLES_DIR →
 * DHEE_APP_BUNDLES_DIR → ~/.kshana/bundles → repo src/dag/bundles) and
 * returns one entry per bundle id (first-seen-wins so user forks
 * shadow shipped defaults).
 *
 * Returns the SLICE of each bundle's manifest that the Production
 * Slate cares about: id, displayName, summary, techLine, description,
 * inputs[]. NOT the full DAG — that's loaded later by the walker.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getBundleSearchRoots } from './bundleSource.js';
import { findNpmBundles } from './ecosystem.js';
import {
  bundleRuntimeSupport,
  type BundleRuntimeSupport,
} from './bundleRuntimeSupport.js';
import type { BundleInputDecl, DagBundle } from './schema.js';

export interface BundleSummary {
  id: string;
  version: string;
  displayName: string;
  summary: string;
  techLine?: string;
  description?: string;
  inputs?: BundleInputDecl[];
  runtimeSupport: BundleRuntimeSupport;
  /**
   * True iff the bundle.json explicitly declared BOTH displayName AND
   * summary (i.e. the author opted-in to user-facing presentation).
   * False when either field was auto-derived. The desktop's Production
   * Slate filters by this flag to keep dev/test bundles out of the
   * picker.
   */
  pickerEligible: boolean;
}

export function listBundles(): BundleSummary[] {
  const roots = getBundleSearchRoots();
  const out: BundleSummary[] = [];
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
      let manifestPath: string | null = null;
      if (st.isDirectory()) {
        const candidate = join(full, 'bundle.json');
        if (existsSync(candidate)) manifestPath = candidate;
      } else if (st.isFile() && name.endsWith('.json')) {
        manifestPath = full;
      }
      if (!manifestPath) continue;
      const summary = readBundleSummary(manifestPath);
      if (!summary) continue;
      if (seen.has(summary.id)) continue;
      seen.add(summary.id);
      out.push(summary);
    }
  }
  // npm bundle packages (dhee-bundle-*) — lower precedence than the dir
  // roots above, so a user fork / built-in with the same id still wins.
  for (const b of findNpmBundles()) {
    if (seen.has(b.id)) continue;
    const summary = readBundleSummary(join(b.dir, 'bundle.json'));
    if (!summary || seen.has(summary.id)) continue;
    seen.add(summary.id);
    out.push(summary);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function readBundleSummary(manifestPath: string): BundleSummary | null {
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DagBundle>;
    if (typeof parsed.id !== 'string' || !parsed.id) return null;
    if (typeof parsed.version !== 'string' || !parsed.version) return null;
    const declaredDisplayName =
      typeof parsed.displayName === 'string' && parsed.displayName.trim()
        ? parsed.displayName.trim()
        : null;
    const declaredSummary =
      typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : null;
    const description =
      typeof parsed.description === 'string' ? parsed.description : undefined;
    const displayName = declaredDisplayName ?? titleize(parsed.id);
    const summary = declaredSummary ?? firstSentence(description ?? '');
    return {
      id: parsed.id,
      version: parsed.version,
      displayName,
      summary,
      runtimeSupport: bundleRuntimeSupport(parsed),
      pickerEligible: declaredDisplayName !== null && declaredSummary !== null,
      ...(parsed.techLine ? { techLine: parsed.techLine } : {}),
      ...(description ? { description } : {}),
      ...(parsed.inputs ? { inputs: parsed.inputs } : {}),
    };
  } catch {
    return null;
  }
}

function titleize(id: string): string {
  // Preserve known acronyms in the title cased form.
  const ACRONYMS = new Set(['ltx', 'zit', 'vlm', 'nbp', 'nb2', 'nb3', 'fl2v']);
  return id
    .split('_')
    .map((word) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const dotIdx = trimmed.indexOf('.');
  const first = dotIdx === -1 ? trimmed : trimmed.slice(0, dotIdx + 1);
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}
