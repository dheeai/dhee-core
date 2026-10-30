import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DagBundle } from './schema.js';
import { projectWalkState } from './eventLog/projectWalkState.js';
import { branchVisibilityFilter } from './eventLog/branchFilter.js';
import type { NodeCompletedPayload } from './eventLog/events.js';
import { openEventLog } from './eventLog/EventLog.js';
import { acquireWalkLock, isWalkLockResult } from './projectWalkLock.js';
import { readProductionReview, type ReviewTarget } from './productionReviews.js';

export type CreativeGate = 'storyboard' | 'references' | 'rough-cut';
export interface ReviewGateInstance {
  itemId?: string;
  status: string;
}
export function productionReviewsRequired(projectDir: string): boolean {
  const event = [...openEventLog(projectDir).read()]
    .filter(e => e.kind === 'review.policy-set')
    .at(-1);
  return (event?.payload as { enabled?: unknown } | undefined)?.enabled === true;
}
export function setProductionReviewsRequired(input: { projectDir: string; enabled: boolean }): {
  enabled: boolean;
} {
  if (typeof input.enabled !== 'boolean')
    throw new Error('Review policy must be enabled or disabled explicitly.');
  const projectDir = realpathSync(input.projectDir);
  if (!statSync(join(projectDir, 'project.json')).isFile())
    throw new Error('Project is unavailable.');
  const lock = acquireWalkLock(projectDir);
  if (isWalkLockResult(lock))
    throw new Error('A run or review save is in progress. Stop it before changing review policy.');
  try {
    openEventLog(projectDir).append({
      kind: 'review.policy-set',
      actor: 'user',
      branchId: 'main',
      payload: { enabled: input.enabled },
    });
    return { enabled: input.enabled };
  } finally {
    lock.release();
  }
}
export function isNarrativeReviewBundle(bundle: Pick<DagBundle, 'nodes'>): boolean {
  return (
    ['story', 'scenes_plan', 'final_video'].every(id => bundle.nodes.some(n => n.id === id)) &&
    bundle.nodes.some(n => n.id === 'final_video' && n.outputs.format === 'video')
  );
}
export function requiredReviewNodes(
  bundle: Pick<DagBundle, 'nodes'>,
  gate: CreativeGate
): string[] {
  const optional = (ids: string[]) => bundle.nodes.filter(n => ids.includes(n.id)).map(n => n.id);
  if (gate === 'storyboard')
    return ['story', 'scenes_plan', ...optional(['shot_image_prompt', 'shot_motion_directive'])];
  if (gate === 'references')
    return ['character_image', ...optional(['setting_image']), 'voice_reference'];
  return [
    ...optional(['shot_image', 'shot_image_last_frame', 'shot_video', 'scene_clip']),
    'final_video',
  ];
}
export function requiredGateBeforeNode(
  bundle: Pick<DagBundle, 'nodes'>,
  nodeId: string
): CreativeGate | undefined {
  const node = bundle.nodes.find(n => n.id === nodeId);
  if (!node) return undefined;
  if (['character_image', 'setting_image', 'voice_reference'].includes(nodeId)) return 'storyboard';
  if (['image', 'video', 'audio'].includes(node.outputs.format)) return 'references';
  return undefined;
}
export async function resolveProductionReviewGate(input: {
  projectDir: string;
  bundle: Pick<DagBundle, 'nodes'>;
  branchId?: string;
  gate: CreativeGate;
  instances: Map<string, ReviewGateInstance[]>;
}): Promise<{ targets: ReviewTarget[]; reason?: string }> {
  if (!isNarrativeReviewBundle(input.bundle))
    return {
      targets: [],
      reason: 'This bundle does not declare a supported narrative review workflow.',
    };
  const targets: ReviewTarget[] = [];
  for (const nodeId of requiredReviewNodes(input.bundle, input.gate)) {
    const definition = input.bundle.nodes.find(n => n.id === nodeId);
    if (!definition)
      return {
        targets: [],
        reason: `${nodeId} is not configured. Add this review input before continuing.`,
      };
    if (nodeId === 'voice_reference' && definition.outputs.format !== 'audio')
      return { targets: [], reason: 'voice_reference must provide an audio audition.' };
    const items = input.instances.get(nodeId) ?? [];
    if (!items.length || items.some(i => i.status !== 'completed'))
      return {
        targets: [],
        reason: `${nodeId} is incomplete. Finish its review inputs before continuing.`,
      };
    for (const item of items)
      targets.push({ nodeId, ...(item.itemId === undefined ? {} : { itemId: item.itemId }) });
  }
  const events = [...openEventLog(input.projectDir).read()];
  const state = projectWalkState(events, { branchId: input.branchId });
  const visible = branchVisibilityFilter(events, input.branchId ?? 'main');
  const completions = new Map<string, NodeCompletedPayload>();
  for (const event of events.filter(visible))
    if (event.kind === 'node.completed') {
      const p = event.payload as NodeCompletedPayload;
      completions.set(
        `${p.nodeId}${p.itemId === undefined ? '' : `:${p.itemId}`}@${p.versionId}`,
        p
      );
    }
  const seen = new Set<string>();
  const lineage = (target: ReviewTarget): boolean => {
    const key = target.itemId === undefined ? target.nodeId : `${target.nodeId}:${target.itemId}`;
    if (seen.has(key)) return true;
    seen.add(key);
    const completion = completions.get(`${key}@${state.nodes[key]?.selectedVersionId}`);
    const node = input.bundle.nodes.find(n => n.id === target.nodeId);
    if (!completion || !node) return false;
    const expected = node.inputs.filter(
      i => i.from !== node.id && (input.instances.get(i.from)?.length ?? 0) > 0
    );
    if (expected.some(i => !completion.dependencies?.some(d => d.nodeId === i.from))) return false;
    return (completion.dependencies ?? []).every(lineage);
  };
  if (!targets.every(lineage))
    return {
      targets: [],
      reason:
        'Review inputs have incomplete dependency history. Regenerate these artifacts before enabling required reviews.',
    };
  return { targets };
}
export async function checkProductionReviewGate(
  input: Parameters<typeof resolveProductionReviewGate>[0]
): Promise<{ approved: boolean; reason?: string }> {
  const scope = await resolveProductionReviewGate(input);
  if (!scope.targets.length) return { approved: false, reason: scope.reason };
  const review = await readProductionReview({ ...input, targets: scope.targets });
  return review.status === 'approved'
    ? { approved: true }
    : {
        approved: false,
        reason: review.reason ?? `${input.gate} needs a current human approval in Desktop.`,
      };
}

export function creativeReviewPauseMessage(gatedAfter: string): string | undefined {
  if (!gatedAfter.startsWith('review:')) return undefined;
  return `Creative approval required: ${gatedAfter.slice(7)}. Review the current artifacts in Desktop and record approval before resuming. A plain resume cannot bypass this gate. This is a review pause, not final delivery or a technical failure.`;
}
