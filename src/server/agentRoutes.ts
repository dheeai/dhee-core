/**
 * HTTP control surface for external agents (pi-agent, openclaw, etc.)
 * to drive a dhee project end-to-end without spawning child
 * processes or having Node installed on the user's machine.
 *
 * The endpoints mirror the per-script semantics:
 *   GET    /api/v1/projects/:name/status           ← pnpm status
 *   GET    /api/v1/projects/:name/nodes/:alias     ← pnpm inspect
 *   POST   /api/v1/projects/:name/run-to           ← pnpm run-to (kicks off a job, returns jobId)
 *   GET    /api/v1/projects/:name/run-to[/:jobId]  ← poll job status
 *   POST   /api/v1/projects/:name/stop             ← pnpm stop (sentinel + in-process cancel)
 *   POST   /api/v1/projects/:name/regen            ← pnpm regen
 *   POST   /api/v1/projects/:name/override         ← pnpm override
 *
 * Run-to is async: POST returns immediately with a jobId; clients poll
 * GET to learn when the run has finished. JobManager serializes runs
 * per-project (409 on duplicate) so two concurrent agents can't fight
 * over project.json.
 *
 * The actual `runner` is injected so tests can stub it. In production
 * the server bootstrap wires it to the real ExecutorAgent — see
 * `cli.ts`.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadProject, type ProjectFile } from '../core/project/projectTypes.js';
import {
  computeStatus,
  inspectNode,
  regenNodes,
  overrideNode,
  persistProject,
} from './agentOps.js';
import { JobConflictError, type JobManager, type RunFnResult, type RunTarget } from './jobManager.js';
import { writeStopFile } from '../core/planner/stopFile.js';

export interface RunnerContext {
  projectName: string;
  projectDir: string;
  project: ProjectFile;
  target: RunTarget;
  /** Set on the runner so it can register a stop hook with JobManager. */
  setStopFn?: (fn: () => void) => void;
}

/**
 * Function injected by the bootstrap that knows how to actually run
 * the executor. Returns a promise resolving with the same shape
 * ExecutorAgent produces. Tests stub this; production wires it to
 * a real ExecutorAgent.
 */
export type AgentRunner = (ctx: RunnerContext) => Promise<RunFnResult>;

export interface AgentRoutesConfig {
  /** Base path where `<name>.dhee/` directories live. Defaults to cwd. */
  basePath?: string;
  jobs: JobManager;
  runner: AgentRunner;
  /** API prefix; defaults to `/api/v1`. */
  apiPrefix?: string;
}

interface ProjectParams { name: string }
interface NodeParams extends ProjectParams { alias: string }
interface JobParams extends ProjectParams { jobId: string }

interface RunToBody {
  stage?: string;
  nodeId?: string;
  skipMedia?: boolean;
}

interface RegenBody {
  aliases: string[];
  cascade?: boolean;
}

interface OverrideBody {
  alias: string;
  content?: string;
  /** Absolute path to a file whose contents to use; mirrors `--from` flag. */
  fromPath?: string;
}

