/**
 * HTTP and WebSocket routes for dhee-core server.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { ConversationManager } from './ConversationManager.js';
import { WebSocketHandler } from './WebSocketHandler.js';
import { atomicWriteFileSync } from '../utils/atomicWrite.js';
import { registerWebUIRoutes } from './webui-routes.js';
import type { LLMClientConfig } from '../core/llm/index.js';
import { getProviderRegistry } from '../services/providers/index.js';

interface ChatRequestBody {
  task: string;
  options?: {
    maxIterations?: number;
    temperature?: number;
  };
}

interface ChatResponse {
  sessionId: string;
  output: string;
  status: string;
  todos?: unknown[];
}

import type { ServerMode } from './WebSocketHandler.js';
import { ApiKeyAuth } from './auth.js';
import { registerAgentRoutes } from './agentRoutes.js';
import type { JobManager } from './jobManager.js';
import type { AgentRunner } from './agentRoutes.js';

export interface RouteOptions {
  llmConfig: LLMClientConfig;
  apiPrefix?: string;
  serverMode?: ServerMode;
  /**
   * Wire up the agent-control endpoints (run-to, status, regen,
   * override, stop, inspect). Required for pi-agent and other
   * external agents to drive the project pipeline over HTTP.
   * Omit only for tests/contexts where you want the legacy
   * surface only.
   */
  agentRoutes?: {
    jobs: JobManager;
    runner: AgentRunner;
    /** Defaults to process.cwd(). */
    basePath?: string;
  };
}

/**
 * Register all routes on the Fastify instance.
 */
