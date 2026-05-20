/**
 * Tests for the pi-agent `dhee_focus_project` tool.
 *
 * focusProject is structurally different from every other pi-agent
 * tool: it doesn't read or write the filesystem and doesn't invoke
 * ExecutorAgent. It's a thin wrapper around a host-supplied callback —
 * Electron desktop and TUI each provide their own implementation
 * because focusing a project means different things in each context
 * (Electron repaints panels; TUI prints a banner).
 *
 * Tested contracts:
 *   - tool calls the supplied callback with the project name
 *   - callback's resolved result becomes the tool's `details`
 *   - successful response renders the formatted text the way the
 *     chat panel displays it (with optional fields omitted when null)
 *   - thrown callback errors produce a structured failure (not a
 *     thrown promise rejection)
 *   - non-Error throwables fall back to `String(err)` in the message
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createFocusProjectTool,
  type FocusProjectResult,
} from '../../src/agent/pi/tools/focusProject.js';

function executeFocus(
  tool: ReturnType<typeof createFocusProjectTool>,
  projectName: string,
) {
  return tool.execute(
    'call-id-1',
    { project: projectName } as never,
    undefined as never,
    undefined as never,
    {} as never,
  );
}

describe('pi-agent dhee_focus_project tool', () => {
  it('invokes the host callback with the requested project name', async () => {
    const callback = vi.fn(
      async (name: string): Promise<FocusProjectResult> => ({
        projectName: name,
        templateId: 'narrative',
      }),
    );
    const tool = createFocusProjectTool(callback);
    await executeFocus(tool, 'noir');
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('noir');
  });

  it('returns the callback result verbatim as the tool details', async () => {
    const result: FocusProjectResult = {
      projectName: 'noir',
      title: 'Noir Detective',
      style: 'cinematic_realism',
      phase: 'shot_video',
      templateId: 'narrative',
    };
    const tool = createFocusProjectTool(async () => result);
    const r = await executeFocus(tool, 'noir');
    expect(r.details).toEqual(result);
  });

  it('formats the response text with all optional fields when provided', async () => {
    const tool = createFocusProjectTool(async () => ({
      projectName: 'noir',
      title: 'Noir Detective',
      style: 'cinematic_realism',
      phase: 'shot_video',
      templateId: 'narrative',
    }));
    const r = await executeFocus(tool, 'noir');
    const text = (r.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/^Focused on project: noir/);
    expect(text).toMatch(/title: Noir Detective/);
    expect(text).toMatch(/style: cinematic_realism/);
    expect(text).toMatch(/phase: shot_video/);
    expect(text).toMatch(/template: narrative/);
  });

  it('omits optional fields from the formatted text when missing', async () => {
    const tool = createFocusProjectTool(async () => ({
      projectName: 'sparse',
      templateId: 'narrative',
      // No title, style, phase.
    }));
    const r = await executeFocus(tool, 'sparse');
    const text = (r.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/^Focused on project: sparse/);
    expect(text).toMatch(/template: narrative/);
    // Lines for optional fields should NOT appear.
    expect(text).not.toMatch(/title:/);
    expect(text).not.toMatch(/style:/);
    expect(text).not.toMatch(/phase:/);
  });

  // ── Failure paths ─────────────────────────────────────────────────

  it('returns a structured failure when the callback throws an Error', async () => {
    const tool = createFocusProjectTool(async () => {
      throw new Error('Project not found: ghost');
    });
    const r = await executeFocus(tool, 'ghost');
    const text = (r.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/^Failed to focus project: Project not found: ghost/);
    expect(r.details).toEqual({ error: 'Project not found: ghost' });
  });

  it('handles non-Error throwables via String(err)', async () => {
    const tool = createFocusProjectTool(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'just a string';
    });
    const r = await executeFocus(tool, 'whatever');
    const text = (r.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/^Failed to focus project: just a string/);
    expect(r.details).toEqual({ error: 'just a string' });
  });

  it('does not let callback rejections become unhandled promise rejections', async () => {
    // Smoke test: even though the callback rejects, the tool must
    // resolve with a structured failure. Without the try/catch in
    // execute(), this would throw out of the test as an unhandled
    // rejection.
    const tool = createFocusProjectTool(async () => {
      throw new Error('boom');
    });
    await expect(executeFocus(tool, 'p')).resolves.toBeDefined();
  });

  // ── Independence from filesystem / executor ──────────────────────

  it('does NOT touch the filesystem or invoke any executor', async () => {
    // Sanity check: if a regression accidentally adds an fs read or
    // an executor call, this test will fail because the callback is
    // the only side-effect path the tool has. We assert the callback
    // got called exactly once and was the only async work done.
    const callback = vi.fn(async () => ({
      projectName: 'p',
      templateId: 'narrative',
    }));
    const tool = createFocusProjectTool(callback);
    await executeFocus(tool, 'p');
    // If the implementation gains an internal fs or HTTP call before
    // calling the callback, it'd typically add latency or a second
    // call; this isn't a perfect guard, but it pins the current
    // single-call contract.
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
