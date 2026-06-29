/**
 * @dhee_ai/runner-sdk — the public surface a Dhee runner (and bundle author)
 * builds against. A published runner depends on ONLY this package, never
 * on kshana-core internals (enforced by the runner-sdk firewall test).
 *
 * Re-exports the canonical bundle/runner types plus the shared runtime
 * primitives (endpoint resolution, transient retry, content-hash) that
 * every comfy/network runner needs.
 */
export type {
  AggregateConfig,
  BundleDependencies,
  BundleDisplay,
  BundleInputControl,
  BundleInputDecl,
  BundleInputOption,
  BundleRequirements,
  ChunkBy,
  DagBundle,
  InputScope,
  InputUsage,
  LLMAccess,
  LLMAccessMessage,
  LLMAccessMessageRole,
  LLMAccessTier,
  LLMGenerateTextOptions,
  LLMGenerateTextResult,
  NodeDef,
  NodeInput,
  NodeKind,
  NodeOutput,
  RequiredCustomNode,
  RequiredModel,
  Runner,
  RunnerArtifact,
  RunnerContext,
  RunnerDescription,
  RunnerManifest,
  RunnerPermissions,
  RunnerResult,
} from './types.js';

export { defineRunner } from './defineRunner.js';
export { isTransientError, retryTransient, type RetryOpts } from './transientRetry.js';
export { resolveEndpointUrl } from './endpointResolver.js';
export { computeInputsHash, type FileInputRef, type InputsHashKey } from './inputsHash.js';
export {
  buildComfyAuthHeaders,
  isComfyCloudUrl,
  readComfyApiKey,
  useBearerComfyAuth,
} from './comfyAuth.js';
export {
  ComfyClient,
  type ComfyClientOptions,
  type ComfyOutput,
  type RunOpts as ComfyRunOpts,
} from './comfyClient.js';
