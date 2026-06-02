#!/usr/bin/env tsx
/**
 * Headless agent driver — give the agent a critique + project path,
 * stream events, return when the turn finishes. Used to verify shot
 * editing end-to-end without the desktop running.
 *
 * Usage:
 *   pnpm exec tsx scripts/headlessAgentEdit.ts <projectDir> '<user-message>'
 *
 * Per feedback_agent_default_headless memory: this is the canonical
 * path for driving the agent during verification. Desktop-IPC only
 * when explicitly testing UI features.
 */
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildPiSession } from '../src/agent/pi/buildSession.js';
import { runAgentTurn } from '../src/agent/pi/runTurn.js';

function banner(t: string): void {
  console.log(`\n${'═'.repeat(76)}\n  ${t}\n${'═'.repeat(76)}`);
}

async function main(): Promise<void> {
  const projectDir = resolve(process.argv[2] ?? '');
  const userMessage = process.argv[3];
  if (!projectDir || !existsSync(join(projectDir, 'project.json'))) {
    console.error('Usage: tsx scripts/headlessAgentEdit.ts <projectDir> "<user-message>"');
    console.error('(project.json must exist at <projectDir>)');
    process.exit(2);
  }
  if (!userMessage) {
    console.error('Missing user message argument.');
    process.exit(2);
  }

  // Pull model + key from env (.env already loaded by 'dotenv/config').
  const apiKey = process.env['OPENAI_API_KEY'];
  const modelId = process.env['OPENAI_MODEL'] ?? 'deepseek/deepseek-v4-flash';
  const provider = process.env['LLM_PROVIDER'] === 'openai' && process.env['OPENAI_BASE_URL']?.includes('openrouter')
    ? 'openrouter'
    : (process.env['LLM_PROVIDER'] ?? 'openrouter');
  if (!apiKey) {
    console.error('Missing OPENAI_API_KEY env var.');
    process.exit(2);
  }

  banner(`HEADLESS AGENT EDIT — ${projectDir}`);
  console.log(`  model:    ${provider} / ${modelId}`);
  console.log(`  message:  ${userMessage}`);

  const { session } = await buildPiSession({
    cwd: projectDir,
    modelProvider: provider,
    modelId,
    apiKey,
  });

  // Subscribe before prompting so we don't lose early events.
  const events: { name: string; detail: string }[] = [];
  const unsub = session.subscribe((evRaw) => {
    const ev = evRaw as {
      type?: string;
      toolName?: string;
      toolCallId?: string;
      arguments?: Record<string, unknown>;
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      assistantMessageEvent?: { type?: string; delta?: string };
    };
    if (ev.type === 'tool_execution_start') {
      const name = ev.toolName ?? '<unknown>';
      const args = ev.arguments ? JSON.stringify(ev.arguments).slice(0, 200) : '';
      console.log(`  ⏵ ${name} ${args}`);
      events.push({ name: `start:${name}`, detail: args });
    } else if (ev.type === 'tool_execution_end') {
      const name = ev.toolName ?? '<unknown>';
      const ok = !ev.result?.isError;
      const head = ev.result?.content?.[0]?.text?.slice(0, 140) ?? '';
      console.log(`  ${ok ? '✓' : '✗'} ${name} → ${head}`);
      events.push({ name: `end:${name}`, detail: head });
    } else if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') {
      process.stdout.write(ev.assistantMessageEvent.delta ?? '');
    }
  });

  try {
    const r = await runAgentTurn(
      {
        subscribe: (listener) => session.subscribe(listener),
        prompt: (msg) => session.prompt(msg),
        dispose: () => session.dispose?.(),
      },
      userMessage,
      { keepAlive: false },
    );
    unsub();
    console.log('');
    banner('TURN COMPLETE');
    if (!r.ok) {
      console.log(`  ERROR: ${r.error}`);
      process.exit(1);
    }
    console.log(`  assistant text head: ${r.assistant_text?.slice(0, 300)}`);
    console.log(`  tool calls (${r.tool_calls.length}): ${r.tool_calls.map((t) => t.name).join(', ')}`);
  } catch (e) {
    unsub();
    console.error(`Turn threw: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Top-level error:', e);
  process.exit(1);
});
