import { it, expect, vi } from 'vitest';
import { runControlCli } from '../../src/control/cliIo.js';
async function* input(text: string) {
  yield text;
}
it('emits one machine-readable result, keeps progress separate, and forwards cancellation', async () => {
  const write = vi.fn(),
    log = vi.fn(),
    signal = new AbortController().signal;
  const execute = vi.fn(async (request, options) => {
    options.log('waiting');
    return { ok: true as const, result: request };
  });
  expect(
    await runControlCli(
      [],
      { input: input('{"action":"project.status"}'), write, log },
      { signal },
      execute
    )
  ).toBe(0);
  expect(write).toHaveBeenCalledTimes(1);
  expect(JSON.parse(write.mock.calls[0][0])).toEqual({
    ok: true,
    result: { action: 'project.status' },
  });
  expect(log).toHaveBeenCalledWith('waiting');
  expect(execute.mock.calls[0][1].signal).toBe(signal);
});
it('rejects malformed JSON, oversized requests and flags before dispatch', async () => {
  for (const [args, text] of [
    [[], '{'],
    [[], 'x'.repeat(1024 * 1024 + 1)],
    [['--oops'], '{}'],
  ] as [string[], string][]) {
    const write = vi.fn(),
      execute = vi.fn();
    expect(
      await runControlCli(args, { input: input(text), write, log: () => {} }, {}, execute)
    ).toBe(1);
    expect(JSON.parse(write.mock.calls[0][0]).ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  }
});
it('returns a nonzero exit status for an operation failure', async () => {
  const write = vi.fn();
  expect(
    await runControlCli([], { input: input('{}'), write, log: () => {} }, {}, async () => ({
      ok: false,
      error: 'blocked',
    }))
  ).toBe(1);
  expect(JSON.parse(write.mock.calls[0][0])).toEqual({ ok: false, error: 'blocked' });
});

it('can interrupt stdin before a complete request arrives', async () => {
  const { Readable } = await import('node:stream');
  const stream = new Readable({ read() {} });
  const controller = new AbortController();
  const write = vi.fn();
  const pending = runControlCli(
    [],
    { input: stream, write, log: () => {} },
    { signal: controller.signal }
  );
  controller.abort(new Error('operator stop'));
  const result = await Promise.race([
    pending,
    new Promise(resolve => setTimeout(() => resolve('hung'), 100)),
  ]);
  stream.destroy();
  expect(result).toBe(1);
  expect(JSON.parse(write.mock.calls[0][0]).ok).toBe(false);
});
