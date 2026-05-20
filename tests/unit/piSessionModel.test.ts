import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolvePiSessionModel } from '../../src/agent/pi/PiSessionAgent.js';

const keys = [
  'LLM_PROVIDER',
  'LLM_CONTEXT_TOKENS',
  'LLM_MAX_TOKENS',
  'LLM_TIER_HEAVY_PROVIDER',
  'LLM_TIER_HEAVY_MODEL',
  'LLM_TIER_HEAVY_API_KEY',
  'LLM_TIER_HEAVY_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
] as const;

describe('resolvePiSessionModel', () => {
  const previous = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of keys) {
      previous.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previous.clear();
  });

  it('uses the dhee website OpenAI-compatible proxy instead of defaulting to OpenRouter', () => {
    process.env['LLM_PROVIDER'] = 'openai';
    process.env['LLM_CONTEXT_TOKENS'] = '160000';
    process.env['OPENAI_API_KEY'] = 'desktop-token';
    process.env['OPENAI_BASE_URL'] = 'http://localhost:3000/openai/api/v1';
    process.env['OPENAI_MODEL'] = 'deepseek/deepseek-v4-flash';

    const model = resolvePiSessionModel();

    expect(model.provider).toBe('openai');
    expect(model.api).toBe('openai-completions');
    expect(model.id).toBe('deepseek/deepseek-v4-flash');
    expect(model.baseUrl).toBe('http://localhost:3000/openai/api/v1');
    expect(model.contextWindow).toBe(160000);
    expect(process.env['OPENROUTER_API_KEY']).toBeUndefined();
  });

  it('honors LLM_TIER_HEAVY_BASE_URL by routing pi-agent through that proxy URL', () => {
    // Per-tier mode in the desktop sets LLM_TIER_HEAVY_PROVIDER=openai +
    // BASE_URL/API_KEY/MODEL when the user picks an OpenAI-compatible
    // proxy (e.g. Kshana Cloud, LM Studio, self-hosted). Without this
    // path pi-ai would call getModel('openai', ...) and silently route
    // to api.openai.com, ignoring the user's proxy.
    process.env['LLM_TIER_HEAVY_PROVIDER'] = 'openai';
    process.env['LLM_TIER_HEAVY_BASE_URL'] = 'https://kshana.share.zrok.io';
    process.env['LLM_TIER_HEAVY_API_KEY'] = 'tier-heavy-key';
    process.env['LLM_TIER_HEAVY_MODEL'] = 'Qwen3.6-35B-A3B';

    const model = resolvePiSessionModel();

    expect(model.api).toBe('openai-completions');
    expect(model.baseUrl).toBe('https://kshana.share.zrok.io');
    expect(model.id).toBe('Qwen3.6-35B-A3B');
  });

  it('keeps explicit heavy-tier OpenRouter routing when configured', () => {
    process.env['LLM_PROVIDER'] = 'openai';
    process.env['OPENAI_API_KEY'] = 'desktop-token';
    process.env['OPENAI_BASE_URL'] = 'http://localhost:3000/openai/api/v1';
    process.env['LLM_TIER_HEAVY_PROVIDER'] = 'openrouter';
    process.env['LLM_TIER_HEAVY_MODEL'] = 'deepseek/deepseek-v4-flash';
    process.env['LLM_TIER_HEAVY_API_KEY'] = 'sk-or-test';

    const model = resolvePiSessionModel();

    expect(model.provider).toBe('openrouter');
    expect(model.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(process.env['OPENROUTER_API_KEY']).toBe('sk-or-test');
  });
});
