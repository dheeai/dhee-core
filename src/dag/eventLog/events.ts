/**
 * Event types for the kshana event log.
 *
 * Per docs/event-sourced-graph-design.md, every behavior emits events;
 * projections fold them; readers query projections.
 *
 * Envelope is fixed across all kinds; the payload union is per-kind.
 */

export type EventActor = 'walker' | 'agent' | 'user' | 'runner';

export type EventKind =
  | 'project.created'
  | 'bundle.bound'
  | 'inputs.provided'
  | 'node.started'
  | 'node.completed'
  | 'node.failed'
  | 'node.invalidated'
  | 'version.added'
  | 'version.selected'
  | 'branch.created'
  | 'runner.swap_suggested'
  | 'runner.swapped'
  | 'critique.added'
  | 'budget.exceeded';

export interface NodeStartedPayload {
  nodeId: string;
  itemId?: string;
}

/**
 * One upstream instance whose output was consumed by a runner call.
 * Captured by the walker at dispatch time — the walker already
 * resolves these to build ctx.inputs, so adding them to the event is
 * essentially free.
 *
 * Roles mirror the bundle's `inputs[].usage`:
 *   - 'input'     — primary content (e.g. shot_image_prompt → shot_image)
 *   - 'context'   — extra background passed to the LLM
 *   - 'reference' — referenced asset (e.g. character_image → shot_image)
 *   - 'aggregate' — collected list of upstream items
 */
export interface NodeDependency {
  nodeId: string;
  itemId?: string;
  role?: 'input' | 'context' | 'reference' | 'aggregate';
}

export interface NodeCompletedPayload {
  nodeId: string;
  itemId?: string;
  versionId: string;
  outputPath: string;
  artifact?: {
    storeHash?: string;
    format: 'md' | 'json' | 'image' | 'video' | 'audio' | 'text';
    bytes?: number;
  };
  generation?: {
    tool: string;
    toolVersion: string;
    inputsHash?: string;
    seed?: number | string;
    costUsd?: number;
    cached: boolean;
  };
  /**
   * Upstream instances whose outputs fed this runner call. Source of
   * truth for the instance-level dependency graph projection. Optional
   * — events written before the walker captured deps don't carry it;
   * the projection treats absence as "no recorded dependencies".
   */
  dependencies?: NodeDependency[];
  metadata?: Record<string, unknown>;
}

export interface NodeFailedPayload {
  nodeId: string;
  itemId?: string;
  error: string;
}

export interface NodeInvalidatedPayload {
  nodeId: string;
  itemId?: string;
  reason?: string;
}

export interface VersionAddedPayload {
  nodeId: string;
  itemId?: string;
  versionId: string;
  parentVersionId?: string;
  /**
   * Who produced this version. 'runner' = an auto-generated artifact
   * from a walker dispatch. 'user' = the user (via the agent's write
   * tools) supplied this content directly; the walker should treat
   * user-versions as pinned and not re-fire the runner unless the
   * version is explicitly invalidated.
   */
  source?: 'runner' | 'user';
  /**
   * Path of the artifact written, relative to projectDir. Stored so
   * projections + agent tools can locate the bytes without re-deriving
   * from the bundle's outputPath template.
   */
  outputPath?: string;
  /**
   * Optional free-text reason the user supplied (for user-source
   * versions). Audit + future-you context.
   */
  reason?: string;
}

export interface VersionSelectedPayload {
  nodeId: string;
  itemId?: string;
  versionId: string;
}

export interface BranchCreatedPayload {
  branchId: string;
  label?: string;
  parentBranchId?: string;
  forkedFromEventId: string;
}

export interface ProjectCreatedPayload {
  projectDir: string;
}

export interface BundleBoundPayload {
  bundleSource: string;
  bundleVersion: string;
  engineVersion: string;
}

export interface InputsProvidedPayload {
  inputs: Record<string, unknown>;
}

export interface RunnerSwapSuggestedPayload {
  nodeId: string;
  itemId?: string;
  suggestedTool: string;
  reason: string;
  confidence?: number;
}

export interface RunnerSwappedPayload {
  nodeId: string;
  itemId?: string;
  /**
   * Missing on legacy events. Legacy events keep strict old behavior:
   * itemId must exactly match the dispatch itemId.
   */
  scope?: 'node' | 'instance';
  fromTool: string;
  toTool: string;
  reason: string;
  forced?: boolean;
  configOverride?: Record<string, unknown>;
  /**
   * Compatibility-generated config values. Merged before configOverride
   * so user-provided config wins.
   */
  generatedConfigOverride?: Record<string, unknown>;
  runtimeBindings?: Array<{
    configKey: string;
    fromInput: string;
  }>;
  compatibility?: {
    status?: string;
    reason?: string;
    warning?: string;
  };
}

export interface CritiqueAddedPayload {
  nodeId: string;
  itemId?: string;
  verdict: 'pass' | 'fail' | 'unsure';
  critique?: string;
  judgeTool?: string;
}

/**
 * Emitted by the walker when accumulated paid spend on the branch has
 * reached the configured `features.budgetCapUsd` and the walk halted
 * BEFORE dispatching the next paid (non-cached) instance. A safety
 * backstop, not a failure: the walk paused so the user can raise the
 * cap (or clear it) and resume. `spentUsd` is the branch's cumulative
 * spend at the moment of the halt (it never exceeds `capUsd` by more
 * than the cost of the single in-flight instance, since the check is
 * a pre-flight one — see walker.ts). `nextNodeId` is the instance the
 * walk declined to run.
 */
export interface BudgetExceededPayload {
  capUsd: number;
  spentUsd: number;
  nextNodeId: string;
  itemId?: string;
}

/**
 * Union of payloads, indexed by kind. Each kind keeps its narrow payload
 * shape; consumers can switch over `event.kind` and the type is narrowed.
 */
export interface PayloadByKind {
  'project.created': ProjectCreatedPayload;
  'bundle.bound': BundleBoundPayload;
  'inputs.provided': InputsProvidedPayload;
  'node.started': NodeStartedPayload;
  'node.completed': NodeCompletedPayload;
  'node.failed': NodeFailedPayload;
  'node.invalidated': NodeInvalidatedPayload;
  'version.added': VersionAddedPayload;
  'version.selected': VersionSelectedPayload;
  'branch.created': BranchCreatedPayload;
  'runner.swap_suggested': RunnerSwapSuggestedPayload;
  'runner.swapped': RunnerSwappedPayload;
  'critique.added': CritiqueAddedPayload;
  'budget.exceeded': BudgetExceededPayload;
}

export interface DheeEvent<K extends EventKind = EventKind> {
  seq: number;
  id: string;
  ts: number;
  branchId: string;
  parentEventId?: string;
  actor: EventActor;
  kind: K;
  payload: PayloadByKind[K];
}

/** Shape accepted by EventLog.append — seq/id/ts are assigned by the log. */
export type EventAppendInput<K extends EventKind = EventKind> = Omit<DheeEvent<K>, 'seq' | 'id' | 'ts'>;
