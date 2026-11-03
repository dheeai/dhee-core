import type { DagBundle } from './schema.js';

export type BundleRuntimeMode = 'local' | 'dhee_cloud';
export type BundleRuntimeProvider = 'comfy' | 'openrouter' | 'llm' | 'ffmpeg';

export interface BundleRuntimeSupport {
  modes: BundleRuntimeMode[];
  providers: BundleRuntimeProvider[];
}

type BundleWithRuntimeSupport = Partial<DagBundle> & {
  runtimeSupport?: unknown;
};

const MODE_ORDER: BundleRuntimeMode[] = ['local', 'dhee_cloud'];
const PROVIDER_ORDER: BundleRuntimeProvider[] = ['comfy', 'openrouter', 'llm', 'ffmpeg'];

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function normalizeModes(value: unknown): BundleRuntimeMode[] {
  const modes = new Set(
    normalizeStringList(value).filter((item): item is BundleRuntimeMode =>
      MODE_ORDER.includes(item as BundleRuntimeMode),
    ),
  );
  return MODE_ORDER.filter((mode) => modes.has(mode));
}

function normalizeProviders(value: unknown): BundleRuntimeProvider[] {
  const providers = new Set(
    normalizeStringList(value).filter((item): item is BundleRuntimeProvider =>
      PROVIDER_ORDER.includes(item as BundleRuntimeProvider),
    ),
  );
  return PROVIDER_ORDER.filter((provider) => providers.has(provider));
}

function toolProvider(tool: string): BundleRuntimeProvider | null {
  if (tool.startsWith('comfy.')) return 'comfy';
  if (tool.startsWith('openrouter.')) return 'openrouter';
  if (tool.startsWith('ffmpeg.')) return 'ffmpeg';
  if (tool === 'llm.generate' || tool === 'vlm.judge') return 'llm';
  return null;
}

function inferRuntimeSupport(bundle: Partial<DagBundle>): BundleRuntimeSupport {
  const modeSet = new Set<BundleRuntimeMode>();
  const providerSet = new Set<BundleRuntimeProvider>();

  for (const node of bundle.nodes ?? []) {
    const tool = node.runner?.tool;
    if (!tool) continue;
    const provider = toolProvider(tool);
    if (provider) providerSet.add(provider);

    if (tool.startsWith('openrouter.')) {
      modeSet.add('dhee_cloud');
    } else if (tool.startsWith('comfy.')) {
      modeSet.add('local');
      modeSet.add('dhee_cloud');
    } else if (tool === 'llm.generate' || tool === 'vlm.judge') {
      modeSet.add('local');
      modeSet.add('dhee_cloud');
    } else if (tool.startsWith('ffmpeg.')) {
      modeSet.add('local');
    }
  }

  if (modeSet.size === 0) modeSet.add('local');

  return {
    modes: MODE_ORDER.filter((mode) => modeSet.has(mode)),
    providers: PROVIDER_ORDER.filter((provider) => providerSet.has(provider)),
  };
}

export function bundleRuntimeSupport(bundle: BundleWithRuntimeSupport): BundleRuntimeSupport {
  const inferred = inferRuntimeSupport(bundle);
  const raw = bundle.runtimeSupport;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return inferred;

  const record = raw as Record<string, unknown>;
  const modes = normalizeModes(record['modes']);
  const providers = normalizeProviders(record['providers']);

  return {
    modes: modes.length > 0 ? modes : inferred.modes,
    providers: providers.length > 0 ? providers : inferred.providers,
  };
}
