import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { openEventLog } from '../dag/eventLog/EventLog.js';
import { projectWalkState } from '../dag/eventLog/projectWalkState.js';
import { branchVisibilityFilter } from '../dag/eventLog/branchFilter.js';
import type { NodeCompletedPayload } from '../dag/eventLog/events.js';
import { loadBundle } from '../dag/walker.js';
import { parseBundleSource, resolveBundleDir } from '../dag/bundleSource.js';
import { readReference } from './productionIntake.js';
import { safePath, fileHash, updateProductionInput } from './productionInputUpdate.js';

const target = {
  projectDir: z.string().refine(isAbsolute),
  nodeId: z.string().min(1),
  itemId: z.string().min(1).optional(),
  branchId: z.string().min(1).default('main'),
};
export const versionListSchema = z
  .object({ action: z.literal('version.list'), ...target })
  .strict();
export const artifactReadSchema = z
  .object({
    action: z.literal('artifact.read'),
    ...target,
    versionId: z.string().min(1).optional(),
  })
  .strict();
const restoreTarget = {
  projectDir: target.projectDir,
  nodeId: target.nodeId,
  versionId: z.string().min(1),
};
export const versionRestorePreviewSchema = z
  .object({ action: z.literal('version.restorePreview'), ...restoreTarget })
  .strict();
export const versionRestoreSchema = z
  .object({
    action: z.literal('version.restore'),
    ...restoreTarget,
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    humanAcknowledged: z.literal(true),
    reason: z.string().max(10000).optional(),
  })
  .strict();
