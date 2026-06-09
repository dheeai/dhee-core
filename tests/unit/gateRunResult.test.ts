import { describe, it, expect } from 'vitest';
import { buildGateRunResult } from '../../src/agent/pi/tools/gateRunResult.js';

describe('buildGateRunResult', () => {
  it('names the gated collection and frames the pause as by-design (not a failure)', () => {
    const msg = buildGateRunResult({ gatedAfter: 'shot_image_prompt' });
    expect(msg).toContain('shot_image_prompt');
    expect(msg).toMatch(/paused/i);
    expect(msg).toMatch(/gateAfterCollections|stop after each collection/i);
    expect(msg).toMatch(/by[- ]design|intentional/i);
    expect(msg).toMatch(/not a failure/i);
  });

  it('lists the still-pending downstream stages when provided', () => {
    const msg = buildGateRunResult({
      gatedAfter: 'shot_image_prompt',
      pendingAfterGate: ['shot_image', 'scene_clip', 'final_video'],
    });
    expect(msg).toContain('shot_image');
    expect(msg).toContain('scene_clip');
    expect(msg).toContain('final_video');
  });

  it('steers the agent away from the ComfyUI-misconfig confabulation (issue #133)', () => {
    const msg = buildGateRunResult({ gatedAfter: 'shot_image_prompt' });
    // It must explicitly tell the agent NOT to blame a missing endpoint
    // and to resume instead.
    expect(msg).toMatch(/ComfyUI/i);
    expect(msg).toMatch(/resume/i);
  });

  it('omits the pending line gracefully when no downstream list is given', () => {
    const msg = buildGateRunResult({ gatedAfter: 'fanout' });
    expect(msg).not.toMatch(/Stages still pending/i);
  });
});
