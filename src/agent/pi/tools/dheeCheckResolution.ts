/**
 * dhee_check_resolution — audit a project's already-rendered image
 * artifacts against its target aspect+resolution and report which ones
 * are STALE (rendered at the wrong size).
 *
 * Why this exists (BUG-028): asked to take a project to 720p, the agent
 * re-ran only the video and left the images at their old size — they're
 * marked `completed`, which looks fine. But an image rendered before a
 * resolution/aspect change (or before the aspect-edge semantics fix,
 * when "720p" meant long-edge 720 → 720×408 instead of short-edge 720 →
 * 1280×720) no longer matches the target. The video must be conditioned
 * on correctly-sized frames, so the agent has to regenerate the stale
 * IMAGES (which cascades to the video), not just re-run the final stage.
 *
 * This tool gives the agent that signal: for each completed,
 * non-square image node it compares the artifact's real dimensions
 * (read straight from the PNG header) to applyAspect(aspect, baseline,
 * resolution) and lists the mismatches. Read-only.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { applyAspect } from '../../../dag/aspect.js';
import { isResolutionStale, readPngDims } from '../../../dag/resolutionStaleness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_BUNDLES_DIR = resolve(REPO_ROOT, 'src/dag/bundles');

export interface CheckResolutionDeps {
  bundlesDir?: () => string;
}

interface BundleManifest {
  nodes?: Array<{
    id: string;
    outputs?: { format?: string };
    runner?: { config?: { width?: unknown; height?: unknown } };
  }>;
}

interface WalkNode {
  status?: string;
  outputPath?: string;
}
interface ProjectJson {
  aspect?: string;
  resolution?: number;
  bundleSource?: string;
  walkState?: { nodes?: Record<string, WalkNode> };
}

interface StaleEntry {
  nodeKey: string;
  actual: string;
  expected: string;
}

function textResult(text: string, details: Record<string, unknown> = {}, isError = false) {
  return { content: [{ type: 'text' as const, text }], details, ...(isError ? { isError: true } : {}) };
}

function loadManifest(bundlesDir: string, bundleId: string): BundleManifest | null {
  const subdir = join(bundlesDir, bundleId);
  if (existsSync(subdir) && statSync(subdir).isDirectory()) {
    const p = join(subdir, 'bundle.json');
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as BundleManifest;
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

const fmt = (d: { width: number; height: number }): string => `${d.width}x${d.height}`;

export function makeCheckResolutionTool(deps: CheckResolutionDeps = {}) {
  const dirFn = deps.bundlesDir ?? (() => DEFAULT_BUNDLES_DIR);
  return defineTool({
    name: 'dhee_check_resolution',
    label: 'Check resolution',
    description:
      "Audit a project's already-rendered images against its target aspect+resolution. Returns which completed image artifacts are STALE — rendered at the wrong size (e.g. an old 720×408 image when the project is now 16:9 @720 → 1280×720). Call this BEFORE concluding a resolution/aspect request is done, or whenever the user says outputs look low-res/wrong-size. For any stale node, regenerate IT (dhee_regenerate_node / invalidate+run) so it re-renders at the target size and cascades to the video — do NOT just re-run the final video, which would bake in the wrong-sized frames. Read-only.",
    parameters: Type.Object({
      projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
    }),
    async execute(_id, params) {
      const projectJsonPath = join(params.projectDir, 'project.json');
      if (!existsSync(projectJsonPath)) {
        return textResult(`project.json not found at ${projectJsonPath}`, {}, true);
      }
      let project: ProjectJson;
      try {
        project = JSON.parse(readFileSync(projectJsonPath, 'utf8')) as ProjectJson;
      } catch (err) {
        return textResult(`project.json failed to parse: ${(err as Error).message}`, {}, true);
      }

      const aspect = project.aspect;
      const resolution = typeof project.resolution === 'number' ? project.resolution : undefined;
      const source = project.bundleSource ?? '';
      const bundleId = source.startsWith('built-in:') ? source.slice('built-in:'.length) : source;
      if (!bundleId) {
        return textResult('project.json has no bundleSource — cannot resolve node baselines.', {}, true);
      }
      const manifest = loadManifest(dirFn(), bundleId);
      if (!manifest) {
        return textResult(`Bundle '${bundleId}' not found in ${dirFn()}.`, {}, true);
      }

      // Baseline dims per resolution-dependent (non-square) image node.
      const baselines = new Map<string, { width: number; height: number }>();
      for (const n of manifest.nodes ?? []) {
        const w = n.runner?.config?.width;
        const h = n.runner?.config?.height;
        if (typeof w === 'number' && typeof h === 'number' && w !== h) {
          baselines.set(n.id, { width: w, height: h });
        }
      }

      const nodes = project.walkState?.nodes ?? {};
      const stale: StaleEntry[] = [];
      let checked = 0;
      let skippedUnreadable = 0;
      for (const [key, entry] of Object.entries(nodes)) {
        if (entry.status !== 'completed' || !entry.outputPath) continue;
        if (!entry.outputPath.toLowerCase().endsWith('.png')) continue;
        const baseId = key.split(':')[0]!;
        const baseline = baselines.get(baseId);
        if (!baseline) continue;
        const actual = readPngDims(resolve(params.projectDir, entry.outputPath));
        if (!actual) {
          skippedUnreadable += 1;
          continue;
        }
        checked += 1;
        const expected = applyAspect(aspect, baseline.width, baseline.height, resolution);
        if (isResolutionStale(expected, actual)) {
          stale.push({ nodeKey: key, actual: fmt(actual), expected: fmt(expected) });
        }
      }

      const target = `aspect=${aspect ?? '(unset)'} resolution=${resolution ?? '(unset)'}`;
      const details = { target: { aspect: aspect ?? null, resolution: resolution ?? null }, stale, checked };

      if (stale.length === 0) {
        return textResult(
          `Resolution check — ${target}\n` +
            `All ${checked} resolution-dependent image artifact(s) match the target size. Nothing to regenerate.` +
            (skippedUnreadable ? `\n(${skippedUnreadable} artifact(s) had unreadable dimensions and were skipped.)` : ''),
          details,
        );
      }

      const lines = stale.map((s) => `  - ${s.nodeKey}   actual ${s.actual}   expected ${s.expected}`);
      return textResult(
        `Resolution check — ${target}\n` +
          `${stale.length} image artifact(s) are STALE (rendered at the wrong size for this target):\n` +
          `${lines.join('\n')}\n\n` +
          `These were rendered under a different resolution/aspect (or before the size semantics changed). ` +
          `Regenerate the stale node(s) so they re-render at the expected size — this cascades to the video and final cut. ` +
          `Do NOT just re-run the final video; it must be conditioned on correctly-sized frames.`,
        details,
      );
    },
  });
}

export const dheeCheckResolutionTool = makeCheckResolutionTool();
