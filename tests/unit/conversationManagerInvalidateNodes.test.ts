/**
 * `ConversationManager.invalidateNodes` — invoked by the desktop's
 * Prompts-tab edit flow. After the user saves a change to a per-shot
 * prompt JSON, we need to mark the dependent executor node `pending`
 * so the next pipeline run regenerates from there. The renderer drives
 * this via an IPC channel that lands in this method.
 *
 * Contract:
 *   - Loads project.json from session.sessionContext.projectDir.
 *   - Applies `applyInvalidation` over the supplied node ids.
 *   - Persists the mutated project.json back to disk.
 *   - Returns the {invalidated, notFound} split so the caller can
 *     surface partial-failure to the user.
 *   - Throws when the session is unknown, the project is unconfigured,
 *     or a task is currently running on this session (mutating the
 *     graph mid-run would race the executor).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationManager } from '../../src/server/ConversationManager.js';

let tmpRoot: string;
let originalProjectsDir: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'dhee-invalidate-nodes-'));
  originalProjectsDir = process.env['dhee_PROJECTS_DIR'];
  process.env['dhee_PROJECTS_DIR'] = tmpRoot;
});

afterEach(() => {
  if (originalProjectsDir === undefined)
    delete process.env['dhee_PROJECTS_DIR'];
  else process.env['dhee_PROJECTS_DIR'] = originalProjectsDir;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function setupProject(): { projectDir: string; projectJsonPath: string } {
  const projectDir = join(tmpRoot, 'demo.dhee');
  mkdirSync(join(projectDir, 'assets'), { recursive: true });
  const projectJsonPath = join(projectDir, 'project.json');
  writeFileSync(
    projectJsonPath,
    JSON.stringify({
      version: '3.0',
      id: 'demo',
      title: 'Demo',
      executorState: {
        nodes: {
          'shot_image:scene_1_shot_2': {
            status: 'completed',
            outputPath: 'assets/images/s1-shot-2-first.png',
            outputPaths: {
              first_frame: 'assets/images/s1-shot-2-first.png',
              last_frame: 'assets/images/s1-shot-2-last.png',
            },
            completedAt: 1234,
          },
          'shot_video:scene_1_shot_2': {
            status: 'completed',
            outputPath: 'assets/videos/s1-shot-2.mp4',
            completedAt: 5678,
          },
        },
      },
    }),
  );
  writeFileSync(
    join(projectDir, 'assets', 'manifest.json'),
    JSON.stringify({ assets: [] }),
  );
  return { projectDir, projectJsonPath };
}

interface InvalidateResult {
  invalidated: string[];
  notFound: string[];
}

interface CMWithInvalidate {
  invalidateNodes(
    sessionId: string,
    ids: string[],
    source?: string,
  ): Promise<InvalidateResult>;
  sessions: Map<
    string,
    {
      agent?: unknown;
      sessionContext?: { projectDir: string };
      initialized?: boolean;
      state?: { status: string };
    }
  >;
  scheduleSupervisorInvocation: (...args: unknown[]) => void;
}

function attachConfiguredSession(
  cm: ConversationManager,
  projectDir: string,
): string {
  const session = cm.createSession();
  const internal = (cm as unknown as CMWithInvalidate).sessions;
  const s = internal.get(session.id)!;
  s.agent = {
    async initialize() {},
    async run() {
      return { status: 'completed', output: '', todos: [] };
    },
    stop() {},
    isRunning() {
      return false;
    },
    getToolNames() {
      return [];
    },
    setAutonomousMode() {},
    on() {
      return this;
    },
    off() {
      return this;
    },
    emit() {
      return true;
    },
    removeAllListeners() {
      return this;
    },
  };
  s.sessionContext = { projectDir };
  s.initialized = true;
  return session.id;
}

function newCM(): ConversationManager {
  return new ConversationManager({
    llmConfig: { baseUrl: 'x', apiKey: 'x', model: 'x' } as never,
  });
}

describe('ConversationManager.invalidateNodes', () => {
  it('marks the target node pending and clears its outputs on disk', async () => {
    const { projectDir, projectJsonPath } = setupProject();
    const cm = newCM();
    const sessionId = attachConfiguredSession(cm, projectDir);

    const result = await (cm as unknown as CMWithInvalidate).invalidateNodes(
      sessionId,
      ['shot_image:scene_1_shot_2'],
    );

    expect(result.invalidated).toEqual(['shot_image:scene_1_shot_2']);
    expect(result.notFound).toEqual([]);

    const persisted = JSON.parse(readFileSync(projectJsonPath, 'utf-8'));
    const node = persisted.executorState.nodes['shot_image:scene_1_shot_2'];
    expect(node.status).toBe('pending');
    expect(node.outputPath).toBeUndefined();
    expect(node.outputPaths).toBeUndefined();
    expect(node.completedAt).toBeUndefined();
    expect(persisted.executorState.lastInvalidatedIds).toEqual([
      'shot_image:scene_1_shot_2',
    ]);
    // Sibling nodes are untouched.
    expect(
      persisted.executorState.nodes['shot_video:scene_1_shot_2'].status,
    ).toBe('completed');
  });

  it('reports notFound for unknown ids without throwing', async () => {
    const { projectDir, projectJsonPath } = setupProject();
    const cm = newCM();
    const sessionId = attachConfiguredSession(cm, projectDir);

    const result = await (cm as unknown as CMWithInvalidate).invalidateNodes(
      sessionId,
      ['shot_image:scene_99_shot_99'],
    );

    expect(result.invalidated).toEqual([]);
    expect(result.notFound).toEqual(['shot_image:scene_99_shot_99']);
    // Real nodes untouched.
    const persisted = JSON.parse(readFileSync(projectJsonPath, 'utf-8'));
    expect(
      persisted.executorState.nodes['shot_image:scene_1_shot_2'].status,
    ).toBe('completed');
  });

  it('throws when the session does not exist', async () => {
    const cm = newCM();
    await expect(
      (cm as unknown as CMWithInvalidate).invalidateNodes('ghost', ['x']),
    ).rejects.toThrow(/Session not found/);
  });

  it('throws when the session has no project configured', async () => {
    const cm = newCM();
    const session = cm.createSession();
    // Don't set sessionContext — simulates a fresh session before
    // configureProject / focusProject has run.
    await expect(
      (cm as unknown as CMWithInvalidate).invalidateNodes(session.id, ['x']),
    ).rejects.toThrow(/[Pp]roject/);
  });

  it('throws when project.json has no executorState (empty graph)', async () => {
    const projectDir = join(tmpRoot, 'empty.dhee');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({ version: '3.0', id: 'empty', title: 'Empty' }),
    );
    const cm = newCM();
    const sessionId = attachConfiguredSession(cm, projectDir);
    await expect(
      (cm as unknown as CMWithInvalidate).invalidateNodes(sessionId, ['x']),
    ).rejects.toThrow(/executorState/);
  });

  // Production sets sessionContext.projectDir to the project's *basename*
  // (see ConversationManager.focusSessionProject — it stores
  // `nodePath.basename(projectDirAbs)`, not the absolute path). The cases
  // above pass an absolute path to keep the assertions terse, but that
  // accidentally hid a bug where invalidateNodes joined the basename
  // straight into nodePath.join, producing a relative `<name>/project.json`
  // that ENOENT'd against CWD.
  it('resolves the project from a basename-style sessionContext (.dhee suffix)', async () => {
    const { projectJsonPath } = setupProject();
    const cm = newCM();
    // Mirror production: sessionContext.projectDir = "demo.dhee", not the abs path
    const sessionId = attachConfiguredSession(cm, 'demo.dhee');

    const result = await (cm as unknown as CMWithInvalidate).invalidateNodes(
      sessionId,
      ['shot_image:scene_1_shot_2'],
    );
    expect(result.invalidated).toEqual(['shot_image:scene_1_shot_2']);

    const persisted = JSON.parse(readFileSync(projectJsonPath, 'utf-8'));
    expect(
      persisted.executorState.nodes['shot_image:scene_1_shot_2'].status,
    ).toBe('pending');
  });

  it('resolves the project from a basename-style sessionContext (bare name, desktop convention)', async () => {
    // dhee-desktop's NewProjectDialog creates `<name>` (no suffix);
    // resolveProjectDir's probe order falls through to that.
    const projectDir = join(tmpRoot, 'Baker and the Bee');
    mkdirSync(join(projectDir, 'assets'), { recursive: true });
    const projectJsonPath = join(projectDir, 'project.json');
    writeFileSync(
      projectJsonPath,
      JSON.stringify({
        version: '3.0',
        id: 'baker',
        title: 'Baker and the Bee',
        executorState: {
          nodes: {
            'shot_video:scene_1_shot_1': {
              status: 'completed',
              outputPath: 'assets/videos/s1-shot-1.mp4',
              completedAt: 1,
            },
          },
        },
      }),
    );
    const cm = newCM();
    const sessionId = attachConfiguredSession(cm, 'Baker and the Bee');

    const result = await (cm as unknown as CMWithInvalidate).invalidateNodes(
      sessionId,
      ['shot_video:scene_1_shot_1'],
    );
    expect(result.invalidated).toEqual(['shot_video:scene_1_shot_1']);
    const persisted = JSON.parse(readFileSync(projectJsonPath, 'utf-8'));
    expect(
      persisted.executorState.nodes['shot_video:scene_1_shot_1'].status,
    ).toBe('pending');
  });

  /**
   * The 2026-05-19 Soft Seinen bug. RedoFromMenu invalidates a stage's
   * worth of nodes then calls runTask immediately. Pre-fix, both
   * messages reached pi-agent in the same turn — the `user_invalidate`
   * supervisor event ("DO NOT auto-dispatch") and the runTask
   * ("Continue running…"). Pi-agent obeyed the system rule, acked
   * "I'm paused and ready", and the runner never started. The fix:
   * when the desktop passes `source='redo_from_menu'`, skip the
   * supervisor event entirely so pi-agent only sees the unambiguous
   * resume instruction.
   */
  describe('supervisor event gating by source', () => {
    it('FIRES the supervisor user_invalidate event when source is unset (default UI invalidation)', async () => {
      const { projectDir } = setupProject();
      const cm = newCM();
      const sessionId = attachConfiguredSession(cm, projectDir);
      const calls: unknown[][] = [];
      const cmi = cm as unknown as CMWithInvalidate;
      cmi.scheduleSupervisorInvocation = (...args: unknown[]) => {
        calls.push(args);
      };

      await cmi.invalidateNodes(sessionId, ['shot_image:scene_1_shot_2']);

      const userInvalidates = calls.filter((c) => c[0] === 'user_invalidate');
      expect(userInvalidates).toHaveLength(1);
    });

    it('FIRES the supervisor event for unrelated sources (prompts_tab_save) — only redo_from_menu is special-cased', async () => {
      const { projectDir } = setupProject();
      const cm = newCM();
      const sessionId = attachConfiguredSession(cm, projectDir);
      const calls: unknown[][] = [];
      const cmi = cm as unknown as CMWithInvalidate;
      cmi.scheduleSupervisorInvocation = (...args: unknown[]) => {
        calls.push(args);
      };

      await cmi.invalidateNodes(
        sessionId,
        ['shot_image:scene_1_shot_2'],
        'prompts_tab_save',
      );

      const userInvalidates = calls.filter((c) => c[0] === 'user_invalidate');
      expect(userInvalidates).toHaveLength(1);
    });

    it('SKIPS the supervisor event when source is redo_from_menu', async () => {
      const { projectDir } = setupProject();
      const cm = newCM();
      const sessionId = attachConfiguredSession(cm, projectDir);
      const calls: unknown[][] = [];
      const cmi = cm as unknown as CMWithInvalidate;
      cmi.scheduleSupervisorInvocation = (...args: unknown[]) => {
        calls.push(args);
      };

      const result = await cmi.invalidateNodes(
        sessionId,
        ['shot_image:scene_1_shot_2'],
        'redo_from_menu',
      );

      // Invalidation itself still happens — the project.json is mutated.
      expect(result.invalidated).toEqual(['shot_image:scene_1_shot_2']);
      // But the supervisor event is suppressed so pi-agent doesn't
      // receive a "DO NOT auto-dispatch" instruction conflicting with
      // the runTask that's about to follow.
      const userInvalidates = calls.filter((c) => c[0] === 'user_invalidate');
      expect(userInvalidates).toHaveLength(0);
    });

    it('SKIPS the supervisor event for redo_from_menu even with multiple seeds', async () => {
      const { projectDir } = setupProject();
      const cm = newCM();
      const sessionId = attachConfiguredSession(cm, projectDir);
      const calls: unknown[][] = [];
      const cmi = cm as unknown as CMWithInvalidate;
      cmi.scheduleSupervisorInvocation = (...args: unknown[]) => {
        calls.push(args);
      };

      await cmi.invalidateNodes(
        sessionId,
        ['shot_image:scene_1_shot_2', 'shot_video:scene_1_shot_2'],
        'redo_from_menu',
      );

      expect(calls.filter((c) => c[0] === 'user_invalidate')).toHaveLength(0);
    });

    it('threads source through to the supervisor extra payload when fired (non-redo source)', async () => {
      const { projectDir } = setupProject();
      const cm = newCM();
      const sessionId = attachConfiguredSession(cm, projectDir);
      const calls: unknown[][] = [];
      const cmi = cm as unknown as CMWithInvalidate;
      cmi.scheduleSupervisorInvocation = (...args: unknown[]) => {
        calls.push(args);
      };

      await cmi.invalidateNodes(
        sessionId,
        ['shot_image:scene_1_shot_2'],
        'prompts_tab_save',
      );

      const extra = calls.find((c) => c[0] === 'user_invalidate')?.[2] as
        | { source?: string; seeds: string[] }
        | undefined;
      expect(extra?.source).toBe('prompts_tab_save');
      expect(extra?.seeds).toEqual(['shot_image:scene_1_shot_2']);
    });
  });
});
