#!/usr/bin/env node
/**
 * Simple WebSocket test client for dhee-core server.
 * Run with: npx tsx src/server/testClient.ts
 */
import WebSocket from 'ws';
import * as readline from 'readline';

const WS_URL = process.argv[2] || 'ws://127.0.0.1:3000/api/v1/ws/chat';

interface ServerMessage {
  type: string;
  sessionId: string;
  timestamp: number;
  data: unknown;
}

class TestClient {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  connect(): void {
    console.log(`Connecting to ${WS_URL}...`);
    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      console.log('Connected!');
      this.prompt();
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('close', () => {
      console.log('Disconnected');
      process.exit(0);
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      process.exit(1);
    });
  }

  private handleMessage(raw: string): void {
    try {
      const msg: ServerMessage = JSON.parse(raw);
      this.sessionId = msg.sessionId;

      switch (msg.type) {
        case 'status':
          console.log(`\n[STATUS] ${(msg.data as { status: string; message?: string }).status}: ${(msg.data as { message?: string }).message || ''}`);
          break;

        case 'progress':
          const progress = msg.data as { iteration: number; maxIterations: number };
          console.log(`[PROGRESS] Iteration ${progress.iteration}/${progress.maxIterations}`);
          break;

        case 'stream_chunk':
          const chunk = msg.data as { content: string };
          process.stdout.write(chunk.content);
          break;

        case 'tool_call':
          const tool = msg.data as { toolName: string; status: string; result?: unknown };
          if (tool.status === 'started') {
            console.log(`\n[TOOL] ${tool.toolName} started`);
          } else {
            console.log(`[TOOL] ${tool.toolName} completed:`, JSON.stringify(tool.result, null, 2));
          }
          break;

        case 'todo_update':
          const todos = msg.data as { todos: Array<{ task: string; status: string; depth: number }> };
          console.log('\n[TODOS]');
          for (const todo of todos.todos) {
            const indent = '  '.repeat(todo.depth);
            const status = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '→' : '○';
            console.log(`${indent}${status} ${todo.task}`);
          }
          break;

        case 'agent_question':
          const question = msg.data as { question: string };
          console.log(`\n[QUESTION] ${question.question}`);
          this.prompt('Your answer: ');
          return; // Don't show main prompt

        case 'agent_response':
          const response = msg.data as { output: string; status: string };
          console.log(`\n[RESPONSE] (${response.status})`);
          console.log(response.output);
          break;

        case 'error':
          const error = msg.data as { code: string; message: string };
          console.error(`\n[ERROR] ${error.code}: ${error.message}`);
          break;

        default:
          console.log(`\n[${msg.type}]`, JSON.stringify(msg.data, null, 2));
      }

      this.prompt();
    } catch (e) {
      console.error('Failed to parse message:', raw);
    }
  }

  private prompt(question = '\nEnter task (or /help): '): void {
    this.rl.question(question, (input) => {
      this.handleInput(input.trim());
    });
  }

  private handleInput(input: string): void {
    if (!input) {
      this.prompt();
      return;
    }

    if (input === '/help') {
      console.log(`
Commands:
  /help      Show this help
  /cancel    Cancel current task
  /ping      Send ping
  /quit      Exit client
  <text>     Start task or respond to question
`);
      this.prompt();
      return;
    }

    if (input === '/quit' || input === '/exit') {
      this.ws?.close();
      return;
    }

    if (input === '/cancel') {
      this.send({ type: 'cancel' });
      this.prompt();
      return;
    }

    if (input === '/ping') {
      this.send({ type: 'ping' });
      this.prompt();
      return;
    }

    // Check if we're awaiting input (question mode) or starting new task
    const session = this.sessionId;
    if (session) {
      // Try as user_response first if session exists
      this.send({
        type: 'start_task',
        sessionId: session,
        data: { task: input },
      });
    } else {
      this.send({
        type: 'start_task',
        data: { task: input },
      });
    }
  }

  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.error('Not connected');
    }
  }
}

// Main
console.log('dhee-core WebSocket Test Client');
console.log('================================');

const client = new TestClient();
client.connect();
