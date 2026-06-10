/**
 * dhee system-prompt delivery tests.
 *
 * Regression guard for the bug where SKILL.md never reached the model:
 * pi-coding-agent 0.70.6 only lists a loaded skill (name/description/
 * path) when the `read` builtin is allowlisted, and dhee removed that
 * builtin — so the agent silently ran on pi's stock "expert coding
 * assistant" prompt. The fix delivers the SKILL.md body directly via
 * `DefaultResourceLoader({ systemPromptOverride })`.
 *
 * These exercise the real wiring (the pure transform, the package
 * resource loader after reload, and a booted session's final
 * systemPrompt) — never a string match against source files.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@mariozechner/pi-coding-agent';
import { buildPiSessionConfig, buildPiSession } from '../../src/agent/pi/buildSession.js';
import {
  extractDheeSystemPrompt,
  getDheeSystemPrompt,
} from '../../src/agent/pi/dheeSystemPrompt.js';

/** The opening line of pi's stock default prompt — must NOT survive. */
const PI_DEFAULT_MARKER = 'expert coding assistant operating inside pi';

describe('extractDheeSystemPrompt', () => {
  it('strips YAML frontmatter and returns the body', () => {
    const raw = '---\nname: dhee\ndescription: x\n---\n\n# You are dhee\n\nbody text';
    const body = extractDheeSystemPrompt(raw);
    expect(body.startsWith('---')).toBe(false);
    expect(body).not.toContain('description: x');
    expect(body).toContain('# You are dhee');
    expect(body).toContain('body text');
  });

  it('throws when the body is empty after stripping frontmatter', () => {
    expect(() => extractDheeSystemPrompt('---\nname: dhee\ndescription: x\n---\n')).toThrow(
      /empty/i,
    );
  });
});

describe('getDheeSystemPrompt', () => {
  it('returns the packaged dhee prompt body (identity present, frontmatter gone)', () => {
    const prompt = getDheeSystemPrompt();
    expect(prompt.startsWith('---')).toBe(false);
    // Frontmatter key/value must not leak into the delivered prompt.
    expect(prompt).not.toMatch(/^name:\s*dhee/m);
    // Identity + at least one hard safety rule must be present.
    expect(prompt).toContain('You are **dhee**');
    expect(prompt).toContain('runOnly=[bareNodeId]');
    expect(prompt).toContain('scenes_plan');
  });
});

describe('buildPiSessionConfig — system prompt delivery', () => {
  it('wires the dhee prompt as the resource loader system prompt (not pi default)', async () => {
    const cfg = await buildPiSessionConfig({
      sessionManager: SessionManager.inMemory(process.cwd()),
    });
    expect(cfg.resourceLoader).toBeDefined();
    const loaderPrompt = cfg.resourceLoader!.getSystemPrompt();
    expect(loaderPrompt).toBeDefined();
    expect(loaderPrompt).toContain('You are **dhee**');
    expect(loaderPrompt).not.toContain(PI_DEFAULT_MARKER);
    // It is exactly the SKILL.md body we ship.
    expect(loaderPrompt).toBe(getDheeSystemPrompt());
  });
});

describe('buildPiSession — final delivered systemPrompt', () => {
  it('a booted session sees the dhee prompt, never pi\'s default', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dhee-sysprompt-'));
    let session: { systemPrompt: string; dispose?: () => void } | undefined;
    try {
      const built = await buildPiSession({
        sessionManager: SessionManager.inMemory(tmp),
        cwd: tmp,
        modelProvider: 'openai',
        modelId: 'gpt-4o-mini',
        apiKey: 'sk-test-not-used',
      });
      session = built.session as unknown as { systemPrompt: string; dispose?: () => void };
      const sp = session.systemPrompt;
      // The identity + safety rules the model must always see.
      expect(sp).toContain('You are **dhee**');
      expect(sp).toContain('Never mention "pi"');
      expect(sp).toContain('runOnly=[bareNodeId]');
      expect(sp).toContain('Two kinds of by-design pause');
      // The bug signature: pi's stock prompt must be gone.
      expect(sp).not.toContain(PI_DEFAULT_MARKER);
    } finally {
      session?.dispose?.();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
