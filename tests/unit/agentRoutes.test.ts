/**
 * Tests for the agent-control HTTP routes that mirror the pnpm scripts.
 *
 * Uses Fastify's `inject()` (no port bind) and a temporary projects
 * directory. The run-to runner is stubbed so we don't spin up a real
 * ExecutorAgent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerAgentRoutes, type AgentRoutesConfig } from '../../src/server/agentRoutes.js';
import { JobManager } from '../../src/server/jobManager.js';
import type { ProjectFile, ExecutorState } from '../../src/core/project/projectTypes.js';

interface TestSetup {
  app: FastifyInstance;
  basePath: string;
  jobs: JobManager;
}

function mkProjectFile(over: Partial<ProjectFile> = {}): ProjectFile {
  const nodes = (over.executorState as ExecutorState | undefined)?.nodes ?? {
    'plot': { id: 'plot', typeId: 'plot', status: 'completed', dependencies: [] },
    'story': { id: 'story', typeId: 'story', status: 'pending', dependencies: ['plot'] },
  } as ExecutorState['nodes'];
  return {
    version: '1',
    id: 'demo',
    title: 'Demo',
    style: 'cinematic_realism',
    targetDuration: 60,
    inputType: 'story',
    templateId: 'narrative',
    currentPhase: 'in_progress',
    executorState: { nodes, updatedAt: Date.now() },
    ...over,
  } as ProjectFile;
}

function writeProject(basePath: string, name: string, project: ProjectFile): string {
  const dir = join(basePath, `${name}.dhee`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2));
  return dir;
}

async function setup(over: Partial<AgentRoutesConfig> = {}): Promise<TestSetup> {
  const basePath = mkdtempSync(join(tmpdir(), 'dhee-routes-'));
  const jobs = new JobManager();
  const app = Fastify({ logger: false });
  await registerAgentRoutes(app, {
    basePath,
    jobs,
    runner: async () => ({ status: 'completed' }),
    ...over,
  });
  return { app, basePath, jobs };
}

describe('agentRoutes — pi-agent control surface', () => {
  let s: TestSetup;
  afterEach(async () => {
    if (s) {
      await s.app.close();
      rmSync(s.basePath, { recursive: true, force: true });
    }
  });

  describe('GET /api/v1/projects/:name/status', () => {
    beforeEach(async () => { s = await setup(); });

    it('returns 404 when the project does not exist', async () => {
      const res = await s.app.inject({ method: 'GET', url: '/api/v1/projects/nope/status' });
      expect(res.statusCode).toBe(404);
    });

    it('returns counts and metadata for a real project', async () => {
      writeProject(s.basePath, 'demo', mkProjectFile());
      const res = await s.app.inject({ method: 'GET', url: '/api/v1/projects/demo/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.title).toBe('Demo');
      expect(body.totalNodes).toBe(2);
      expect(body.counts.completed).toBe(1);
      expect(body.counts.pending).toBe(1);
    });
  });

  describe('GET /api/v1/projects/:name/nodes/:alias', () => {
    beforeEach(async () => { s = await setup(); });

    it('returns 404 when project missing', async () => {
      const res = await s.app.inject({ method: 'GET', url: '/api/v1/projects/x/nodes/anything' });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when the alias does not resolve', async () => {
      writeProject(s.basePath, 'demo', mkProjectFile());
      const res = await s.app.inject({ method: 'GET', url: '/api/v1/projects/demo/nodes/ghost' });
      expect(res.statusCode).toBe(404);
    });

    it('returns the node, its content, and exists flags', async () => {
      const dir = writeProject(s.basePath, 'demo', mkProjectFile({
        executorState: {
          nodes: {
            'character:elara': {
              id: 'character:elara', typeId: 'character', itemId: 'elara',
              status: 'completed', dependencies: [], outputPath: 'characters/elara.md',
            },
          },
        },
      }));
      mkdirSync(join(dir, 'characters'), { recursive: true });
      writeFileSync(join(dir, 'characters', 'elara.md'), '# Elara');
      const res = await s.app.inject({ method: 'GET', url: '/api/v1/projects/demo/nodes/character:elara' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.node.id).toBe('character:elara');
      expect(body.exists).toBe(true);
      expect(body.binary).toBe(false);
      expect(body.content).toContain('Elara');
    });
  });

  describe('POST /api/v1/projects/:name/regen', () => {
    beforeEach(async () => { s = await setup(); });

    it('returns 404 when project missing', async () => {
      const res = await s.app.inject({
        method: 'POST', url: '/api/v1/projects/x/regen',
        payload: { aliases: ['anything'] },
      });
      expect(res.statusCode).toBe(404);
    });

    it('marks node pending and persists project.json', async () => {
      const dir = writeProject(s.basePath, 'demo', mkProjectFile({
        executorState: {
          nodes: {
            'plot': {
              id: 'plot', typeId: 'plot', status: 'completed',
              dependencies: [], outputPath: 'p.md', completedAt: 1,
            },
          },
        },
      }));
      const res = await s.app.inject({
        method: 'POST', url: '/api/v1/projects/demo/regen',
        payload: { aliases: ['plot'] },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.changed).toEqual(['plot']);
      const persisted = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf-8'));
      expect(persisted.executorState.nodes.plot.status).toBe('pending');
      expect(persisted.executorState.nodes.plot.outputPath).toBeUndefined();
    });

    it('reports notFound for unresolvable aliases (200, not 400)', async () => {
      writeProject(s.basePath, 'demo', mkProjectFile());
      const res = await s.app.inject({
        method: 'POST', url: '/api/v1/projects/demo/regen',
        payload: { aliases: ['ghost'] },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).notFound).toEqual(['ghost']);
    });
  });

  describe('POST /api/v1/projects/:name/override', () => {
    beforeEach(async () => { s = await setup(); });

    it('writes content + marks node completed + persists project', async () => {
      const dir = writeProject(s.basePath, 'demo', mkProjectFile({
        executorState: {
          nodes: {
            'character:elara': {
              id: 'character:elara', typeId: 'character', itemId: 'elara',
              status: 'pending', dependencies: [], outputPath: 'characters/elara.md',
            },
          },
        },
      }));
      const res = await s.app.inject({
        method: 'POST', url: '/api/v1/projects/demo/override',
        payload: { alias: 'character:elara', content: 'Bren overrides Elara' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.outputPath).toBe('characters/elara.md');
      expect(readFileSync(join(dir, 'characters', 'elara.md'), 'utf-8')).toContain('Bren');
      const persisted = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf-8'));
      expect(persisted.executorState.nodes['character:elara'].status).toBe('completed');
    });

    it('returns 400 when neither content nor fromPath given', async () => {
      writeProject(s.basePath, 'demo', mkProjectFile());
      const res = await s.app.inject({
        method: 'POST', url: '/api/v1/projects/demo/override',
        payload: { alias: 'plot' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/projects/:name/stop', () => {
    beforeEach(async () => { s = await setup(); });

    it('writes the .executor.stop sentinel in the project dir', async () => {
      const dir = writeProject(s.basePath, 'demo', mkProjectFile());
      const res = await s.app.inject({ method: 'POST', url: '/api/v1/projects/demo/stop' });
      expect(res.statusCode).toBe(200);
      expect(existsSync(join(dir, '.executor.stop'))).toBe(true);
    });

    it('also cancels an in-flight in-process job for that project', async () => {
      writeProject(s.basePath, 'demo', mkProjectFile());
      let stopCalled = false;
      s.jobs.start('demo', {
        runFn: () => new Promise(() => {}),
        stopFn: () => { stopCalled = true; },
      });
      const res = await s.app.inject({ method: 'POST', url: '/api/v1/projects/demo/stop' });
      expect(res.statusCode).toBe(200);
      expect(stopCalled).toBe(true);
    });
  });

  describe('POST /api/v1/projects/:name/run-to', () => {
    it('returns a job id and the job appears in latestForProject', async () => {
      let resolved: () => void;
      s = await setup({
        runner: () => new Promise<{ status: 'completed' }>((res) => {
          resolved = () => res({ status: 'completed' });
        }),
      });
      writeProject(s.basePath, 'demo', mkProjectFile());
      const res = await s.app.inject({
        method: 'POST', url: '/api/v1/projects/demo/run-to',
        payload: { stage: 'final_video' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.jobId).toMatch(/^job_/);
      expect(body.status).toBe('running');
      expect(s.jobs.latestForProject('demo')!.id).toBe(body.jobId);
      resolved!();
    });

    it('returns 409 when a run is already in flight for that project', async () => {
      s = await setup({ runner: () => new Promise(() => {}) });
      writeProject(s.basePath, 'demo', mkProjectFile());
      await s.app.inject({
        method: 'POST', url: '/api/v1/projects/demo/run-to',
        payload: {},
      });
      const second = await s.app.inject({
        method: 'POST', url: '/api/v1/projects/demo/run-to',
        payload: {},
      });
      expect(second.statusCode).toBe(409);
    });

    it('returns 404 for a missing project', async () => {
      s = await setup();
      const res = await s.app.inject({
        method: 'POST', url: '/api/v1/projects/nope/run-to',
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/v1/projects/:name/run-to[/:jobId]', () => {
    it('returns the latest job for the project when no jobId given', async () => {
      s = await setup({ runner: () => Promise.resolve({ status: 'completed' as const }) });
      writeProject(s.basePath, 'demo', mkProjectFile());
      const start = await s.app.inject({
        method: 'POST', url: '/api/v1/projects/demo/run-to',
        payload: {},
      });
      const jobId = JSON.parse(start.body).jobId;
      await s.jobs.waitForCompletion(jobId);
      const res = await s.app.inject({ method: 'GET', url: '/api/v1/projects/demo/run-to' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(jobId);
      expect(body.status).toBe('completed');
    });

    it('returns the specific job when jobId is provided', async () => {
      s = await setup({ runner: () => Promise.resolve({ status: 'completed' as const }) });
      writeProject(s.basePath, 'demo', mkProjectFile());
      const start = await s.app.inject({
        method: 'POST', url: '/api/v1/projects/demo/run-to',
        payload: {},
      });
      const jobId = JSON.parse(start.body).jobId;
      await s.jobs.waitForCompletion(jobId);
      const res = await s.app.inject({ method: 'GET', url: `/api/v1/projects/demo/run-to/${jobId}` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).id).toBe(jobId);
    });

    it('returns 404 for an unknown jobId', async () => {
      s = await setup();
      const res = await s.app.inject({ method: 'GET', url: '/api/v1/projects/demo/run-to/job_doesnotexist' });
      expect(res.statusCode).toBe(404);
    });
  });
});
