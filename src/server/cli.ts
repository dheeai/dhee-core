#!/usr/bin/env node
/**
 * Standalone server CLI entry point.
 * Run with: npx tsx src/server/cli.ts
 */
import 'dotenv/config';
import { createServer } from './index.js';
import { getLLMConfig, getLLMProvider, validateLLMConfig } from '../core/llm/index.js';
import {
  captureAppStarted,
  registerPostHogShutdownHandlers,
  setCommonProperties,
} from './posthog.js';
import { JobManager } from './jobManager.js';
import { createExecutorRunner } from './executorRunner.js';

import type { ServerMode } from './WebSocketHandler.js';

// Parse command line arguments
function parseArgs(): {
  host: string;
  port: number;
  help: boolean;
  provider?: string;
  mode: ServerMode;
} {
  const args = process.argv.slice(2);
  let host = '127.0.0.1';
  let port = 3000;
  let help = false;
  let provider: string | undefined;
  let mode: ServerMode = 'auto';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '-h':
      case '--help':
        help = true;
        break;
      case '--host':
        host = nextArg ?? host;
        i++;
        break;
      case '--port':
      case '-p':
        port = parseInt(nextArg ?? '3000', 10);
        i++;
        break;
      case '--provider':
        provider = nextArg;
        i++;
        break;
      case '--mode':
        if (nextArg === 'local' || nextArg === 'remote' || nextArg === 'auto') {
          mode = nextArg;
        }
        i++;
        break;
    }
  }

  // Auto-detect host based on mode
  if (mode === 'remote' && host === '127.0.0.1') {
    host = '0.0.0.0';
  }

  return { host, port, help, provider, mode };
}

function printHelp(): void {
  const currentProvider = getLLMProvider();

  console.log(`
dhee-core Server - HTTP/WebSocket API for Generic Agent

Usage:
  dhee-core-server [options]

Options:
  -h, --help            Show this help message
  --host <host>         Host to bind to (default: 127.0.0.1, 0.0.0.0 in remote mode)
  -p, --port <port>     Port to listen on (default: 3000)
  --provider <name>     LLM provider: gemini, lmstudio, openai, custom
  --mode <mode>         Server mode: local, remote, auto (default: auto)
                        local  - localhost only, LocalFileSystem, no auth
                        remote - bind 0.0.0.0, require API key, RemoteClientFileSystem
                        auto   - detect based on connection source

Environment Variables:
  LLM_PROVIDER          Provider to use (current: ${currentProvider})
  See .env.example for all available configuration options.

Endpoints:
  GET  /api/v1/health           Health check
  POST /api/v1/chat             Stateless chat (single request/response)
  GET  /api/v1/sessions         List active sessions
  GET  /api/v1/sessions/:id     Get session info
  DELETE /api/v1/sessions/:id   Delete a session
  WS   /api/v1/ws/chat          WebSocket for real-time chat

WebSocket Message Types (Client -> Server):
  start_task      Start a new task: { type: "start_task", data: { task: "..." } }
  user_response   Respond to question: { type: "user_response", data: { response: "..." } }
  cancel          Cancel current task: { type: "cancel" }
  ping            Keep-alive: { type: "ping" }

WebSocket Message Types (Server -> Client):
  status          Connection/session status
  progress        Agent progress updates
  agent_response  Final agent response
  agent_question  Agent asking user a question
  tool_call       Tool execution notification
  todo_update     Todo list changes
  stream_chunk    Streaming text chunk
  error           Error message

Examples:
  dhee-core-server                    # Start server on default port
  dhee-core-server --port 8080        # Start on port 8080
  dhee-core-server --host 0.0.0.0     # Listen on all interfaces
`);
}

// Main
async function main(): Promise<void> {
  const { host, port, help, provider, mode } = parseArgs();
  const appVersion = process.env['npm_package_version'] ?? '0.1.0';
  setCommonProperties('server', appVersion);
  captureAppStarted('server');
  registerPostHogShutdownHandlers();

  if (help) {
    printHelp();
    process.exit(0);
  }

  // Set provider if specified via CLI
  if (provider) {
    process.env['LLM_PROVIDER'] = provider;
  }

  // Validate configuration
  const validation = validateLLMConfig();
  if (!validation.valid) {
    console.error('Configuration errors:');
    for (const error of validation.errors) {
      console.error(`  - ${error}`);
    }
    console.error('\nRun with --help to see available environment variables.');
    process.exit(1);
  }

  // Get LLM config
  const llmConfig = getLLMConfig();
  const maskedApiKey = llmConfig.apiKey
    ? `${llmConfig.apiKey.slice(0, 4)}...${llmConfig.apiKey.slice(-4)}`
    : '(not set)';

  console.log(`Provider: ${getLLMProvider()}`);
  console.log(`Model: ${llmConfig.model}`);
  console.log(`Base URL: ${llmConfig.baseUrl}`);
  console.log(`API Key: ${maskedApiKey}`);
  console.log(`Mode: ${mode}`);
  console.log('');

  try {
    // Wire the agent-control endpoints. JobManager serializes one
    // run-to per project; ExecutorRunner is the production runFn that
    // calls into a real ExecutorAgent.
    const jobs = new JobManager();
    const runner = createExecutorRunner();

    const server = await createServer(
      {
        llmConfig,
        serverMode: mode,
        agentRoutes: { jobs, runner },
      },
      { host, port, version: appVersion },
    );

    await server.start();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main().catch(console.error);
