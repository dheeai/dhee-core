/**
 * Phase 0 — RunnerRegistry.
 *
 * Test failures map to plan §3 Phase 0 failure modes 1, 2, 7, 8.
 *
 * The registry holds Runner instances keyed by their tool name. The
 * walker validates bundle dependencies against it before walking.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RunnerRegistry } from '../../src/dag/runners/registry.js';
import type { Runner, RunnerManifest } from '../../src/dag/runners/registry.js';

const stubRunner = (overrides: Partial<RunnerManifest> = {}): {
  manifest: RunnerManifest;
  runner: Runner;
} => {
  const manifest: RunnerManifest = {
    tool: 'test.stub',
    version: '1.0.0',
    engineCompat: '>=1.0.0',
    credentials: [],
    ...overrides,
  };
  const runner: Runner = {
    describe: () => ({
      id: manifest.tool,
      displayName: manifest.tool,
      description: 'stub',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    run: async () => ({ ok: true, outputPath: '/tmp/stub' }),
  };
  return { manifest, runner };
};

describe('RunnerRegistry', () => {
  let reg: RunnerRegistry;

  beforeEach(() => {
    reg = new RunnerRegistry();
  });

  it('registers and retrieves a runner by tool name', () => {
    const { manifest, runner } = stubRunner({ tool: 'llm.generate' });
    reg.register(manifest, runner);
    expect(reg.get('llm.generate')).toBe(runner);
  });

  it('returns undefined for an unregistered tool', () => {
    expect(reg.get('not.registered')).toBeUndefined();
  });

  it('lists all registered manifests', () => {
    const a = stubRunner({ tool: 'a' });
    const b = stubRunner({ tool: 'b' });
    reg.register(a.manifest, a.runner);
    reg.register(b.manifest, b.runner);
    const tools = reg.list().map((m) => m.tool).sort();
    expect(tools).toEqual(['a', 'b']);
  });

  it('warns and overwrites when the same tool is registered twice (last-wins, never silent)', () => {
    // Last-wins is the deterministic policy. The warning is the
    // non-silent part — without it, two custom runners with conflicting
    // tool ids would produce confusing behavior after one redeploys.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = stubRunner({ tool: 'dup', version: '1.0.0' });
    const second = stubRunner({ tool: 'dup', version: '2.0.0' });
    reg.register(first.manifest, first.runner);
    reg.register(second.manifest, second.runner);

    expect(reg.get('dup')).toBe(second.runner);
    expect(warn).toHaveBeenCalled();
    const warnMsg = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnMsg).toMatch(/dup/);
    warn.mockRestore();
  });

  describe('validateBundle', () => {
    it('passes when bundle has no declared runner dependencies', () => {
      const result = reg.validateBundle({
        id: 'x',
        version: '1.0.0',
        goal: 'final',
        nodes: [],
      });
      expect(result.ok).toBe(true);
    });

    it('passes when all declared dependencies are registered with satisfying versions', () => {
      const a = stubRunner({ tool: 'llm.generate', version: '0.3.1' });
      reg.register(a.manifest, a.runner);

      const result = reg.validateBundle({
        id: 'x',
        version: '1.0.0',
        goal: 'final',
        nodes: [],
        dependencies: { runners: { 'llm.generate': '>=0.1.0' } },
      });
      expect(result.ok).toBe(true);
    });

    it('fails clearly when a declared runner dependency is not registered (with install hint)', () => {
      const result = reg.validateBundle({
        id: 'x',
        version: '1.0.0',
        goal: 'final',
        nodes: [],
        dependencies: { runners: { 'runway.gen3': '>=1.0.0' } },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThan(0);
        const msg = result.errors.join('\n');
        expect(msg).toMatch(/runway\.gen3/);
        expect(msg).toMatch(/not registered|install/i);
      }
    });

    it('fails clearly when a registered runner version does not satisfy the declared range', () => {
      const a = stubRunner({ tool: 'llm.generate', version: '0.1.0' });
      reg.register(a.manifest, a.runner);

      const result = reg.validateBundle({
        id: 'x',
        version: '1.0.0',
        goal: 'final',
        nodes: [],
        dependencies: { runners: { 'llm.generate': '>=1.0.0' } },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const msg = result.errors.join('\n');
        expect(msg).toMatch(/0\.1\.0/);
        expect(msg).toMatch(/>=1\.0\.0/);
      }
    });

    it('fails when a runner requires a credential env var that is unset', () => {
      const a = stubRunner({
        tool: 'paid.api',
        version: '1.0.0',
        credentials: ['MY_API_KEY'],
      });
      reg.register(a.manifest, a.runner);

      const prev = process.env['MY_API_KEY'];
      delete process.env['MY_API_KEY'];

      try {
        const result = reg.validateBundle({
          id: 'x',
          version: '1.0.0',
          goal: 'final',
          nodes: [],
          dependencies: { runners: { 'paid.api': '>=1.0.0' } },
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          const msg = result.errors.join('\n');
          expect(msg).toMatch(/MY_API_KEY/);
          expect(msg).toMatch(/credential|missing/i);
        }
      } finally {
        if (prev !== undefined) process.env['MY_API_KEY'] = prev;
      }
    });

    it('passes when a credential env var IS set', () => {
      const a = stubRunner({
        tool: 'paid.api',
        version: '1.0.0',
        credentials: ['MY_API_KEY'],
      });
      reg.register(a.manifest, a.runner);

      const prev = process.env['MY_API_KEY'];
      process.env['MY_API_KEY'] = 'sk-fake';

      try {
        const result = reg.validateBundle({
          id: 'x',
          version: '1.0.0',
          goal: 'final',
          nodes: [],
          dependencies: { runners: { 'paid.api': '>=1.0.0' } },
        });
        expect(result.ok).toBe(true);
      } finally {
        if (prev !== undefined) process.env['MY_API_KEY'] = prev;
        else delete process.env['MY_API_KEY'];
      }
    });

    it('collects multiple errors when multiple deps are missing or wrong', () => {
      const a = stubRunner({ tool: 'llm.generate', version: '0.1.0' });
      reg.register(a.manifest, a.runner);

      const result = reg.validateBundle({
        id: 'x',
        version: '1.0.0',
        goal: 'final',
        nodes: [],
        dependencies: {
          runners: {
            'llm.generate': '>=1.0.0', // version mismatch
            'runway.gen3': '>=1.0.0',  // not registered
          },
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThanOrEqual(2);
      }
    });
  });
});
