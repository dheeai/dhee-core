import { describe, expect, it } from 'vitest';

import { bundleRuntimeSupport } from '../../src/dag/bundleRuntimeSupport.js';

function bundleWithTools(tools: string[]) {
  return {
    nodes: tools.map((tool, index) => ({
      id: `node_${index}`,
      runner: { tool },
    })),
  } as any;
}

describe('bundleRuntimeSupport', () => {
  it('normalizes explicit metadata and ignores unknown values', () => {
    const support = bundleRuntimeSupport({
      ...bundleWithTools(['ffmpeg.concat']),
      runtimeSupport: {
        modes: ['dhee_cloud', 'unknown', 'local', 'local'],
        providers: ['openrouter', 'invalid', 'comfy', 'openrouter'],
      },
    });

    expect(support).toEqual({
      modes: ['local', 'dhee_cloud'],
      providers: ['comfy', 'openrouter'],
    });
  });

  it('infers local and Dhee Cloud support for Comfy and LLM runners', () => {
    const support = bundleRuntimeSupport(bundleWithTools([
      'llm.generate',
      'comfy.ltx_director',
      'ffmpeg.concat',
    ]));

    expect(support).toEqual({
      modes: ['local', 'dhee_cloud'],
      providers: ['comfy', 'llm', 'ffmpeg'],
    });
  });

  it('infers Dhee Cloud-only support for OpenRouter runners', () => {
    const support = bundleRuntimeSupport(bundleWithTools([
      'openrouter.image',
      'openrouter.video',
    ]));

    expect(support).toEqual({
      modes: ['dhee_cloud'],
      providers: ['openrouter'],
    });
  });

  it('infers local-only support for FFmpeg-only bundles', () => {
    const support = bundleRuntimeSupport(bundleWithTools(['ffmpeg.concat']));

    expect(support).toEqual({
      modes: ['local'],
      providers: ['ffmpeg'],
    });
  });
});
