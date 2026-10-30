/** Version-bound human decisions. This records artifact reviews, not execution policy. */
import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  realpathSync,
  statSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, extname } from 'node:path';
import { openEventLog } from './eventLog/EventLog.js';
import { projectWalkState } from './eventLog/projectWalkState.js';
import { branchVisibilityFilter } from './eventLog/branchFilter.js';
import type { DheeEvent, NodeCompletedPayload, ReviewDecidedPayload } from './eventLog/events.js';
import { acquireWalkLock, isWalkLockResult } from './projectWalkLock.js';

export interface ReviewTarget {
  nodeId: string;
  itemId?: string;
}
export interface ReviewScope {
  projectDir: string;
  branchId?: string;
  gate: string;
  targets: ReviewTarget[];
}
export interface ReviewPreview {
  key: string;
  versionId: string;
  previewPath: string;
  format: 'text' | 'md' | 'json' | 'image' | 'video' | 'audio';
}
export interface ProductionReview {
  previews?: ReviewPreview[];
  status: 'approved' | 'changes-requested' | 'unreviewed' | 'stale' | 'unavailable';
  fingerprint?: string;
  reason?: string;
  decidedAt?: number;
  notes?: string;
}
export interface RecordProductionReviewInput extends ReviewScope {
  expectedFingerprint: string;
  decision: 'approved' | 'changes-requested';
  notes?: string;
}
const keyOf = (target: ReviewTarget) =>
  target.itemId === undefined ? target.nodeId : `${target.nodeId}:${target.itemId}`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function normalize(scope: ReviewScope): ReviewScope {
  if (!['storyboard', 'references', 'rough-cut'].includes(scope.gate))
    throw new Error('Unknown review gate.');
  if (!Array.isArray(scope.targets) || scope.targets.length === 0 || scope.targets.length > 10000)
    throw new Error('Review targets must be a nonempty list (maximum 10000).');
  for (const t of scope.targets) {
    if (
      !t ||
      typeof t.nodeId !== 'string' ||
      !/^[\w.-]+$/.test(t.nodeId) ||
      (t.itemId !== undefined && (typeof t.itemId !== 'string' || !/^[\w.-]+$/.test(t.itemId)))
    )
      throw new Error('Invalid review target.');
  }
  if (scope.branchId !== undefined && (typeof scope.branchId !== 'string' || !scope.branchId))
    throw new Error('Invalid branch.');
  const projectDir = realpathSync(scope.projectDir);
  if (!statSync(join(projectDir, 'project.json')).isFile())
    throw new Error('Project is unavailable.');
  const targets = [
    ...new Map(
      scope.targets.map(t => [
        keyOf(t),
        { nodeId: t.nodeId, ...(t.itemId === undefined ? {} : { itemId: t.itemId }) },
      ])
    ).values(),
  ].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  return { projectDir, branchId: scope.branchId ?? 'main', gate: scope.gate, targets };
}

async function fileHash(projectDir: string, outputPath: string): Promise<string> {
  if (isAbsolute(outputPath)) throw new Error('Artifact path must be project-relative.');
  const absolute = realpathSync(resolve(projectDir, outputPath));
  const rel = relative(projectDir, absolute);
  if (
    rel === '..' ||
    rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(rel)
  )
    throw new Error('Artifact is outside the project.');
  const before = statSync(absolute);
  if (!before.isFile()) throw new Error('Artifact is not a file.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolute)) hash.update(chunk);
  const after = statSync(absolute);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino)
    throw new Error('Artifact changed while reading.');
  return hash.digest('hex');
}

async function freezePreview(
  projectDir: string,
  outputPath: string,
  hash: string
): Promise<string> {
  const suffix = extname(outputPath).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(suffix))
    throw new Error('Artifact has no supported file extension.');
  const cache = join(projectDir, '.dhee', 'review-previews');
  const parent = relative(projectDir, realpathSync(join(projectDir, '.dhee')));
  if (parent.startsWith('..') || isAbsolute(parent))
    throw new Error('Review cache must be inside the project.');
  mkdirSync(cache, { recursive: true });
  const cacheRel = relative(projectDir, realpathSync(cache));
  if (cacheRel.startsWith('..') || isAbsolute(cacheRel))
    throw new Error('Review cache must be inside the project.');
  const previewPath = `.dhee/review-previews/${hash}${suffix}`;
  if (
    existsSync(join(projectDir, previewPath)) &&
    (await fileHash(projectDir, previewPath)) === hash
  )
    return previewPath;
  const temp = `.dhee/review-previews/${randomUUID()}.tmp`;
  try {
    copyFileSync(resolve(projectDir, outputPath), join(projectDir, temp));
    if ((await fileHash(projectDir, temp)) !== hash)
      throw new Error('Artifact changed while making its review preview.');
    renameSync(join(projectDir, temp), join(projectDir, previewPath));
  } finally {
    rmSync(join(projectDir, temp), { force: true });
  }
  return previewPath;
}
function previewFormat(path: string): ReviewPreview['format'] {
  const ext = extname(path).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.webm', '.m4v'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.m4a', '.ogg', '.flac'].includes(ext)) return 'audio';
  if (ext === '.json') return 'json';
  if (ext === '.md') return 'md';
  if (ext === '.txt') return 'text';
  throw new Error('This artifact format cannot be previewed for review.');
}

