import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { localFileSchema, readReference } from './productionIntake.js';
import { loadBundle } from '../dag/walker.js';
import { parseBundleSource, resolveBundleDir } from '../dag/bundleSource.js';
import { acquireWalkLock, isWalkLockResult } from '../dag/projectWalkLock.js';
import { writeNodeContentUnderLock } from '../dag/writeNodeContent.js';
import { projectWalkState } from '../dag/eventLog/projectWalkState.js';
import type { NodeCompletedPayload, NodeDependency } from '../dag/eventLog/events.js';
import { openEventLog } from '../dag/eventLog/EventLog.js';
import { productionReviewsRequired } from '../dag/productionReviewGates.js';

const fields = {
  projectDir: z.string().refine(isAbsolute),
  inputId: z.string().min(1),
  payload: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), content: z.string().max(500000) }).strict(),
    localFileSchema,
  ]),
};
export const inputPreviewSchema = z
  .object({ action: z.literal('input.preview'), ...fields })
  .strict();
export const inputWriteSchema = z
  .object({
    action: z.literal('input.write'),
    ...fields,
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    humanAcknowledged: z.literal(true),
    reason: z.string().max(10000).optional(),
  })
  .strict();

export function safePath(root: string, name: string): string {
  const full = resolve(root, name),
    rel = relative(root, full);
  if (isAbsolute(name) || !rel || rel.startsWith('..') || isAbsolute(rel))
    throw new Error('Input update encountered a path outside the project.');
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink())
        throw new Error('Input update refuses symlink paths.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return full;
}
export function fileHash(file: string): string | null {
  if (!existsSync(file)) return null;
  if (!statSync(file).isFile()) throw new Error('Expected a regular artifact file.');
  const fd = openSync(file, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(65536);
  let bytes = 0;
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      if (bytes > 256 * 1024 * 1024)
        throw new Error('Input-update preview supports artifacts up to 256 MiB.');
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}
export function updateProductionInput(
  req: z.infer<typeof inputPreviewSchema> | z.infer<typeof inputWriteSchema>
) {
  const projectDir = realpathSync(req.projectDir);
  safePath(projectDir, 'project.json');
  safePath(projectDir, '.dhee/events.jsonl');
  const lock = acquireWalkLock(projectDir);
  if (isWalkLockResult(lock)) throw new Error('A project operation is already in progress.');
  try {
    if (!productionReviewsRequired(projectDir))
      throw new Error('Enable creative review gates before changing production inputs.');
    const projectBytes = readFileSync(join(projectDir, 'project.json'), 'utf8');
    const project = JSON.parse(projectBytes) as {
      bundleSource: string;
      walkState?: { nodes?: Record<string, { outputPath?: string; status?: string }> };
    };
    const location = resolveBundleDir(parseBundleSource(project.bundleSource));
    const manifest = statSync(location).isDirectory() ? join(location, 'bundle.json') : location;
    const bundle = loadBundle(manifest);
    const decl = bundle.inputs?.find(d => d.id === req.inputId);
    if (!decl || decl.kind !== 'file') throw new Error('Input must be a declared file input.');
    if (!/^(inputs|plans)[/\\]/.test(decl.path) || decl.path.includes('{{'))
      throw new Error('Input updates require a concrete inputs/ or plans/ path.');
    const matches = bundle.nodes.filter(n => n.kind === 'stage' && n.outputs.pattern === decl.path);
    if (matches.length !== 1)
      throw new Error(
        'This update supports only file inputs mapped to exactly one stage output; other inputs need a dedicated dependency contract.'
      );
    const node = matches[0]!;
    const events = [...openEventLog(projectDir).read()];
    if (events.some(e => e.branchId !== 'main' || e.kind === 'branch.created'))
      throw new Error('Input updates currently require a project without branches.');
    const state = projectWalkState(events, { branchId: 'main' });
    const completions = new Map<string, NodeCompletedPayload>();
    for (const event of events)
      if (event.kind === 'node.completed') {
        const p = event.payload as NodeCompletedPayload;
        if (p.itemId === undefined) completions.set(`${p.nodeId}@${p.versionId}`, p);
      }
    const bindings: { nodeId: string; versionId: string; path: string; sha256: string }[] = [];
    const visiting = new Set<string>([node.id]);
    const checked = new Set<string>();
    const validateUpstream = (id: string) => {
      if (visiting.has(id)) throw new Error('Input dependency lineage contains a cycle.');
      if (checked.has(id)) return;
      const upstream = bundle.nodes.find(n => n.id === id);
      const selected = state.nodes[id];
      const completion = completions.get(`${id}@${selected?.selectedVersionId}`);
      if (
        upstream?.kind !== 'stage' ||
        selected?.status !== 'completed' ||
        !selected.selectedVersionId ||
        !selected.outputPath ||
        !completion
      )
        throw new Error(
          `Input dependency lineage is unavailable for ${id}. Complete its upstream stage first.`
        );
      visiting.add(id);
      const expected = upstream.inputs ?? [];
      if (
        expected.some(
          i => !completion.dependencies?.some(d => d.nodeId === i.from && d.itemId === undefined)
        )
      )
        throw new Error(`Input dependency lineage is incomplete for ${id}.`);
      for (const dep of completion.dependencies ?? []) {
        if (dep.itemId !== undefined)
          throw new Error('Collection dependency lineage is not supported for input replacement.');
        validateUpstream(dep.nodeId);
      }
      const sha256 = fileHash(safePath(projectDir, selected.outputPath));
      if (!sha256) throw new Error(`Upstream artifact is missing for ${id}.`);
      bindings.push({
        nodeId: id,
        versionId: selected.selectedVersionId,
        path: selected.outputPath,
        sha256,
      });
      visiting.delete(id);
      checked.add(id);
    };
    const dependencies: NodeDependency[] = (node.inputs ?? []).map(i => ({
      nodeId: i.from,
      role: i.usage,
    }));
    for (const dependency of dependencies) validateUpstream(dependency.nodeId);
    const content =
      req.payload.kind === 'text'
        ? Buffer.from(req.payload.content, 'utf8')
        : readReference(req.payload);
    const incomingSha256 = createHash('sha256').update(content).digest('hex');
    const preview = writeNodeContentUnderLock({
      projectDir,
      nodeId: node.id,
      content,
      previewOnly: true,
      loadBundleForProject: () => bundle,
    });
    if (!preview.ok) throw new Error(preview.error);
    if (preview.status !== 'preview') throw new Error('Expected a non-mutating preview.');
    // Mixed legacy/recorded history can give the shared writer only a partial cascade.
    // Refuse that state instead of leaving a completed consumer silently current.
    const reachable = new Set<string>([node.id]);
    let added = true;
    while (added) {
      added = false;
      for (const candidate of bundle.nodes)
        if (
          !reachable.has(candidate.id) &&
          ((candidate.inputs ?? []).some(i => reachable.has(i.from)) ||
            (candidate.kind === 'collection' &&
              candidate.itemSource !== undefined &&
              reachable.has(candidate.itemSource)))
        ) {
          reachable.add(candidate.id);
          added = true;
        }
    }
    for (const id of reachable) {
      if (id === node.id) continue;
      const descendant = bundle.nodes.find(n => n.id === id)!;
      if (descendant.kind !== 'stage')
        throw new Error('Input replacement does not yet support downstream collections.');
      if (
        (state.nodes[id]?.status === 'completed' ||
          project.walkState?.nodes?.[id]?.status === 'completed') &&
        !preview.downstream.some(d => d.nodeId === id && d.itemId === undefined)
      )
        throw new Error(
          `Downstream dependency lineage is incomplete for ${id}; replacement would leave a stale artifact current.`
        );
    }
    const paths = new Set<string>([decl.path]);
    // The shared writer also consults legacy canonical paths; bind them as well as event history.
    for (const entry of Object.values(project.walkState?.nodes ?? {}))
      if (entry?.outputPath) paths.add(entry.outputPath);
    for (const event of events) {
      const payload = event.payload as { outputPath?: unknown };
      if (typeof payload.outputPath === 'string') paths.add(payload.outputPath);
    }
    if (paths.size > 1024)
      throw new Error('Project exceeds the bounded input-preview artifact limit.');
    const artifacts = [...paths].sort().map(p => {
      const normalized = relative(projectDir, resolve(projectDir, p));
      if (
        normalized === 'project.json' ||
        normalized.startsWith('.dhee' + sep) ||
        normalized.startsWith('.git' + sep)
      )
        throw new Error('Artifact paths must not address project metadata.');
      return { path: p, sha256: fileHash(safePath(projectDir, p)) };
    });
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          projectDir,
          inputId: req.inputId,
          nodeId: node.id,
          projectBytes,
          manifest: readFileSync(manifest, 'utf8'),
          events,
          artifacts,
          incomingSha256,
          bindings,
          downstream: preview.downstream,
        })
      )
      .digest('hex');
    const detail = {
      inputId: req.inputId,
      nodeId: node.id,
      path: decl.path,
      incomingSha256,
      bindings,
      bytes: content.length,
      downstream: preview.downstream,
      fingerprint,
      scope: 'main branch; no rendering or creative approval',
    };
    if (req.action === 'input.preview') return detail;
    if (fingerprint !== req.expectedFingerprint)
      throw new Error(
        'Input, project or affected artifacts changed. Read a fresh preview before applying.'
      );
    const result = writeNodeContentUnderLock({
      projectDir,
      nodeId: node.id,
      content,
      confirm: true,
      reason: req.reason,
      dependencies,
      loadBundleForProject: () => bundle,
    });
    if (!result.ok) throw new Error(result.error);
    return { ...detail, ...result, reviewsRequired: true, started: false };
  } finally {
    lock.release();
  }
}
