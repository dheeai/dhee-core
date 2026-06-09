/**
 * buildPiSession config tests.
 *
 * We don't boot a real AgentSession here (that needs an LLM provider
 * + API key). Instead we exercise `buildPiSessionConfig`, the pure
 * config-assembly half of the factory — checking that:
 *
 *  - the right skill is loaded from src/agent/pi/skill/
 *  - the tool allowlist gates write / mutate capabilities
 *  - sessionManager is honored when passed in
 *  - cwd is honored when passed in
 *
 * `buildPiSession` itself = `createAgentSession(buildPiSessionConfig(opts))`
 * and is covered by the live drive.ts smoke test (gated on an API key).
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@mariozechner/pi-coding-agent';
import { buildPiSessionConfig, DHEE_SKILL_NAME } from '../../src/agent/pi/buildSession.js';

describe('buildPiSessionConfig', () => {
  it('loads the dhee skill from the package skill dir', async () => {
    const cfg = await buildPiSessionConfig({
      sessionManager: SessionManager.inMemory(process.cwd()),
    });

    const { skills } = cfg.resourceLoader.getSkills();
    const dhee = skills.find((s) => s.name === DHEE_SKILL_NAME);
    expect(dhee).toBeDefined();
    expect(dhee!.description.length).toBeGreaterThan(0);
    // Skill should be sourced from the package's own skill dir, not
    // a stray cwd-local .pi/skills checkout.
    expect(dhee!.filePath).toMatch(/src[\\/]agent[\\/]pi[\\/]skill[\\/]SKILL\.md$/);
  });

  it('gates the tool allowlist to project-scoped fs + dhee custom tools (no pi builtins, no write / edit / bash)', async () => {
    const cfg = await buildPiSessionConfig({
      sessionManager: SessionManager.inMemory(process.cwd()),
    });

    // The pi-coding-agent built-in read/ls/grep/find accept any absolute
    // path on the filesystem; we replaced them with project-scoped
    // dhee_read / dhee_ls / dhee_grep / dhee_find so the agent can't
    // wander into engine source. The old builtins must NOT be allowlisted.
    expect(cfg.tools).not.toContain('read');
    expect(cfg.tools).not.toContain('ls');
    expect(cfg.tools).not.toContain('grep');
    expect(cfg.tools).not.toContain('find');
    // The project-scoped replacements ARE allowlisted.
    expect(cfg.tools).toContain('dhee_read');
    expect(cfg.tools).toContain('dhee_ls');
    expect(cfg.tools).toContain('dhee_grep');
    expect(cfg.tools).toContain('dhee_find');
    // Mutating builtins are never allowlisted.
    expect(cfg.tools).not.toContain('write');
    expect(cfg.tools).not.toContain('edit');
    expect(cfg.tools).not.toContain('bash');
  });

  it('includes the v1 dhee tool names in the allowlist by default', async () => {
    const cfg = await buildPiSessionConfig({
      sessionManager: SessionManager.inMemory(process.cwd()),
    });
    expect(cfg.tools).toContain('dhee_create_project');
    expect(cfg.tools).toContain('dhee_start_run');
    expect(cfg.tools).toContain('dhee_get_status');
    expect(cfg.tools).toContain('dhee_regenerate_node');
    expect(cfg.tools).toContain('dhee_read_artifact');
    expect(cfg.tools).toContain('dhee_show_node_output');
    expect(cfg.tools).toContain('dhee_show_file');
  });

  it('omits dhee custom tools when includeDefaultTools=false', async () => {
    const cfg = await buildPiSessionConfig({
      sessionManager: SessionManager.inMemory(process.cwd()),
      customToolNames: [],
      includeDefaultTools: false,
    });
    expect(cfg.tools).not.toContain('dhee_create_project');
  });

  it('honors the sessionManager that was passed in', async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const cfg = await buildPiSessionConfig({ sessionManager: sm });
    expect(cfg.sessionManager).toBe(sm);
  });

  it('Phase 6.5b: explicit modelProvider/modelId/apiKey produces a config with a typed model + runtime auth', async () => {
    const cfg = await buildPiSessionConfig({
      sessionManager: SessionManager.inMemory(process.cwd()),
      modelProvider: 'openrouter',
      modelId: 'deepseek/deepseek-v4-flash',
      apiKey: 'or-test-key-123',
    });
    expect(cfg.model).toBeDefined();
    expect((cfg.model as { provider: string }).provider).toBe('openrouter');
    expect((cfg.model as { id: string }).id).toBe('deepseek/deepseek-v4-flash');
    expect(cfg.authStorage).toBeDefined();
    // The runtime API key should be retrievable for the configured provider.
    const key = await (cfg.authStorage as unknown as { getApiKey: (p: string) => Promise<string | undefined> }).getApiKey('openrouter');
    expect(key).toBe('or-test-key-123');
  });

  it('Phase 6.5b: modelBaseUrl overrides the resolved pi model endpoint', async () => {
    const cfg = await buildPiSessionConfig({
      sessionManager: SessionManager.inMemory(process.cwd()),
      modelProvider: 'cloud',
      apiKey: 'desktop-jwt',
      modelBaseUrl: 'https://desktop.example.test/openai/api/v1',
    });
    expect(cfg.model).toBeDefined();
    expect((cfg.model as { provider: string }).provider).toBe('cloud');
    expect((cfg.model as { name: string }).name).toBe('Dhee Cloud');
    expect((cfg.model as { id: string }).id).toBe('');
    expect((cfg.model as { baseUrl: string }).baseUrl).toBe(
      'https://desktop.example.test/openai/api/v1',
    );
    const key = await (cfg.authStorage as unknown as { getApiKey: (p: string) => Promise<string | undefined> }).getApiKey('cloud');
    expect(key).toBe('desktop-jwt');
  });

  it('honors an OpenRouter model id pi-ai does not know (e.g. inclusionai/ring-2.6-1t) instead of silently falling back to pi\'s default OpenAI model', async () => {
    // Regression: a valid OpenRouter slug that is absent from pi-ai's
    // curated MODELS table → getModel() returns undefined. The old code
    // left config.model UNSET, so pi-coding-agent fell back to its
    // built-in default model (gpt-5.x on api.openai.com). Paired with a
    // non-OpenAI runtime key (an OpenRouter sk-or-… key) every turn 401'd
    // ("Incorrect API key provided"), silently killing the agent — which
    // is what made the desktop "Resume" button appear to do nothing.
    const cfg = await buildPiSessionConfig({
      sessionManager: SessionManager.inMemory(process.cwd()),
      modelProvider: 'openrouter',
      modelId: 'inclusionai/ring-2.6-1t',
      apiKey: 'sk-or-v1-test-key',
      modelBaseUrl: 'https://openrouter.ai/api/v1',
    });
    // The config must target the caller's endpoint + model id — never
    // be undefined (which is the silent-fallback-to-OpenAI trap).
    expect(cfg.model).toBeDefined();
    expect((cfg.model as { id: string }).id).toBe('inclusionai/ring-2.6-1t');
    expect((cfg.model as { provider: string }).provider).toBe('openrouter');
    expect((cfg.model as { baseUrl: string }).baseUrl).toBe(
      'https://openrouter.ai/api/v1',
    );
    const key = await (cfg.authStorage as unknown as { getApiKey: (p: string) => Promise<string | undefined> }).getApiKey('openrouter');
    expect(key).toBe('sk-or-v1-test-key');
  });

  it('Phase 6.5b: partial overrides (e.g. modelProvider without apiKey) do NOT activate the explicit-model path — falls back to auto-discovery', async () => {
    const cfg = await buildPiSessionConfig({
      sessionManager: SessionManager.inMemory(process.cwd()),
      modelProvider: 'openrouter',
      modelId: 'deepseek/deepseek-v4-flash',
      // apiKey omitted on purpose
    });
    expect(cfg.model).toBeUndefined();
    expect(cfg.authStorage).toBeUndefined();
  });

  it('honors a custom cwd', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'kshana-build-session-'));
    try {
      const cfg = await buildPiSessionConfig({
        sessionManager: SessionManager.inMemory(tmp),
        cwd: tmp,
      });
      expect(cfg.cwd).toBe(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
