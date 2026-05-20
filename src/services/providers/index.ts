/**
 * Provider system exports and initialization.
 *
 * Registers all available providers and configures the registry
 * based on environment variables.
 */
export type {
  GenerationCapability,
  GenerationProvider,
  GenerationResult,
  ImageGenerationInput,
  ImageEditInput,
  VideoGenerationInput,
  ProviderProgressInfo,
  ProviderProgressCallback,
  ProviderReferenceImage,
} from './types.js';

export { ProviderRegistry, type ProviderConfig } from './ProviderRegistry.js';
export { ComfyUIProvider } from './comfyui/ComfyUIProvider.js';
export { WorkflowModeRegistry, getWorkflowModeRegistry } from './WorkflowModeRegistry.js';
export type { WorkflowManifest, WorkflowPipeline, InputRequirement, ParameterMapping } from './types.js';

import { ProviderRegistry } from './ProviderRegistry.js';
import { ComfyUIProvider } from './comfyui/ComfyUIProvider.js';

let _registry: ProviderRegistry | null = null;

/**
 * Get the singleton provider registry.
 * Lazily initialized on first call.
 */
export function getProviderRegistry(): ProviderRegistry {
  if (!_registry) {
    _registry = createProviderRegistry();
  }
  return _registry;
}

/**
 * Create and configure the provider registry.
 * Reads env vars for per-capability provider selection.
 */
function createProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();

  // Register built-in providers
  registry.register(new ComfyUIProvider());

  // Lazy-register cloud providers only when their API keys are present
  // Google provider (Nano Banana 2 + Veo 2)
  if (process.env['GOOGLE_AI_API_KEY']) {
    import('./google/GoogleProvider.js')
      .then(({ GoogleProvider }) => registry.register(new GoogleProvider()))
      .catch(() => { /* Google provider not available */ });
  }

  // xAI provider (Aurora + Grok Imagine)
  if (process.env['XAI_API_KEY']) {
    import('./xai/XAIProvider.js')
      .then(({ XAIProvider }) => registry.register(new XAIProvider()))
      .catch(() => { /* xAI provider not available */ });
  }

  // Apply env var configuration
  const imageProvider = process.env['dhee_IMAGE_PROVIDER'];
  const editProvider = process.env['dhee_EDIT_PROVIDER'];
  const videoProvider = process.env['dhee_VIDEO_PROVIDER'];

  if (imageProvider || editProvider || videoProvider) {
    registry.setConfig({
      imageGeneration: imageProvider || 'comfyui',
      imageEditing: editProvider || 'comfyui',
      videoGeneration: videoProvider || 'comfyui',
    });
  }

  return registry;
}