export async function registerAgentRoutes(
  app: FastifyInstance,
  config: AgentRoutesConfig,
): Promise<void> {
  const basePath = config.basePath ?? process.cwd();
  const prefix = config.apiPrefix ?? '/api/v1';
  const { jobs, runner } = config;

  const loadOrNotFound = (name: string, reply: FastifyReply) => {
    const result = loadProject(name, basePath);
    if (!result) {
      reply.status(404).send({ error: 'Project not found', name });
      return null;
    }
    return result;
  };

  app.get<{ Params: ProjectParams }>(
    `${prefix}/projects/:name/status`,
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply: FastifyReply) => {
      const loaded = loadOrNotFound(request.params.name, reply);
      if (!loaded) return;
      return reply.send(computeStatus(loaded.project));
    },
  );

  app.get<{ Params: NodeParams }>(
    `${prefix}/projects/:name/nodes/:alias`,
    async (request: FastifyRequest<{ Params: NodeParams }>, reply: FastifyReply) => {
      const { name, alias } = request.params;
      const loaded = loadOrNotFound(name, reply);
      if (!loaded) return;
      try {
        return reply.send(inspectNode(loaded.project, loaded.projectDir, alias));
      } catch (err) {
        return reply.status(404).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: ProjectParams; Body: RegenBody }>(
    `${prefix}/projects/:name/regen`,
    async (request: FastifyRequest<{ Params: ProjectParams; Body: RegenBody }>, reply: FastifyReply) => {
      const loaded = loadOrNotFound(request.params.name, reply);
      if (!loaded) return;
      const body = request.body ?? { aliases: [] as string[] };
      if (!Array.isArray(body.aliases) || body.aliases.length === 0) {
        return reply.status(400).send({ error: 'Body must include `aliases: string[]`.' });
      }
      try {
        const result = regenNodes(loaded.project, body.aliases, { cascade: body.cascade === true });
        persistProject(loaded.projectDir, loaded.project);
        return reply.send(result);
      } catch (err) {
        return reply.status(409).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: ProjectParams; Body: OverrideBody }>(
    `${prefix}/projects/:name/override`,
    async (request: FastifyRequest<{ Params: ProjectParams; Body: OverrideBody }>, reply: FastifyReply) => {
      const loaded = loadOrNotFound(request.params.name, reply);
      if (!loaded) return;
      const body = request.body ?? ({} as OverrideBody);
      if (!body.alias) return reply.status(400).send({ error: 'Body must include `alias`.' });
      let content: string | undefined = body.content;
      if (content === undefined && body.fromPath) {
        if (!existsSync(body.fromPath)) {
          return reply.status(400).send({ error: `fromPath does not exist: ${body.fromPath}` });
        }
        content = readFileSync(body.fromPath, 'utf-8');
      }
      if (content === undefined) {
        return reply.status(400).send({ error: 'Body must include `content` or `fromPath`.' });
      }
      try {
        const result = overrideNode({
          project: loaded.project,
          projectDir: loaded.projectDir,
          alias: body.alias,
          content,
        });
        persistProject(loaded.projectDir, loaded.project);
        return reply.send(result);
      } catch (err) {
        return reply.status(404).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: ProjectParams }>(
    `${prefix}/projects/:name/stop`,
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply: FastifyReply) => {
      const loaded = loadOrNotFound(request.params.name, reply);
      if (!loaded) return;
      writeStopFile(loaded.projectDir);

      const inFlight = jobs.latestForProject(request.params.name);
      if (inFlight && inFlight.status === 'running') jobs.cancel(inFlight.id);

      return reply.send({
        status: 'stop_signaled',
        sentinel: join(loaded.projectDir, '.executor.stop'),
        ...(inFlight ? { cancelledJobId: inFlight.id } : {}),
      });
    },
  );

  app.post<{ Params: ProjectParams; Body: RunToBody }>(
    `${prefix}/projects/:name/run-to`,
    async (request: FastifyRequest<{ Params: ProjectParams; Body: RunToBody }>, reply: FastifyReply) => {
      const { name } = request.params;
      const loaded = loadOrNotFound(name, reply);
      if (!loaded) return;

      const body = request.body ?? {};
      const target: RunTarget = {
        ...(body.stage !== undefined ? { stage: body.stage } : {}),
        ...(body.nodeId !== undefined ? { nodeId: body.nodeId } : {}),
        ...(body.skipMedia !== undefined ? { skipMedia: body.skipMedia } : {}),
      };

      let stopFn: (() => void) | undefined;
      const ctx: RunnerContext = {
        projectName: name,
        projectDir: loaded.projectDir,
        project: loaded.project,
        target,
        setStopFn: (fn) => { stopFn = fn; },
      };

      try {
        const job = jobs.start(name, {
          runFn: () => runner(ctx),
          target,
          ...(stopFn ? { stopFn } : {}),
        });
        return reply.send({ jobId: job.id, status: job.status, target: job.target });
      } catch (err) {
        if (err instanceof JobConflictError) {
          return reply.status(409).send({
            error: err.message,
            existingJobId: err.existingJobId,
          });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: ProjectParams }>(
    `${prefix}/projects/:name/run-to`,
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply: FastifyReply) => {
      const job = jobs.latestForProject(request.params.name);
      if (!job) return reply.status(404).send({ error: 'No runs for this project' });
      return reply.send(job);
    },
  );

  app.get<{ Params: JobParams }>(
    `${prefix}/projects/:name/run-to/:jobId`,
    async (request: FastifyRequest<{ Params: JobParams }>, reply: FastifyReply) => {
      const job = jobs.get(request.params.jobId);
      if (!job) return reply.status(404).send({ error: 'Job not found', jobId: request.params.jobId });
      return reply.send(job);
    },
  );
}
