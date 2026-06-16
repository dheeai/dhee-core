import { describe, expect, it, vi } from 'vitest';
import { LLMClient, type LLMResponse, type Message } from '../../../src/core/llm/index.js';

describe('LLMClient reasoning payload handling', () => {
  it('preserves reasoning fields from provider responses', () => {
    const client = new LLMClient({
      baseUrl: 'http://localhost/v1',
      apiKey: 'test-key',
      model: 'test-model',
    });

    const response = (client as unknown as {
      parseResponse: (response: unknown) => LLMResponse;
    }).parseResponse({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            reasoning: 'private reasoning text',
            reasoning_details: [{ type: 'reasoning.text', text: 'private reasoning text' }],
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"file_path":"original_input.md"}' },
              },
            ],
          },
        },
      ],
    });

    expect(response.reasoning).toBe('private reasoning text');
    expect(response.reasoningDetails).toEqual([
      { type: 'reasoning.text', text: 'private reasoning text' },
    ]);
    expect(response.toolCalls).toEqual([
      {
        id: 'call_1',
        name: 'read_file',
        arguments: { file_path: 'original_input.md' },
      },
    ]);
  });

  it('replays preserved reasoning on assistant messages', () => {
    const client = new LLMClient({
      baseUrl: 'http://localhost/v1',
      apiKey: 'test-key',
      model: 'test-model',
    });
    const convertMessages = (client as unknown as {
      convertMessages: (messages: Message[]) => Array<Record<string, unknown>>;
    }).convertMessages.bind(client);

    const [assistantWithDetails] = convertMessages([
      {
        role: 'assistant',
        content: null,
        reasoning: 'private reasoning text',
        reasoningDetails: [{ type: 'reasoning.text', text: 'private reasoning text' }],
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { file_path: 'a.md' } }],
      },
    ]);

    expect(assistantWithDetails?.['reasoning_details']).toEqual([
      { type: 'reasoning.text', text: 'private reasoning text' },
    ]);
    expect(assistantWithDetails?.['reasoning_content']).toBeUndefined();

    const [assistantWithText] = convertMessages([
      {
        role: 'assistant',
        content: 'Done',
        reasoning: 'private reasoning text',
      },
    ]);

    expect(assistantWithText?.['reasoning_content']).toBe('private reasoning text');
  });

  // Regression: thinking models (local Qwen3 / Gemma) burned the whole token
  // budget on reasoning_content and returned empty `content`, so the generate
  // path read empty and fired wasteful empty-response retries (each a full
  // max-token generation) that hammered the local GPU.
  it('falls back to reasoning_content when content is empty (no empty-retry)', () => {
    const client = new LLMClient({ baseUrl: 'http://localhost/v1', apiKey: 'k', model: 'm' });
    const out = (client as unknown as {
      parseResponse: (r: unknown) => LLMResponse;
    }).parseResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: '', reasoning_content: 'the actual answer' },
        },
      ],
    });
    expect(out.content).toBe('the actual answer');
  });

  it('does NOT override real content with reasoning (counter-test)', () => {
    const client = new LLMClient({ baseUrl: 'http://localhost/v1', apiKey: 'k', model: 'm' });
    const out = (client as unknown as {
      parseResponse: (r: unknown) => LLMResponse;
    }).parseResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: 'real answer', reasoning_content: 'private thoughts' },
        },
      ],
    });
    expect(out.content).toBe('real answer');
  });

  it('disables thinking on the generate request (chat_template_kwargs.enable_thinking=false)', async () => {
    const client = new LLMClient({ baseUrl: 'http://localhost/v1', apiKey: 'k', model: 'm' });
    const create = vi.fn().mockResolvedValue({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
    // Swap the underlying OpenAI client for a capture stub.
    (client as unknown as { client: { chat: { completions: { create: typeof create } } } }).client = {
      chat: { completions: { create } },
    };
    await client.generate({ messages: [{ role: 'user', content: 'hi' }] });
    const sentRequest = create.mock.calls[0]?.[0] as { chat_template_kwargs?: { enable_thinking?: boolean } };
    expect(sentRequest.chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});
