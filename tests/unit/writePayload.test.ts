/**
 * resolveWritePayload — TDD coverage for the discriminated union
 * shared by `dhee_write_input` and `dhee_write_node_content`.
 *
 * Failure modes:
 *   1. kind=text returns UTF-8 bytes of the content.
 *   2. kind=base64 decodes to the expected bytes.
 *   3. kind=base64 with invalid base64 throws a clear error.
 *   4. kind=localFile reads bytes from disk.
 *   5. kind=localFile with missing sourcePath throws.
 *   6. unknown kind throws.
 *   7. kind=text with undefined content throws (caller bug).
 *   8. kind=base64 with undefined contentBase64 throws.
 *   9. kind=localFile with undefined sourcePath throws.
 *  10. Result is always a Buffer (callers write binary or text alike).
 *  11. Large base64 (>1MB) decodes without truncation.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWritePayload, type WritePayload } from '../../src/agent/pi/tools/writePayload.js';

describe('resolveWritePayload', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('1. kind=text returns UTF-8 bytes', () => {
    const r = resolveWritePayload({ kind: 'text', content: 'hello world' });
    expect(Buffer.isBuffer(r)).toBe(true);
    expect(r.toString('utf8')).toBe('hello world');
  });

  it('2. kind=base64 decodes correctly', () => {
    const b64 = Buffer.from('hello world', 'utf8').toString('base64');
    const r = resolveWritePayload({ kind: 'base64', contentBase64: b64 });
    expect(r.toString('utf8')).toBe('hello world');
  });

  it('3. kind=base64 with invalid base64 throws', () => {
    // Node's Buffer.from(..., 'base64') is lenient — it drops invalid
    // chars rather than throwing. We treat ONLY the empty-result case
    // (decoded to empty bytes when the input claimed content) as an error.
    expect(() =>
      resolveWritePayload({ kind: 'base64', contentBase64: '!!!' }),
    ).toThrow(/base64/i);
  });

  it('4. kind=localFile reads bytes from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-test-'));
    dirs.push(dir);
    const p = join(dir, 'src.txt');
    writeFileSync(p, 'fileContent', 'utf8');
    const r = resolveWritePayload({ kind: 'localFile', sourcePath: p });
    expect(r.toString('utf8')).toBe('fileContent');
  });

  it('5. kind=localFile with missing source throws', () => {
    expect(() =>
      resolveWritePayload({ kind: 'localFile', sourcePath: '/no/such/file.png' }),
    ).toThrow(/not found|ENOENT/i);
  });

  it('6. unknown kind throws', () => {
    expect(() =>
      resolveWritePayload({ kind: 'bogus' } as unknown as WritePayload),
    ).toThrow(/unknown.*kind|invalid/i);
  });

  it('7. kind=text with undefined content throws', () => {
    expect(() =>
      resolveWritePayload({ kind: 'text' } as unknown as WritePayload),
    ).toThrow(/content/i);
  });

  it('8. kind=base64 with undefined contentBase64 throws', () => {
    expect(() =>
      resolveWritePayload({ kind: 'base64' } as unknown as WritePayload),
    ).toThrow(/base64/i);
  });

  it('9. kind=localFile with undefined sourcePath throws', () => {
    expect(() =>
      resolveWritePayload({ kind: 'localFile' } as unknown as WritePayload),
    ).toThrow(/sourcePath/i);
  });

  it('10. result is always a Buffer (binary or text alike)', () => {
    expect(Buffer.isBuffer(resolveWritePayload({ kind: 'text', content: 'a' }))).toBe(true);
    expect(Buffer.isBuffer(resolveWritePayload({ kind: 'base64', contentBase64: 'YQ==' }))).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'wp-test-'));
    dirs.push(dir);
    const p = join(dir, 'b.bin');
    writeFileSync(p, Buffer.from([0, 1, 2, 3]));
    const r = resolveWritePayload({ kind: 'localFile', sourcePath: p });
    expect(Buffer.isBuffer(r)).toBe(true);
    expect([...r]).toEqual([0, 1, 2, 3]);
  });

  it('11. large base64 (>1MB) decodes without truncation', () => {
    const bytes = Buffer.alloc(1_200_000, 0xab);
    const b64 = bytes.toString('base64');
    const r = resolveWritePayload({ kind: 'base64', contentBase64: b64 });
    expect(r.length).toBe(1_200_000);
    expect(r[0]).toBe(0xab);
    expect(r[1_199_999]).toBe(0xab);
  });
});
