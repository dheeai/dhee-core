/**
 * Tests for the four read-only pi-agent tools that the chat panel hits
 * most often when a user opens a project — `status`, `listItems`,
 * `listProjects`, `readArtifact`. None of these cross the
 * pi-agent ↔ ExecutorAgent bridge: they read project state from disk
 * (project.json + executorState graph) and format text output.
 *
 * What's tested: each tool's contract — validation paths, happy-path
 * formatting, filter combinations, and a few edge cases (empty graphs,
 * bare folders, path traversal, oversized failed-node lists).
 *
 * Approach: temp `dhee_PROJECTS_DIR` per test, write project fixtures
 * with `mkdirSync`/`writeFileSync`, invoke the tool's `execute`
 * directly, assert on the response shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dheeStatus } from '../../src/agent/pi/tools/status.js';
import { dheeListItems } from '../../src/agent/pi/tools/listItems.js';
import { dheeListProjects } from '../../src/agent/pi/tools/listProjects.js';
import { dheeReadArtifact } from '../../src/agent/pi/tools/readArtifact.js';

// ── Temp project fixtures ────────────────────────────────────────────

let projectsDir: string;

function makeProject(name: string, contents: object): string {
  const projectDir = join(projectsDir, `${name}.dhee`);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, 'project.json'),
    JSON.stringify(contents, null, 2),
  );
  return projectDir;
}

function makeBareProjectDir(name: string): string {
  // Folder ends in .dhee but has no project.json — used to test the
  // "bare folder" pathway in listProjects.
  const dir = join(projectsDir, `${name}.dhee`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function executeTool(
  tool: typeof dheeStatus | typeof dheeListItems | typeof dheeListProjects | typeof dheeReadArtifact,
  params: unknown,
) {
  return tool.execute(
    'call-id-1',
    params as never,
    undefined as never,
    undefined as never,
    {} as never,
  );
}

// Minimal executorState node helpers.
function node(
  id: string,
  typeId: string,
  status: string,
  error?: string,
): unknown {
  return error ? { id, typeId, status, error } : { id, typeId, status };
}

beforeEach(() => {
  projectsDir = mkdtempSync(join(tmpdir(), 'dhee-read-tools-'));
  process.env['dhee_PROJECTS_DIR'] = projectsDir;
});

afterEach(() => {
  rmSync(projectsDir, { recursive: true, force: true });
  delete process.env['dhee_PROJECTS_DIR'];
});

// ────────────────────────────────────────────────────────────────────
// dhee_status
// ────────────────────────────────────────────────────────────────────

describe('pi-agent dhee_status', () => {
  it('returns failure when project does not exist', async () => {
    const r = await executeTool(dheeStatus, { project: 'nope' });
    expect((r.details as { status: string }).status).toBe('failed');
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(
      /Project not found/,
    );
  });

  it('returns failure when project.json is missing', async () => {
    mkdirSync(join(projectsDir, 'broken.dhee'));
    const r = await executeTool(dheeStatus, { project: 'broken' });
    expect((r.details as { status: string }).status).toBe('failed');
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(
      /project.json not found/,
    );
  });

  it('produces a summary of project metadata + node counts', async () => {
    makeProject('noir', {
      title: 'Noir Detective',
      style: 'noir',
      targetDuration: 60,
      templateId: 'narrative',
      currentPhase: 'shot_image',
      executorState: {
        nodes: {
          a: node('a', 'scene_breakdown', 'completed'),
          b: node('b', 'shot_image', 'completed'),
          c: node('c', 'shot_image', 'pending'),
          d: node('d', 'shot_video', 'failed', 'workflow timeout'),
          e: node('e', 'shot_video', 'running'),
          f: node('f', 'shot_video', 'skipped'),
        },
      },
    });
    const r = await executeTool(dheeStatus, { project: 'noir' });
    expect((r.details as { status: string }).status).toBe('completed');
    const text = (r.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/Project: Noir Detective/);
    expect(text).toMatch(/Style: noir/);
    expect(text).toMatch(/Target duration: 60s/);
    expect(text).toMatch(/Template: narrative/);
    expect(text).toMatch(/Current phase: shot_image/);
    expect(text).toMatch(/Total nodes: 6/);
    expect(text).toMatch(
      /completed=2 pending=1 failed=1 running=1 skipped=1/,
    );
  });

  it('lists failed nodes with their error messages', async () => {
    makeProject('p', {
      title: 'P',
      executorState: {
        nodes: {
          a: node('shot_image:s1_s1', 'shot_image', 'failed', 'comfy 500'),
          b: node('shot_video:s1_s2', 'shot_video', 'failed', 'oom'),
        },
      },
    });
    const r = await executeTool(dheeStatus, { project: 'p' });
    const text = (r.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/Failed nodes:/);
    expect(text).toMatch(/shot_image:s1_s1: comfy 500/);
    expect(text).toMatch(/shot_video:s1_s2: oom/);
  });

  it('truncates failed-node listing to 10 with "…and N more"', async () => {
    const nodes: Record<string, unknown> = {};
    for (let i = 0; i < 15; i++) {
      nodes[`n${i}`] = node(`shot_image:n${i}`, 'shot_image', 'failed', `err ${i}`);
    }
    makeProject('p', { title: 'P', executorState: { nodes } });
    const r = await executeTool(dheeStatus, { project: 'p' });
    const text = (r.content as Array<{ text: string }>)[0].text;
    // Top 10 are listed; 5 remaining are summarized.
    expect(text).toMatch(/shot_image:n0: err 0/);
    expect(text).toMatch(/shot_image:n9: err 9/);
    expect(text).toMatch(/…and 5 more/);
    // n10 onwards must NOT appear individually.
    expect(text).not.toMatch(/shot_image:n10:/);
  });

  it('handles a project with no executorState gracefully', async () => {
    makeProject('fresh', { title: 'Fresh' });
    const r = await executeTool(dheeStatus, { project: 'fresh' });
    expect((r.details as { status: string }).status).toBe('completed');
    const text = (r.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/Total nodes: 0/);
    expect(text).toMatch(
      /completed=0 pending=0 failed=0 running=0 skipped=0/,
    );
    // No "Failed nodes:" header when there are none.
    expect(text).not.toMatch(/Failed nodes:/);
  });
});

// ────────────────────────────────────────────────────────────────────
// dhee_list_items
// ────────────────────────────────────────────────────────────────────

describe('pi-agent dhee_list_items', () => {
  function projectWithGraph() {
    return makeProject('p', {
      title: 'P',
      executorState: {
        nodes: {
          'shot_image:s1_s1': node('shot_image:s1_s1', 'shot_image', 'completed'),
          'shot_image:s1_s2': node('shot_image:s1_s2', 'shot_image', 'pending'),
          'shot_image:s2_s1': node('shot_image:s2_s1', 'shot_image', 'failed', 'boom'),
          'shot_image:s2_s2': node('shot_image:s2_s2', 'shot_image', 'skipped'),
          'shot_video:s1_s1': node('shot_video:s1_s1', 'shot_video', 'pending'),
          'shot_video:s1_s2': node('shot_video:s1_s2', 'shot_video', 'running'),
        },
      },
    });
  }

  it('returns failure on missing project', async () => {
    const r = await executeTool(dheeListItems, { project: 'gone' });
    expect((r.details as { status: string }).status).toBe('failed');
  });

  it('returns failure on missing project.json', async () => {
    mkdirSync(join(projectsDir, 'broken.dhee'));
    const r = await executeTool(dheeListItems, { project: 'broken' });
    expect((r.details as { status: string }).status).toBe('failed');
  });

  it('lists every node sorted by id when no filters', async () => {
    projectWithGraph();
    const r = await executeTool(dheeListItems, { project: 'p' });
    const d = r.details as { total: number; matches: number; log: string };
    expect(d.total).toBe(6);
    expect(d.matches).toBe(6);
    // Sorted alphabetically by id.
    const lines = d.log.split('\n').filter((l) => l.startsWith('  '));
    expect(lines[0]).toMatch(/shot_image:s1_s1/);
    expect(lines[5]).toMatch(/shot_video:s1_s2/);
  });

  it('filters by typeId', async () => {
    projectWithGraph();
    const r = await executeTool(dheeListItems, {
      project: 'p',
      type: 'shot_video',
    });
    const d = r.details as { total: number; matches: number; log: string };
    expect(d.total).toBe(6);
    expect(d.matches).toBe(2);
    expect(d.log).toMatch(/filters: type=shot_video/);
    // Both lines must be shot_video nodes.
    const matchingLines = d.log
      .split('\n')
      .filter((l) => l.startsWith('  '))
      .filter((l) => l.trim().length > 0);
    expect(matchingLines).toHaveLength(2);
    expect(matchingLines.every((l) => l.includes('shot_video:'))).toBe(true);
  });

  it('filters by literal status (pending)', async () => {
    projectWithGraph();
    const r = await executeTool(dheeListItems, {
      project: 'p',
      status: 'pending',
    });
    const d = r.details as { matches: number };
    expect(d.matches).toBe(2); // shot_image:s1_s2 + shot_video:s1_s1
  });

  it('status=terminal includes completed | failed | skipped (NOT running, NOT pending)', async () => {
    projectWithGraph();
    const r = await executeTool(dheeListItems, {
      project: 'p',
      status: 'terminal',
    });
    const d = r.details as { matches: number; log: string };
    // 1 completed + 1 failed + 1 skipped = 3
    expect(d.matches).toBe(3);
    expect(d.log).not.toMatch(/\[running\]/);
    expect(d.log).not.toMatch(/\[pending\]/);
  });

  it('filters by grep regex against node id', async () => {
    projectWithGraph();
    const r = await executeTool(dheeListItems, {
      project: 'p',
      grep: 's1_s1',
    });
    const d = r.details as { matches: number };
    // shot_image:s1_s1 + shot_video:s1_s1 = 2
    expect(d.matches).toBe(2);
  });

  it('combines type + status + grep filters', async () => {
    projectWithGraph();
    const r = await executeTool(dheeListItems, {
      project: 'p',
      type: 'shot_image',
      status: 'pending',
      grep: 's1_',
    });
    const d = r.details as { matches: number; log: string };
    // Only shot_image:s1_s2 matches all three.
    expect(d.matches).toBe(1);
    expect(d.log).toMatch(/shot_image:s1_s2 \[pending\]/);
  });

  it('failed-node lines include the first line of the error message', async () => {
    projectWithGraph();
    const r = await executeTool(dheeListItems, {
      project: 'p',
      status: 'failed',
    });
    const d = r.details as { log: string };
    expect(d.log).toMatch(/shot_image:s2_s1 \[failed\] — boom/);
  });

  it('returns failure on invalid grep regex', async () => {
    projectWithGraph();
    const r = await executeTool(dheeListItems, {
      project: 'p',
      grep: '[invalid(',
    });
    expect((r.details as { status: string }).status).toBe('failed');
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(
      /Invalid grep regex/,
    );
  });

  it('handles empty graph (no executorState) → 0/0 matching', async () => {
    makeProject('empty', { title: 'Empty' });
    const r = await executeTool(dheeListItems, { project: 'empty' });
    const d = r.details as { total: number; matches: number };
    expect(d.total).toBe(0);
    expect(d.matches).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// dhee_list_projects
// ────────────────────────────────────────────────────────────────────

describe('pi-agent dhee_list_projects', () => {
  it('returns "no projects found" message when projects dir is empty', async () => {
    const r = await executeTool(dheeListProjects, {});
    const d = r.details as { count: number; projects: unknown[] };
    expect(d.count).toBe(0);
    expect(d.projects).toEqual([]);
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(
      /No dhee projects found/,
    );
  });

  it('lists multiple .dhee folders alphabetically with project.json metadata', async () => {
    // Create out-of-order to verify sort.
    makeProject('zeta', { title: 'Zeta' });
    makeProject('alpha', {
      title: 'Alpha story',
      style: 'cinematic_realism',
      currentPhase: 'shot_video',
      templateId: 'narrative',
    });
    makeProject('mid', { title: 'Middle One' });
    const r = await executeTool(dheeListProjects, {});
    const d = r.details as {
      count: number;
      projects: Array<{ name: string; title?: string; style?: string; phase?: string; templateId?: string; hasProjectJson: boolean }>;
    };
    expect(d.count).toBe(3);
    // Sorted by folder name.
    expect(d.projects.map((p) => p.name)).toEqual(['alpha', 'mid', 'zeta']);
    // Metadata read from project.json.
    expect(d.projects[0]).toMatchObject({
      name: 'alpha',
      title: 'Alpha story',
      style: 'cinematic_realism',
      phase: 'shot_video',
      templateId: 'narrative',
      hasProjectJson: true,
    });
    // Output text mentions each project.
    const text = (r.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/Found 3 project/);
    expect(text).toMatch(/alpha/);
    expect(text).toMatch(/style: cinematic_realism/);
  });

  it('flags bare folders (no project.json) without crashing', async () => {
    makeBareProjectDir('bare');
    makeProject('real', { title: 'Real' });
    const r = await executeTool(dheeListProjects, {});
    const d = r.details as {
      count: number;
      projects: Array<{ name: string; hasProjectJson: boolean }>;
    };
    expect(d.count).toBe(2);
    const bare = d.projects.find((p) => p.name === 'bare')!;
    expect(bare.hasProjectJson).toBe(false);
    const real = d.projects.find((p) => p.name === 'real')!;
    expect(real.hasProjectJson).toBe(true);
    // Output text marks the bare folder.
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(
      /bare \(no project.json — bare folder\)/,
    );
  });

  it('treats unparseable project.json as a bare folder (does not throw)', async () => {
    const dir = join(projectsDir, 'corrupt.dhee');
    mkdirSync(dir);
    writeFileSync(join(dir, 'project.json'), '{ NOT VALID JSON');
    const r = await executeTool(dheeListProjects, {});
    const d = r.details as {
      count: number;
      projects: Array<{ name: string; hasProjectJson: boolean }>;
    };
    expect(d.count).toBe(1);
    expect(d.projects[0]).toMatchObject({
      name: 'corrupt',
      hasProjectJson: false,
    });
  });

  it('ignores non-.dhee directories and files in projects dir', async () => {
    makeProject('keep', { title: 'Keep' });
    mkdirSync(join(projectsDir, 'random_folder')); // not .dhee
    writeFileSync(join(projectsDir, 'a-file.txt'), 'hi');
    const r = await executeTool(dheeListProjects, {});
    const d = r.details as {
      count: number;
      projects: Array<{ name: string }>;
    };
    expect(d.count).toBe(1);
    expect(d.projects[0].name).toBe('keep');
  });
});

// ────────────────────────────────────────────────────────────────────
// dhee_read_artifact
// ────────────────────────────────────────────────────────────────────

describe('pi-agent dhee_read_artifact', () => {
  it('reads a top-level file and reports the resolved path + byte count', async () => {
    const dir = makeProject('p', { title: 'P' });
    const r = await executeTool(dheeReadArtifact, {
      project: 'p',
      path: 'project.json',
    });
    const text = (r.content as Array<{ text: string }>)[0].text;
    const parsed = JSON.parse(text) as { title: string };
    expect(parsed.title).toBe('P');
    const d = r.details as { resolvedPath: string; bytes: number };
    expect(d.resolvedPath).toBe(join(dir, 'project.json'));
    expect(d.bytes).toBe(Buffer.byteLength(text, 'utf8'));
  });

  it('reads a nested file (scenes/scene_1.md)', async () => {
    const dir = makeProject('p', { title: 'P' });
    mkdirSync(join(dir, 'scenes'));
    writeFileSync(join(dir, 'scenes/scene_1.md'), '# Scene 1\nA dark alley.');
    const r = await executeTool(dheeReadArtifact, {
      project: 'p',
      path: 'scenes/scene_1.md',
    });
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(
      /A dark alley/,
    );
  });

  it('rejects relative paths that escape the project folder (../..)', async () => {
    makeProject('p', { title: 'P' });
    // Drop a sensitive file at projectsDir level so the path traversal
    // is *plausibly* meaningful even though it would also be rejected.
    writeFileSync(join(projectsDir, 'secret.txt'), 'shhh');
    await expect(
      executeTool(dheeReadArtifact, {
        project: 'p',
        path: '../secret.txt',
      }),
    ).rejects.toThrow(/resolves outside project/);
  });

  it('rejects absolute paths outside the project folder', async () => {
    makeProject('p', { title: 'P' });
    await expect(
      executeTool(dheeReadArtifact, {
        project: 'p',
        path: '/etc/passwd',
      }),
    ).rejects.toThrow(/resolves outside project/);
  });

  it('throws ENOENT-style error when target file does not exist', async () => {
    makeProject('p', { title: 'P' });
    await expect(
      executeTool(dheeReadArtifact, {
        project: 'p',
        path: 'does-not-exist.md',
      }),
    ).rejects.toThrow();
  });

  it('throws when the project folder itself is missing', async () => {
    // No makeProject call → project doesn't exist.
    await expect(
      executeTool(dheeReadArtifact, {
        project: 'ghost',
        path: 'project.json',
      }),
    ).rejects.toThrow();
  });
});
