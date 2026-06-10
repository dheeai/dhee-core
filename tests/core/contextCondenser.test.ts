/**
 * Unit tests for the agent context-management modules:
 *   - src/core/context/MessageCondenser.ts (content labelling / titling;
 *     condensing itself is deprecated and passes content through unchanged)
 *   - src/core/context/MessageCompressor.ts (history compression: preserve
 *     system + recent, summarize the middle)
 *
 * The compressor takes an injectable summarizer, so it is fully testable
 * without an LLM.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  condenseContent,
  condenseUserInput,
  shouldCondense,
  generateVariableBaseName,
  generateContentLabel,
  generateProjectTitle,
  LONG_CONTENT_THRESHOLD,
} from '../../src/core/context/MessageCondenser.js';

import {
  compressMessages,
  MESSAGES_TO_PRESERVE,
  MIN_MESSAGES_FOR_COMPRESSION,
} from '../../src/core/context/MessageCompressor.js';
import type { Message } from '../../src/core/llm/types.js';

// ---------------------------------------------------------------------------
// MessageCondenser — content passes through, labelling helpers work
// ---------------------------------------------------------------------------

describe('MessageCondenser (deprecated pass-through)', () => {
  it('returns content unchanged from condenseContent', () => {
    const content = 'x'.repeat(5000);
    const result = condenseContent(content, 'label', { source: 'user_input' });
    expect(result.condensed).toBe(content);
    expect(result.wasCondensed).toBe(false);
    expect(result.variableName).toBeUndefined();
  });

  it('returns content unchanged from condenseUserInput', () => {
    const content = 'hello world';
    expect(condenseUserInput(content).condensed).toBe(content);
    expect(condenseUserInput(content).wasCondensed).toBe(false);
  });

  it('shouldCondense uses the length threshold', () => {
    expect(shouldCondense('short')).toBe(false);
    expect(shouldCondense('a'.repeat(LONG_CONTENT_THRESHOLD))).toBe(false); // strictly greater
    expect(shouldCondense('a'.repeat(LONG_CONTENT_THRESHOLD + 1))).toBe(true);
    // custom threshold
    expect(shouldCondense('abcdef', 3)).toBe(true);
    expect(shouldCondense('ab', 3)).toBe(false);
  });
});

describe('generateVariableBaseName', () => {
  it('detects chapter references with numeric index', () => {
    expect(generateVariableBaseName('Chapter 3: The Reckoning')).toBe('chapter_3');
  });

  it('detects chapter references with word index', () => {
    expect(generateVariableBaseName('Chapter Two: Aftermath')).toBe('chapter_2');
  });

  it('detects scene references', () => {
    expect(generateVariableBaseName('Scene 5 - the docks')).toBe('scene_5');
  });

  it('detects act references', () => {
    expect(generateVariableBaseName('Act II opens')).toBe('act_ii');
  });

  it('detects "once upon a time" stories', () => {
    expect(generateVariableBaseName('Once upon a time there was a king')).toBe('story');
  });

  it('labels short character descriptions', () => {
    expect(generateVariableBaseName('Character: a weary detective')).toBe('character_desc');
  });

  it('extracts a setting name from a short location description', () => {
    expect(generateVariableBaseName('The village of Eldermoor sat quiet.')).toBe('setting_eldermoor');
  });

  it('classifies a long full narrative as full_story', () => {
    // Must clear isFullNarrative's >=800 char gate and >=2 narrative
    // indicators (multi-paragraph + dialogue + narrative verbs + scene-setting).
    const para = (extra: string) =>
      `The morning light crept into the room as she walked to the window and looked outside. ` +
      `He said, "We should leave now." She replied, "Not yet, the night is not over." ` +
      `Suddenly the door opened and they turned. In the dark city the silence felt heavy as she ` +
      `thought about what she knew, and finally she moved toward the door. ${extra}`;
    const narrative = [para('She heard a sound.'), para('He nodded slowly.'), para('They stopped and waited.')].join('\n\n');
    expect(narrative.length).toBeGreaterThan(800);
    expect(generateVariableBaseName(narrative)).toBe('full_story');
  });

  it('falls back to a meaningful word for unmarked short content', () => {
    expect(generateVariableBaseName('Dragons circle the keep')).toBe('dragons');
  });

  it('falls back to "content" when nothing meaningful is found', () => {
    expect(generateVariableBaseName('a b c')).toBe('content');
  });
});

describe('generateContentLabel', () => {
  it('labels chapters', () => {
    expect(generateContentLabel('Chapter 1: Beginnings')).toMatch(/^Chapter:/);
  });

  it('labels scenes', () => {
    expect(generateContentLabel('Scene 2: rooftop')).toMatch(/^Scene:/);
  });

  it('quotes a preview for generic content', () => {
    const label = generateContentLabel('A quiet harbor town at dawn breaks open');
    expect(label).toContain('A quiet harbor town');
  });

  it('returns a default for trivially short content', () => {
    expect(generateContentLabel('hi')).toBe('User-provided content');
  });
});

describe('generateProjectTitle', () => {
  it('strips a chapter prefix and stop words', () => {
    expect(generateProjectTitle('Chapter 1: Shocking Discoveries')).toBe('shocking_discoveries');
  });

  it('strips a leading "The"', () => {
    expect(generateProjectTitle('The Adventures of Tom')).toBe('adventures_tom');
  });

  it('limits to four meaningful words', () => {
    const title = generateProjectTitle('alpha bravo charlie delta echo foxtrot');
    expect(title.split('_')).toHaveLength(4);
  });

  it('returns untitled_project when no meaningful words remain', () => {
    expect(generateProjectTitle('the and for')).toBe('untitled_project');
  });
});

// ---------------------------------------------------------------------------
// MessageCompressor — preserve system + recent, summarize the middle
// ---------------------------------------------------------------------------

function makeMessages(count: number, withSystem = true): Message[] {
  const msgs: Message[] = [];
  if (withSystem) {
    msgs.push({ role: 'system', content: 'You are an agent.' });
  }
  for (let i = 0; i < count; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${i}` });
  }
  return msgs;
}

describe('compressMessages', () => {
  const echoSummarizer = vi.fn(async (content: string) => `SUMMARY(${content.length} chars)`);

  it('does not compress below the minimum message count', async () => {
    const messages = makeMessages(MIN_MESSAGES_FOR_COMPRESSION - 2);
    const result = await compressMessages(messages, echoSummarizer);
    expect(result.wasCompressed).toBe(false);
    expect(result.removedCount).toBe(0);
    expect(result.messages).toBe(messages); // passthrough, same array
  });

  it('compresses when there are enough messages, preserving system + recent', async () => {
    const summarizer = vi.fn(async () => 'BULLET SUMMARY');
    // 1 system + 30 content messages → plenty to summarize
    const messages = makeMessages(30);
    const result = await compressMessages(messages, summarizer);

    expect(result.wasCompressed).toBe(true);
    expect(summarizer).toHaveBeenCalledOnce();
    expect(result.summary).toBe('BULLET SUMMARY');
    expect(result.removedCount).toBeGreaterThan(0);

    // First message must still be the system message.
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are an agent.' });

    // Second message is the injected summary (a user message).
    expect(result.messages[1]!.role).toBe('user');
    expect(result.messages[1]!.content).toContain('Previous Conversation Summary');
    expect(result.messages[1]!.content).toContain('BULLET SUMMARY');

    // The last preserved messages are the most-recent originals.
    const preserveCount = MESSAGES_TO_PRESERVE * 2;
    const tail = result.messages.slice(-preserveCount);
    expect(tail).toEqual(messages.slice(-preserveCount));

    // Compressed history is shorter than original.
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it('skips compression when too few messages sit between system and the preserved tail', async () => {
    const summarizer = vi.fn(async () => 'X');
    // 1 system + 14 content = 15 total (== MIN, so it clears the first
    // gate), but after reserving 10 for the tail and 1 for system only 4
    // remain to summarize (< 5) → no compression.
    const messages = makeMessages(MIN_MESSAGES_FOR_COMPRESSION - 1);
    const result = await compressMessages(messages, summarizer);
    expect(result.wasCompressed).toBe(false);
    expect(summarizer).not.toHaveBeenCalled();
  });

  it('handles a conversation with no system message', async () => {
    const summarizer = vi.fn(async () => 'NO-SYS SUMMARY');
    const messages = makeMessages(30, false);
    const result = await compressMessages(messages, summarizer);
    expect(result.wasCompressed).toBe(true);
    // Without a system message the first entry is the injected summary.
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[0]!.content).toContain('NO-SYS SUMMARY');
  });

  it('feeds tool results and tool-call metadata into the summary content', async () => {
    let captured = '';
    const summarizer = vi.fn(async (content: string) => {
      captured = content;
      return 'S';
    });
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 10 }, (_, i): Message => ({ role: 'user', content: `u${i}` })),
      { role: 'assistant', content: 'calling', toolCalls: [{ id: 't1', name: 'read_file', arguments: {} }] },
      { role: 'tool', content: 'file contents here', name: 'read_file', toolCallId: 't1' },
      ...Array.from({ length: 12 }, (_, i): Message => ({ role: 'user', content: `r${i}` })),
    ];
    const result = await compressMessages(messages, summarizer);
    expect(result.wasCompressed).toBe(true);
    expect(captured).toContain('ASSISTANT called: read_file');
    expect(captured).toContain('TOOL RESULT (read_file)');
  });
});