interface Candidate {
  versionId: string;
  path: string;
  kind: 'completed' | 'preserved';
  selected: boolean;
  available: boolean;
  reason?: string;
  sha256?: string;
  bytes?: number;
  absolutePath?: string;
  createdAt: number;
  sequence: number;
}
function artifactPath(projectDir: string, path: string) {
  const full = safePath(projectDir, path);
  const rel = relative(projectDir, full);
  if (
    rel === 'project.json' ||
    rel === '.dhee' ||
    rel.startsWith('.dhee' + sep) ||
    rel === '.git' ||
    rel.startsWith('.git' + sep)
  )
    throw Error('Artifact paths must not address project metadata.');
  return full;
}
export function listProductionVersions(req: z.infer<typeof versionListSchema>) {
  safePath(req.projectDir, '.dhee/events.jsonl');
  const events = [...openEventLog(req.projectDir).read()];
  const visible = branchVisibilityFilter(events, req.branchId);
  const state = projectWalkState(events, { branchId: req.branchId });
  const key = req.itemId === undefined ? req.nodeId : `${req.nodeId}:${req.itemId}`;
  const candidates: Candidate[] = [];
  for (const event of events.filter(visible)) {
    if (event.kind !== 'node.completed' && event.kind !== 'version.added') continue;
    const p = event.payload as NodeCompletedPayload;
    if (p.nodeId !== req.nodeId || p.itemId !== req.itemId) continue;
    candidates.push({
      versionId: p.versionId,
      path: p.outputPath,
      kind: event.kind === 'node.completed' ? 'completed' : 'preserved',
      createdAt: event.ts,
      sequence: event.seq,
      selected: state.nodes[key]?.selectedVersionId === p.versionId,
      available: false,
    });
  }
  if (candidates.length > 1024)
    throw Error('Version inspection supports at most 1024 candidates per target.');
  for (const c of candidates) {
    // A later completion at the same path replaced the bytes. Never label them as the old version.
    if (
      events.some(event => {
        if (
          event.seq <= c.sequence ||
          (event.kind !== 'node.completed' && event.kind !== 'version.added')
        )
          return false;
        const path = (event.payload as NodeCompletedPayload).outputPath;
        return resolve(req.projectDir, path) === resolve(req.projectDir, c.path);
      })
    ) {
      c.reason = 'Path reused by a later version; inspect a preserved-file entry instead.';
      continue;
    }
    if (candidates.filter(other => other.versionId === c.versionId).length !== 1) {
      c.reason = 'Ambiguous duplicate version ID.';
      continue;
    }
    try {
      const full = artifactPath(req.projectDir, c.path);
      const sha256 = fileHash(full);
      if (!sha256) {
        c.reason = 'Artifact file is missing.';
        continue;
      }
      c.absolutePath = full;
      c.sha256 = sha256;
      c.bytes = statSync(full).size;
      c.available = true;
    } catch (error) {
      c.reason = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    nodeId: req.nodeId,
    itemId: req.itemId,
    branchId: req.branchId,
    status: state.nodes[key]?.status ?? 'incomplete',
    versions: candidates,
  };
}
function candidateFor(req: z.infer<typeof artifactReadSchema>) {
  const listing = listProductionVersions({ ...req, action: 'version.list' });
  const matches = listing.versions.filter(v =>
    req.versionId === undefined ? v.selected : v.versionId === req.versionId
  );
  if (matches.length !== 1)
    throw Error('No unambiguous selected/version artifact exists for this target.');
  const candidate = matches[0]!;
  if (!candidate.available) throw Error(candidate.reason ?? 'Artifact is unavailable.');
  return candidate;
}
export function readProductionArtifact(
  req: z.infer<typeof artifactReadSchema>,
  purpose: 'preview' | 'assembly-verification' = 'preview'
) {
  // Internal audit reads keep the same selected-version, confined-path and hash checks.
  // Public artifact.read remains a 64-KiB preview; it cannot set this purpose.
  const maxInlineBytes = purpose === 'assembly-verification' ? 8 * 1024 * 1024 : 65536;
  const candidate = candidateFor(req);
  const isText = ['.md', '.json', '.txt', '.srt', '.vtt', '.csv'].includes(
    extname(candidate.path).toLowerCase()
  );
  return {
    ...candidate,
    ...(isText && candidate.bytes! <= maxInlineBytes
      ? {
          text: readReference({
            kind: 'localFile',
            sourcePath: candidate.absolutePath!,
            expectedSha256: candidate.sha256!,
          }).toString('utf8'),
        }
      : { inline: false }),
    note: 'File inspection is not a creative approval or historical content-integrity certification.',
  };
}
export function restoreProductionVersion(
  req: z.infer<typeof versionRestorePreviewSchema> | z.infer<typeof versionRestoreSchema>
) {
  const candidate = candidateFor({ ...req, action: 'artifact.read', branchId: 'main' });
  const pj = JSON.parse(readFileSync(safePath(req.projectDir, 'project.json'), 'utf8')) as {
    bundleSource: string;
  };
  const location = resolveBundleDir(parseBundleSource(pj.bundleSource));
  const bundle = loadBundle(
    statSync(location).isDirectory() ? join(location, 'bundle.json') : location
  );
  const node = bundle.nodes.find(n => n.id === req.nodeId && n.kind === 'stage');
  if (!node) throw Error('Restore currently supports declared stage inputs only.');
  const declarations = (bundle.inputs ?? []).filter(
    d => d.kind === 'file' && d.path === node.outputs.pattern
  );
  if (declarations.length !== 1)
    throw Error('Restore requires exactly one declared file input for this stage.');
  const input = {
    projectDir: req.projectDir,
    inputId: declarations[0]!.id,
    payload: {
      kind: 'localFile' as const,
      sourcePath: candidate.absolutePath!,
      expectedSha256: candidate.sha256!,
    },
  };
  const preview = updateProductionInput({ ...input, action: 'input.preview' });
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ nodeId: req.nodeId, versionId: req.versionId, candidate, preview }))
    .digest('hex');
  const detail = {
    candidate,
    downstream: preview.downstream,
    bindings: preview.bindings,
    fingerprint,
    mode: 'restore as a new current version; no generation or creative approval',
  };
  if (req.action === 'version.restorePreview') return detail;
  if (req.expectedFingerprint !== fingerprint)
    throw Error('Version or project changed. Read a fresh restore preview.');
  const result = updateProductionInput({
    ...input,
    action: 'input.write',
    expectedFingerprint: preview.fingerprint,
    humanAcknowledged: true,
    reason: `Restore candidate ${req.versionId}${req.reason ? `: ${req.reason}` : ''}`,
  });
  return { ...result, ...detail };
}