export async function registerRoutes(
  app: FastifyInstance,
  options: RouteOptions
): Promise<{ conversationManager: ConversationManager; wsHandler: WebSocketHandler }> {
  const { llmConfig, apiPrefix = '/api/v1', serverMode = 'auto' } = options;

  // Create conversation manager (agent configured lazily per-project)
  const conversationManager = new ConversationManager({
    llmConfig,
    sessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
    maxIterations: 50,
  });

  // Set up auth for remote mode
  const auth = serverMode === 'local' ? null : new ApiKeyAuth();

  // Create WebSocket handler with mode and auth
  const wsHandler = new WebSocketHandler(conversationManager, { serverMode, auth: auth ?? undefined });

  // Health check endpoint
  app.get(`${apiPrefix}/health`, async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      status: 'ok',
      timestamp: Date.now(),
      sessions: conversationManager.getActiveSessions().length,
    });
  });

  // Simple stateless chat endpoint (creates session, runs task, returns result)
  app.post<{ Body: ChatRequestBody }>(
    `${apiPrefix}/chat`,
    {
      schema: {
        body: {
          type: 'object',
          required: ['task'],
          properties: {
            task: { type: 'string' },
            options: {
              type: 'object',
              properties: {
                maxIterations: { type: 'number' },
                temperature: { type: 'number' },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: ChatRequestBody }>, reply: FastifyReply) => {
      const { task } = request.body;

      // Create a temporary session
      const session = conversationManager.createSession();

      try {
        const result = await conversationManager.runTask(session.id, task);

        const response: ChatResponse = {
          sessionId: session.id,
          output: result.output,
          status: result.status,
          todos: result.todos,
        };

        // If completed, clean up the session
        if (result.status === 'completed' || result.status === 'error') {
          conversationManager.deleteSession(session.id);
        }

        return reply.send(response);
      } catch (error) {
        // Clean up session on error
        conversationManager.deleteSession(session.id);

        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(500).send({
          error: 'Task execution failed',
          message: errorMessage,
        });
      }
    }
  );

  // Get session info
  app.get<{ Params: { sessionId: string } }>(
    `${apiPrefix}/sessions/:sessionId`,
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const { sessionId } = request.params;
      const session = conversationManager.getSession(sessionId);

      if (!session) {
        return reply.status(404).send({
          error: 'Session not found',
          sessionId,
        });
      }

      conversationManager.touchSession(sessionId);
      const timerState = conversationManager.getSessionTimerState(sessionId);
      return reply.send({
        ...session,
        configured: conversationManager.isSessionConfigured(sessionId),
        ...(timerState ?? {}),
      });
    }
  );

  // List all sessions
  app.get(`${apiPrefix}/sessions`, async (_request: FastifyRequest, reply: FastifyReply) => {
    const sessions = conversationManager.getActiveSessions();
    return reply.send({
      sessions,
      count: sessions.length,
    });
  });

  // Delete a session
  app.delete<{ Params: { sessionId: string } }>(
    `${apiPrefix}/sessions/:sessionId`,
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const { sessionId } = request.params;
      const deleted = conversationManager.deleteSession(sessionId);

      if (!deleted) {
        return reply.status(404).send({
          error: 'Session not found',
          sessionId,
        });
      }

      return reply.send({
        status: 'deleted',
        sessionId,
      });
    }
  );

  // Provider listing endpoint
  app.get(`${apiPrefix}/providers`, async (_request: FastifyRequest, reply: FastifyReply) => {
    const registry = getProviderRegistry();
    const providers = registry.listProviders();
    const config = registry.getConfig();

    // Group providers by capability
    const byCapability = {
      imageGeneration: providers
        .filter(p => p.capabilities.includes('image_generation'))
        .map(p => ({ id: p.id, name: p.displayName, available: p.available })),
      imageEditing: providers
        .filter(p => p.capabilities.includes('image_editing'))
        .map(p => ({ id: p.id, name: p.displayName, available: p.available })),
      videoGeneration: providers
        .filter(p => p.capabilities.includes('video_generation'))
        .map(p => ({ id: p.id, name: p.displayName, available: p.available })),
    };

    return reply.send({
      providers: byCapability,
      currentConfig: config,
    });
  });

  // Update provider configuration
  app.post(`${apiPrefix}/providers/config`, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      imageGeneration?: string;
      imageEditing?: string;
      videoGeneration?: string;
    };
    const registry = getProviderRegistry();
    registry.setConfig(body);
    return reply.send({ status: 'ok', config: registry.getConfig() });
  });

  // ── Workflow management endpoints ──────────────────────────────────────────
  //
  // NOTE: these endpoints serve the legacy dhee-core frontend
  // (`frontend/src/components/WorkflowManager.tsx`). The same
  // operations are also available as pi-agent tools and as direct
  // function calls via `dhee-core/manager` — see
  // `src/services/comfyui/workflowIntegration.ts` for the canonical
  // helpers. New consumers (dhee-desktop) call those helpers
  // directly. When this file gets refactored, replace the inline
  // file IO + LLM-router logic below with calls to:
  //   - validateWorkflowFile / analyzeWorkflowFile (upload)
  //   - saveWorkflow (configure)
  //   - listWorkflows / getWorkflow (list / get)
  //   - updateWorkflow (override / deactivate / defaults)
  //   - deleteWorkflow (delete)

  // List all workflows grouped by pipeline
  app.get(`${apiPrefix}/workflows`, async (_request: FastifyRequest, reply: FastifyReply) => {
    const { getWorkflowModeRegistry } = await import('../services/providers/WorkflowModeRegistry.js');
    const registry = getWorkflowModeRegistry();
    // Only show ComfyUI workflows — API provider modes belong in Provider Settings
    // Filter out API provider modes (Google, xAI) but keep API-format ComfyUI workflows
    const all = registry.listAll().filter(m => m.workflowFile);

    const grouped: Record<string, typeof all> = {};
    for (const mode of all) {
      const key = mode.pipeline;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(mode);
    }

    return reply.send({ workflows: grouped });
  });

  // Upload a workflow JSON — returns parsed nodes + LLM analysis for the integration wizard
  app.post(`${apiPrefix}/workflows/upload`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { parseWorkflow, analyzeWorkflowWithLLM } = await import('../services/comfyui/WorkflowParser.js');
    const body = request.body as { filename: string; content: string };
    if (!body.content) {
      return reply.status(400).send({ error: 'Missing workflow content' });
    }

    try {
      const parsed = parseWorkflow(body.content);

      // Save the workflow JSON to workflows/user/
      const fs = await import('fs');
      const path = await import('path');
      const userDir = path.join(process.cwd(), 'workflows', 'user');
      if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

      const baseName = (body.filename || 'workflow').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/\.json$/, '');
      // Append short timestamp to avoid collisions between different workflows with same filename
      let safeName = baseName;
      let filePath = path.join(userDir, `${safeName}.json`);
      if (fs.existsSync(filePath)) {
        safeName = `${baseName}_${Date.now().toString(36)}`;
        filePath = path.join(userDir, `${safeName}.json`);
      }
      atomicWriteFileSync(filePath, body.content);

      // Run LLM analysis for intelligent suggestions
      let analysis = null;
      try {
        const { LLMClient, buildRouterFromEnv } = await import('../core/llm/index.js');
        const router = buildRouterFromEnv(process.cwd());
        const llmClient = router.isEnabled()
          ? router.getClient('structured.workflow_analysis')
          : new LLMClient(llmConfig);
        analysis = await analyzeWorkflowWithLLM(body.content, parsed, llmClient);

        // Merge LLM suggestions into parsed nodes
        if (analysis.suggestedMappings) {
          for (const suggestion of analysis.suggestedMappings) {
            const node = parsed.inputNodes.find(n => n.nodeId === suggestion.nodeId);
            if (node) {
              node.suggestedInput = suggestion.suggestedInput;
            }
          }
        }

        // Override pipeline detection if LLM is more confident
        if (analysis.pipeline && parsed.detectedPipeline === 'unknown') {
          parsed.detectedPipeline = analysis.pipeline as any;
        }
      } catch (llmErr) {
        // LLM analysis failed — non-fatal, wizard still works with heuristic suggestions
        console.warn('[WorkflowUpload] LLM analysis failed:', llmErr);
      }

      return reply.send({
        status: 'uploaded',
        filename: `${safeName}.json`,
        parsed,
        analysis,
      });
    } catch (err) {
      return reply.status(400).send({ error: `Failed to parse workflow: ${err}` });
    }
  });

  // Re-parse an existing workflow file (for editing an already-configured workflow)
  app.post(`${apiPrefix}/workflows/reparse`, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { workflowFile?: string };
    if (!body.workflowFile) {
      return reply.status(400).send({ error: 'Missing workflowFile' });
    }

    const fs = await import('fs');
    const path = await import('path');

    // Search for the workflow file in user and built-in directories
    const searchDirs = ['workflows/user', 'workflows/built-in', 'workflows'];
    let content: string | null = null;
    for (const dir of searchDirs) {
      const filePath = path.join(process.cwd(), dir, body.workflowFile);
      if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, 'utf-8');
        break;
      }
    }

    if (!content) {
      return reply.status(404).send({ error: `Workflow file not found: ${body.workflowFile}` });
    }

    try {
      const { parseWorkflow: parse } = await import('../services/comfyui/WorkflowParser.js');
      const parsed = parse(content);
      return reply.send({ parsed });
    } catch (err) {
      return reply.status(400).send({ error: `Failed to parse workflow: ${err}` });
    }
  });

  // Save manifest (configure) for an uploaded workflow
  app.post(`${apiPrefix}/workflows/configure`, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown>;
    if (!body['id'] || !body['workflowFile']) {
      return reply.status(400).send({ error: 'Missing id or workflowFile' });
    }

    const id = String(body['id']);

    // Reject IDs that conflict with built-in workflows
    const { getWorkflowModeRegistry } = await import('../services/providers/WorkflowModeRegistry.js');
    const registry = getWorkflowModeRegistry();
    if (registry.isBuiltInId(id)) {
      return reply.status(409).send({ error: `ID '${id}' conflicts with a built-in workflow. Choose a different ID.` });
    }

    const fs = await import('fs');
    const path = await import('path');
    const userDir = path.join(process.cwd(), 'workflows', 'user');
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

    const manifestPath = path.join(userDir, `${id}.manifest.json`);
    atomicWriteFileSync(manifestPath, JSON.stringify(body, null, 2));

    // Refresh registry
    registry.refresh();

    return reply.send({ status: 'configured', manifestPath });
  });

  // Set a workflow as the active override for its pipeline
  app.put(`${apiPrefix}/workflows/:id/override`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { getWorkflowModeRegistry } = await import('../services/providers/WorkflowModeRegistry.js');
    const registry = getWorkflowModeRegistry();
    const success = registry.setOverride(id);
    if (!success) return reply.status(404).send({ error: 'Workflow not found or is built-in' });
    return reply.send({ status: 'ok', activeOverride: id });
  });

  // Deactivate a specific user workflow
  app.put(`${apiPrefix}/workflows/:id/deactivate`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { getWorkflowModeRegistry } = await import('../services/providers/WorkflowModeRegistry.js');
    const registry = getWorkflowModeRegistry();
    const mode = registry.getMode(id);
    if (!mode) return reply.status(404).send({ error: 'Workflow not found' });
    registry.clearOverride(mode.pipeline, id);
    return reply.send({ status: 'ok', deactivated: id });
  });

  // Clear override for a pipeline (revert to built-in) — legacy endpoint
  app.delete(`${apiPrefix}/workflows/override/:pipeline`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { pipeline } = request.params as { pipeline: string };
    const { getWorkflowModeRegistry } = await import('../services/providers/WorkflowModeRegistry.js');
    getWorkflowModeRegistry().clearOverride(pipeline as any);
    return reply.send({ status: 'ok', reverted: pipeline });
  });

  // Delete a user-uploaded workflow
  app.delete(`${apiPrefix}/workflows/:id`, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { getWorkflowModeRegistry } = await import('../services/providers/WorkflowModeRegistry.js');
    const registry = getWorkflowModeRegistry();
    const mode = registry.getMode(id);
    if (!mode) return reply.status(404).send({ error: 'Workflow not found' });
    if (mode.builtIn) return reply.status(403).send({ error: 'Cannot delete built-in workflows' });

    // Remove files
    const fs = await import('fs');
    const path = await import('path');
    const userDir = path.join(process.cwd(), 'workflows', 'user');
    try {
      const manifestPath = path.join(userDir, `${id}.manifest.json`);
      if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
      if (mode.workflowFile) {
        const wfPath = path.join(userDir, mode.workflowFile);
        if (fs.existsSync(wfPath)) fs.unlinkSync(wfPath);
      }
    } catch { /* best effort */ }

    registry.removeMode(id);
    return reply.send({ status: 'deleted', id });
  });

  // ── Workflow test endpoint ────────────────────────────────────────────────

  // Track running tests: promptId → { status, outputPath, error }
  const testResults = new Map<string, { status: string; outputPath?: string; outputUrl?: string; error?: string; message?: string; percentage?: number }>();

  app.post(`${apiPrefix}/workflows/test`, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { workflowId: string; params: Record<string, string> };
    if (!body.workflowId || !body.params) {
      return reply.status(400).send({ error: 'Missing workflowId or params' });
    }

    try {
      const { getWorkflowModeRegistry } = await import('../services/providers/WorkflowModeRegistry.js');
      const registry = getWorkflowModeRegistry();
      const mode = registry.getMode(body.workflowId);
      if (!mode) {
        return reply.status(404).send({ error: `Workflow '${body.workflowId}' not found` });
      }

      const workflowPath = registry.getWorkflowPath(mode);
      if (!workflowPath) {
        return reply.status(404).send({ error: `Workflow file not found for '${body.workflowId}'` });
      }

      // Load and parameterize workflow
      const { parameterizeGeneric } = await import('../services/comfyui/WorkflowLoader.js');
      const { ComfyUIClient } = await import('../services/comfyui/ComfyUIClient.js');
      const fs = await import('fs');
      const path = await import('path');

      const outputDir = path.join(process.cwd(), 'test-output', 'workflow-tests');
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

      // Upload image files to ComfyUI if needed
      const client = new ComfyUIClient({ outputDir });
      const resolvedParams: Record<string, unknown> = { ...body.params };

      for (const req of mode.inputRequirements) {
        if (req.type === 'image' && body.params[req.id]) {
          const imgPath = body.params[req.id]!;
          if (fs.existsSync(imgPath)) {
            const uploaded = await client.uploadImage(imgPath);
            resolvedParams[req.id] = uploaded.name;
          }
        }
      }

      // Randomize seed if not provided or default
      if (!resolvedParams['seed'] || resolvedParams['seed'] === '0') {
        resolvedParams['seed'] = Math.floor(Math.random() * 999999);
      }

      // Load workflow directly from the resolved path (works for both built-in and user workflows)
      const templateContent = fs.readFileSync(workflowPath, 'utf-8');
      const template = JSON.parse(templateContent);
      const workflow = parameterizeGeneric(template, mode, resolvedParams);

      // Queue workflow
      const result = await client.queueWorkflow(workflow, undefined, true);
      const promptId = result.promptId;

      // Track this test
      testResults.set(promptId, { status: 'running', message: 'Queued...', percentage: 5 });

      // Wait for completion in background
      (async () => {
        try {
          await client.waitForCompletionWS(promptId, result.clientId, (info) => {
            testResults.set(promptId, {
              status: 'running',
              message: info.message,
              percentage: info.percentage,
            });
          });

          const outputs = await client.getOutputImages(promptId);
          if (outputs.length === 0) {
            testResults.set(promptId, { status: 'error', error: 'No output files from ComfyUI' });
            return;
          }

          const savedPath = await client.downloadImage(
            outputs[0]!.filename,
            outputs[0]!.subfolder,
            outputs[0]!.type,
            `test_${Date.now()}_${outputs[0]!.filename}`,
          );

          // Make it accessible via URL
          const relPath = path.relative(process.cwd(), savedPath);
          testResults.set(promptId, {
            status: 'completed',
            outputPath: savedPath,
            outputUrl: `/api/v1/test-output/${path.basename(savedPath)}`,
            percentage: 100,
          });
        } catch (err) {
          testResults.set(promptId, { status: 'error', error: String(err) });
        }
      })();

      return reply.send({ status: 'queued', promptId });
    } catch (err) {
      return reply.status(500).send({ error: `Test failed: ${err}` });
    }
  });

  // Poll test status
  app.get<{ Params: { promptId: string } }>(
    `${apiPrefix}/workflows/test/:promptId/status`,
    async (request: FastifyRequest<{ Params: { promptId: string } }>, reply: FastifyReply) => {
      const { promptId } = request.params;
      const result = testResults.get(promptId);
      if (!result) return reply.status(404).send({ error: 'Test not found' });
      return reply.send(result);
    },
  );

  // Serve test output files
  app.get<{ Params: { '*': string } }>(
    `${apiPrefix}/test-output/*`,
    async (request: FastifyRequest<{ Params: { '*': string } }>, reply: FastifyReply) => {
      const filePath = request.params['*'];
      if (filePath.includes('..')) return reply.status(400).send({ error: 'Invalid path' });
      const { join, extname } = await import('path');
      const { existsSync, readFileSync, statSync } = await import('fs');
      const fullPath = join(process.cwd(), 'test-output', 'workflow-tests', filePath);
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
        return reply.status(404).send({ error: 'Not found' });
      }
      const ext = extname(fullPath).toLowerCase();
      const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm' };
      return reply.type(MIME[ext] || 'application/octet-stream').send(readFileSync(fullPath));
    },
  );

  // Register web UI routes (SPA + project/asset endpoints)
  await registerWebUIRoutes(app);

  // Register agent-control routes (pi-agent, openclaw, etc.) when wired.
  if (options.agentRoutes) {
    await registerAgentRoutes(app, {
      apiPrefix,
      jobs: options.agentRoutes.jobs,
      runner: options.agentRoutes.runner,
      ...(options.agentRoutes.basePath !== undefined ? { basePath: options.agentRoutes.basePath } : {}),
    });
  }

  // WebSocket endpoint for real-time communication
  app.get(
    `${apiPrefix}/ws/chat`,
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest) => {
      // Extract API key and optional sessionId from query string
      const url = new URL(request.url, `http://${request.hostname}`);
      const apiKey = url.searchParams.get('apiKey') ?? undefined;
      const resumeSessionId =
        url.searchParams.get('sessionId') ??
        url.searchParams.get('session_id') ??
        undefined;
      const desktopCapabilities = {
        desktopAssembly: url.searchParams.get('desktop_assembly') === '1',
        desktopRemotion: url.searchParams.get('desktop_remotion') === '1',
        desktopVersion: url.searchParams.get('desktop_version') ?? undefined,
      };
      const remoteAddress = request.ip;
      wsHandler.handleConnection(
        socket,
        remoteAddress,
        apiKey,
        resumeSessionId,
        desktopCapabilities,
      );
    }
  );

  return { conversationManager, wsHandler };
}
