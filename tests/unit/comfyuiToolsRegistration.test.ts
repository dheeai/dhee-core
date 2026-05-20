/**
 * Smoke test: the 6 ComfyUI workflow tools are registered with the
 * pi-agent and have the expected names. The tools' actual logic is
 * covered by `workflowIntegration.test.ts` (the shared helpers each
 * tool wraps). This file just guards against accidental
 * deregistration during refactors.
 */

import { describe, it, expect } from 'vitest';
import { dheeTools } from '../../src/agent/pi/tools/index.js';

const EXPECTED_COMFYUI_TOOLS = [
  'dhee_validate_comfy_workflow',
  'dhee_analyze_comfy_workflow',
  'dhee_save_comfy_workflow',
  'dhee_list_comfy_workflows',
  'dhee_update_comfy_workflow',
  'dhee_delete_comfy_workflow',
];

describe('ComfyUI workflow tools — registration', () => {
  it('includes all 6 tools in the dheeTools registry', () => {
    const names = dheeTools.map(t => t.name).sort();
    for (const expected of EXPECTED_COMFYUI_TOOLS) {
      expect(names).toContain(expected);
    }
  });

  it('every tool has a non-empty description (the LLM relies on it for routing)', () => {
    const comfyTools = dheeTools.filter(t => EXPECTED_COMFYUI_TOOLS.includes(t.name));
    expect(comfyTools).toHaveLength(EXPECTED_COMFYUI_TOOLS.length);
    for (const tool of comfyTools) {
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it('every tool has a typed parameters schema', () => {
    const comfyTools = dheeTools.filter(t => EXPECTED_COMFYUI_TOOLS.includes(t.name));
    for (const tool of comfyTools) {
      expect(tool.parameters).toBeDefined();
    }
  });
});