async function snapshot(
  scope: ReviewScope,
  events: DheeEvent[]
): Promise<{ fingerprint: string; previews: ReviewPreview[] }> {
  const state = projectWalkState(events, { branchId: scope.branchId });
  const visible = branchVisibilityFilter(events, scope.branchId!);
  const completions = new Map<string, NodeCompletedPayload>();
  for (const event of events.filter(visible)) {
    if (event.kind === 'node.completed') {
      const p = event.payload as NodeCompletedPayload;
      completions.set(`${keyOf(p)}@${p.versionId}`, p);
    }
  }
  const visited = new Set<string>();
  const previews: ReviewPreview[] = [];
  const artifacts: Array<{ key: string; version: string; path: string; hash: string }> = [];
  const visit = async (target: ReviewTarget): Promise<void> => {
    const key = keyOf(target);
    if (visited.has(key)) return;
    visited.add(key);
    const current = state.nodes[key];
    if (current?.status !== 'completed' || !current.outputPath || !current.selectedVersionId)
      throw new Error(`${key}: artifact is not complete.`);
    const completion = completions.get(`${key}@${current.selectedVersionId}`);
    if (!completion) throw new Error(`${key}: selected version has no completion record.`);
    const hash = await fileHash(scope.projectDir, current.outputPath);
    const format = previewFormat(current.outputPath);
    previews.push({
      key,
      versionId: current.selectedVersionId,
      format,
      previewPath: await freezePreview(scope.projectDir, current.outputPath, hash),
    });
    artifacts.push({
      key,
      version: current.selectedVersionId,
      path: current.outputPath,
      hash,
    });
    for (const dependency of completion.dependencies ?? []) await visit(dependency);
  };
  for (const target of scope.targets) await visit(target);
  artifacts.sort((a, b) => a.key.localeCompare(b.key));
  return {
    previews,
    fingerprint: digest({
      schema: 1,
      branchId: scope.branchId,
      gate: scope.gate,
      targets: scope.targets,
      artifacts,
    }),
  };
}

async function readNormalized(scope: ReviewScope): Promise<ProductionReview> {
  const log = openEventLog(scope.projectDir);
  const events = [...log.read()];
  const revision = events.reduce((max, event) => Math.max(max, event.seq), 0) + 1;
  const last = events
    .filter(
      e =>
        e.branchId === scope.branchId &&
        e.kind === 'review.decided' &&
        (e.payload as ReviewDecidedPayload).gate === scope.gate
    )
    .at(-1);
  const decision = last?.payload as ReviewDecidedPayload | undefined;
  const history = last ? { decidedAt: last.ts, notes: decision?.notes } : {};
  try {
    const { fingerprint, previews } = await snapshot(scope, events);
    if (log.nextSeq() !== revision)
      throw new Error('Project changed while reading; refresh the review.');
    const status = !decision
      ? 'unreviewed'
      : decision.fingerprint === fingerprint
        ? decision.decision
        : 'stale';
    return { status, fingerprint, previews, ...history };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
      ...history,
    };
  }
}

export async function readProductionReview(scope: ReviewScope): Promise<ProductionReview> {
  return readNormalized(normalize(scope));
}

export async function recordProductionReview(
  input: RecordProductionReviewInput
): Promise<ProductionReview> {
  const scope = normalize(input);
  if (!['approved', 'changes-requested'].includes(input.decision))
    throw new Error('Invalid review decision.');
  if (
    typeof input.expectedFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.expectedFingerprint)
  )
    throw new Error('A current review fingerprint is required.');
  if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 4000))
    throw new Error('Review notes must be at most 4000 characters.');
  const lock = acquireWalkLock(scope.projectDir);
  if (isWalkLockResult(lock))
    throw new Error('A run or review save is in progress. Wait for it to finish.');
  try {
    const current = await readNormalized(scope);
    if (!current.fingerprint || current.fingerprint !== input.expectedFingerprint)
      throw new Error(
        'Reviewed artifacts changed or are unavailable. Refresh and review them again.'
      );
    openEventLog(scope.projectDir).append({
      kind: 'review.decided',
      actor: 'user',
      branchId: scope.branchId!,
      payload: {
        gate: scope.gate,
        targets: scope.targets,
        fingerprint: current.fingerprint,
        decision: input.decision,
        reviewer: 'local-user',
        ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      },
    });
    return await readNormalized(scope);
  } finally {
    lock.release();
  }
}
