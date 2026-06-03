export type NodeKind = 'stage' | 'collection';

export type InputUsage = 'context' | 'reference' | 'input' | 'aggregate';

export type InputScope = 'all' | 'matching' | 'any' | 'previousN';

export interface AggregateConfig {
  strategy: 'list' | 'join';
  sep?: string;
  limit?: number;
}

export interface NodeInput {
  from: string;
  usage: InputUsage;
  scope?: InputScope;
  n?: number;
  aggregate?: AggregateConfig;
}

export interface NodeOutput {
  format: 'md' | 'json' | 'image' | 'video' | 'audio' | 'text';
  pattern: string;
}

export interface ChunkBy {
  constraint: 'max_frames';
  limit: number;
  fps?: number;
  firstSegmentPlusOne?: boolean;
}

export interface NodeDef {
  id: string;
  kind: NodeKind;
  itemSource?: string;
  itemKey?: string;
  chunkBy?: ChunkBy;
  inputs: NodeInput[];
  outputs: NodeOutput;
  runner: {
    tool: string;
    config: Record<string, unknown>;
  };
  headlineField?: string;
  displayCapability?: string;
}

export interface BundleDependencies {
  runners?: Record<string, string>;
}

export interface BundleInputOption {
  value: string | number | boolean;
  label: string;
}

export type BundleInputControl = 'textarea' | 'text' | 'pills' | 'select' | 'number';

export type BundleInputDecl =
  | {
      id: string;
      kind: 'file';
      path: string;
      required?: boolean;
      label?: string;
      placeholder?: string;
      multiline?: boolean;
    }
  | {
      id: string;
      kind: 'project';
      field: string;
      default?: unknown;
      required?: boolean;
      label?: string;
      control?: BundleInputControl;
      options?: BundleInputOption[];
      unit?: string;
      placeholder?: string;
    };

export interface BundleDisplay {
  thumbnail?: {
    from: string;
    pick?: 'first_completed' | 'random_completed' | 'latest_completed';
  };
  stats?: Array<{
    label: string;
    source: string;
    count_completed?: boolean;
    path?: string;
  }>;
}

export interface DagBundle {
  id: string;
  version: string;
  displayName?: string;
  summary?: string;
  techLine?: string;
  description?: string;
  engineCompat?: string;
  dependencies?: BundleDependencies;
  inputs?: BundleInputDecl[];
  goal: string;
  reviewLoopMax?: number;
  nodes: NodeDef[];
  display?: BundleDisplay;
}

export interface RunnerDescription {
  id: string;
  displayName: string;
  description: string;
  capabilities: string[];
  modalities: {
    input: Array<'text' | 'image' | 'video' | 'audio'>;
    output: Array<'text' | 'image' | 'video' | 'audio'>;
  };
  configSchema: Record<string, unknown>;
  costHint?: 'free' | 'paid_api' | 'local_gpu' | 'cloud_gpu';
}

export type LLMAccessTier = 'heavy' | 'medium' | 'light';

export type LLMAccessMessageRole = 'system' | 'user' | 'assistant';

export interface LLMAccessMessage {
  role: LLMAccessMessageRole;
  content: string;
}

export interface LLMGenerateTextOptions {
  messages: LLMAccessMessage[];
  tier?: LLMAccessTier;
  purpose?: string;
  signal?: AbortSignal;
  responseFormat?: { type: 'json_object' };
  temperature?: number;
  maxTokens?: number;
}

export interface LLMGenerateTextResult {
  content?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface LLMAccess {
  generateText(opts: LLMGenerateTextOptions): Promise<LLMGenerateTextResult>;
}

export interface RunnerContext {
  projectDir: string;
  bundleDir?: string;
  node: NodeDef;
  itemId?: string;
  inputs: Record<string, unknown>;
  signal?: AbortSignal;
  log: (msg: string) => void;
  llm?: LLMAccess;
}

export interface RunnerArtifact {
  path: string;
  kind?: 'file' | 'text' | 'json' | 'image' | 'video' | 'audio';
  metadata?: Record<string, unknown>;
}

export type RunnerResult =
  | {
      ok: true;
      outputPath: string;
      outputs?: RunnerArtifact[];
      metadata?: Record<string, unknown>;
    }
  | { ok: false; error: string };

export interface Runner {
  describe: () => RunnerDescription;
  run: (ctx: RunnerContext) => Promise<RunnerResult>;
}

export interface RunnerPermissions {
  network?: string[];
  filesystem?: 'project' | 'none' | 'temp';
  subprocess?: boolean;
  env?: string[];
}

export interface RunnerManifest {
  tool: string;
  version: string;
  engineCompat: string;
  credentials: string[];
  displayName?: string;
  description?: string;
  entry?: string;
  permissions?: RunnerPermissions;
}
