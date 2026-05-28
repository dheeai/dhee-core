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

  it('gates the tool allowlist to read-only built-ins (no write / edit / bash)', async () => {
    const cfg = await buildPiSessionConfig({
      sessionManager: SessionManager.inMemory(process.cwd()),
    });

    expect(cfg.tools).toContain('read');
    expect(cfg.tools).toContain('ls');
    expect(cfg.tools).toContain('grep');
    expect(cfg.tools).toContain('find');
    expect(cfg.tools).not.toContain('write');
    expect(cfg.tools).not.toContain('edit');
    expect(cfg.tools).not.toContain('bash');
  });

  it('honors the sessionManager that was passed in', async () => {
    const sm = SessionManager.inMemory(process.cwd());
    const cfg = await buildPiSessionConfig({ sessionManager: sm });
    expect(cfg.sessionManager).toBe(sm);
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
