/**
 * LLM configuration from environment variables.
 * Supports the same env vars as the Python dhee project.
 */

// Load .env when this module is used directly (CLI, scripts)
import 'dotenv/config';
import type { LLMClientConfig } from './types.js';

export type LLMProvider =
  | 'gemini'
  | 'lmstudio'
  | 'llamacpp'
  | 'ollama'
  | 'openai'
  | 'openrouter'
  | 'custom';

/**
 * Get the LLM provider from environment.
 */
export function getLLMProvider(): LLMProvider {
  const provider = process.env['LLM_PROVIDER']?.toLowerCase();
  switch (provider) {
    case 'gemini':
      return 'gemini';
    case 'lmstudio':
      return 'lmstudio';
    case 'llamacpp':
      return 'llamacpp';
    case 'ollama':
      return 'ollama';
    case 'openai':
      return 'openai';
    case 'openrouter':
      return 'openrouter';
    default:
      return 'custom';
  }
}

/**
 * Get Gemini configuration from environment.
 */
function getGeminiConfig(): LLMClientConfig {
  return {
    // Gemini uses OpenAI-compatible endpoint
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKey: process.env['GOOGLE_API_KEY'] ?? '',
    model: process.env['GEMINI_MODEL'] ?? 'gemini-2.0-flash',
  };
}

/**
 * Get LM Studio configuration from environment.
 */
function getLMStudioConfig(): LLMClientConfig {
  return {
    baseUrl: process.env['LMSTUDIO_BASE_URL'] ?? 'http://127.0.0.1:1234/v1',
    apiKey: process.env['LMSTUDIO_API_KEY'] ?? 'not-needed',
    model: process.env['LMSTUDIO_MODEL'] ?? 'local-model',
  };
}

/**
 * Get Ollama configuration from environment.
 */
function getOllamaConfig(): LLMClientConfig {
  return {
    baseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434/v1',
    apiKey: 'ollama', // Ollama doesn't need a key but OpenAI SDK requires something
    model: process.env['OLLAMA_MODEL'] ?? 'llama3.2',
  };
}

/**
 * Get llama.cpp server configuration from environment.
 */
function getLlamaCppConfig(): LLMClientConfig {
  return {
    baseUrl: process.env['LLAMACPP_BASE_URL'] ?? 'http://127.0.0.1:8080/v1',
    apiKey: 'not-needed', // llama-server doesn't need a key
    model: process.env['LLAMACPP_MODEL'] ?? 'local-model',
  };
}

/**
 * Get OpenAI configuration from environment.
 */
function getOpenAIConfig(): LLMClientConfig {
  return {
    baseUrl: process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
    apiKey: process.env['OPENAI_API_KEY'] ?? '',
    model: process.env['OPENAI_MODEL'] ?? 'gpt-4o',
  };
}

function getOpenRouterConfig(): LLMClientConfig {
  return {
    baseUrl:
      process.env['OPENROUTER_BASE_URL'] ?? 'https://openrouter.ai/api/v1',
    apiKey: process.env['OPENROUTER_API_KEY'] ?? '',
    model: process.env['OPENROUTER_MODEL'] ?? 'z-ai/glm-4.7-flash',
  };
}

/**
 * Get custom/fallback configuration from environment.
 */
function getCustomConfig(): LLMClientConfig {
  return {
    baseUrl: process.env['LLM_BASE_URL'] ?? 'http://127.0.0.1:1234/v1',
    apiKey: process.env['LLM_API_KEY'] ?? 'not-needed',
    model: process.env['LLM_MODEL'] ?? 'local-model',
  };
}

/**
 * Get LLM configuration based on the provider.
 * Merges environment-based config with any overrides provided.
 */
export function getLLMConfig(overrides?: Partial<LLMClientConfig>): LLMClientConfig {
  const provider = getLLMProvider();

  let config: LLMClientConfig;
  switch (provider) {
    case 'gemini':
      config = getGeminiConfig();
      break;
    case 'lmstudio':
      config = getLMStudioConfig();
      break;
    case 'llamacpp':
      config = getLlamaCppConfig();
      break;
    case 'ollama':
      config = getOllamaConfig();
      break;
    case 'openai':
      config = getOpenAIConfig();
      break;
    case 'openrouter':
      config = getOpenRouterConfig();
      break;
    default:
      config = getCustomConfig();
  }

  // Apply overrides
  if (overrides) {
    if (overrides.baseUrl) config.baseUrl = overrides.baseUrl;
    if (overrides.apiKey) config.apiKey = overrides.apiKey;
    if (overrides.model) config.model = overrides.model;
  }

  return config;
}

/**
 * Validate that required environment variables are set for the provider.
 */
export function validateLLMConfig(): { valid: boolean; errors: string[] } {
  const provider = getLLMProvider();
  const errors: string[] = [];

  switch (provider) {
    case 'gemini':
      if (!process.env['GOOGLE_API_KEY']) {
        errors.push('GOOGLE_API_KEY is required for Gemini provider');
      }
      break;
    case 'openai':
      if (!process.env['OPENAI_API_KEY']) {
        errors.push('OPENAI_API_KEY is required for OpenAI provider');
      }
      break;
    case 'openrouter':
      if (!process.env['OPENROUTER_API_KEY']) {
        errors.push('OPENROUTER_API_KEY is required for OpenRouter provider');
      }
      break;
    case 'lmstudio':
      // LM Studio typically doesn't need an API key
      break;
    case 'llamacpp':
      // llama-server doesn't need an API key
      break;
    case 'ollama':
      // Ollama doesn't need an API key
      break;
    default:
      // Custom provider - no validation
      break;
  }

  return { valid: errors.length === 0, errors };
}
