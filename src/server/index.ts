/**
 * dhee-core server entry point.
 * Creates a Fastify server with HTTP and WebSocket support.
 */
import { createRequire } from 'module';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { registerRoutes, type RouteOptions } from './routes.js';
import { resetLLMLogger } from '../core/llm/index.js';
import type { ConversationManager } from './ConversationManager.js';
import type { WebSocketHandler } from './WebSocketHandler.js';
import {
  defaultDiscoveryPath,
  removeDiscoveryFile,
  writeDiscoveryFile,
} from './discovery.js';

const runtimeRequire =
  typeof require === 'function' ? require : createRequire(import.meta.url);

function createLoggerConfig() {
  try {
    runtimeRequire.resolve('pino-pretty');
    return {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
    };
  } catch {
    return {
      level: 'info',
    };
  }
}

export interface ServerConfig {
  host?: string;
  port?: number;
  cors?: {
    origin?: string | string[] | boolean;
    methods?: string[];
  };
  /**
   * Write a discovery file (`~/.dhee/server.json` by default) on
   * start so external agents (pi-agent, openclaw) can locate the
   * server without knowing the random port the desktop allocated.
   * Defaults to true; set to false for tests or when running
   * multiple servers on the same machine.
   */
  discovery?: boolean | { path?: string };
  /** Surfaced in the discovery file's `version` field. */
  version?: string;
}

export interface dheeServer {
  app: FastifyInstance;
  conversationManager: ConversationManager;
  wsHandler: WebSocketHandler;
  start: () => Promise<string>;
  stop: () => Promise<void>;
}

/**
 * Create and configure the Fastify server.
 */
export async function createServer(
  routeOptions: RouteOptions,
  serverConfig: ServerConfig = {}
): Promise<dheeServer> {
  const {
    host = '127.0.0.1',
    port = 3000,
    cors = { origin: true, methods: ['GET', 'POST', 'PUT', 'DELETE'] },
    discovery = true,
    version,
  } = serverConfig;
  const discoveryPath = typeof discovery === 'object' && discovery.path
    ? discovery.path
    : defaultDiscoveryPath();
  const discoveryEnabled = discovery !== false;

  // Reset LLM logger (creates fresh log file for this session)
  resetLLMLogger();

  // Create Fastify instance
  const app = Fastify({
    logger: createLoggerConfig(),
    bodyLimit: 50 * 1024 * 1024, // 50MB for file uploads
  });

  // Register raw body parser for file uploads
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  // Register plugins
  await app.register(fastifyCors, cors);
  await app.register(fastifyWebsocket);

  // Register routes
  const { conversationManager, wsHandler } = await registerRoutes(app, routeOptions);

  // Graceful shutdown handler
  const shutdown = async (signal?: string): Promise<void> => {
    console.log('\nShutting down...');
    if (discoveryEnabled) removeDiscoveryFile(discoveryPath);
    wsHandler.shutdown();
    conversationManager.shutdown();
    await app.close();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };

  // Handle process signals
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return {
    app,
    conversationManager,
    wsHandler,

    async start(): Promise<string> {
      const address = await app.listen({ host, port });
      console.log(`Server listening at ${address}`);
      console.log(`Web UI: ${address}`);
      console.log(`WebSocket: ws://${host}:${port}/api/v1/ws/chat`);

      if (discoveryEnabled) {
        // Resolve the actual bound port (might be random when port=0).
        const addressInfo = app.server.address();
        const boundPort = typeof addressInfo === 'object' && addressInfo
          ? addressInfo.port
          : port;
        const written = writeDiscoveryFile({
          path: discoveryPath,
          host,
          port: boundPort,
          pid: process.pid,
          mode: routeOptions.serverMode ?? 'auto',
          ...(version ? { version } : {}),
        });
        console.log(`Discovery file: ${written}`);
      }

      return address;
    },

    async stop(): Promise<void> {
      await shutdown();
    },
  };
}

// Export types and classes
export { ConversationManager, type ConversationEvents, type ConversationManagerConfig } from './ConversationManager.js';
export { WebSocketHandler } from './WebSocketHandler.js';
export { registerRoutes, type RouteOptions } from './routes.js';
export * from './types.js';
