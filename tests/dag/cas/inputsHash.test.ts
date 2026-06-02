/**
 * inputsHash — content-stable hash of the resolved inputs for a node
 * invocation. Failure modes:
 *
 *   1. Two structurally-identical inputs hash to the same value.
 *   2. Key order in the inputs object does NOT change the hash.
 *   3. A file passed via {kind:'file', path} hashes its CONTENTS,
 *      so renaming the path does NOT change the hash, but flipping
 *      one byte does.
 *   4. Changing seed changes the hash.
 *   5. Changing config changes the hash.
 *   6. Missing file in {kind:'file'} throws clearly.
 *   7. Strings and parsed JSON values are interchangeable when their
 *      stringified shape matches.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeInputsHash } from '../../../src/dag/cas/inputsHash.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'inputshash-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('computeInputsHash', () => {
  it('identical inputs → identical hash', () => {
    const a = computeInputsHash({
      tool: 'llm.generate',
      toolVersion: '0.1.0',
      inputs: { story: 'hello' },
      config: { tier: 'heavy' },
    });
    const b = computeInputsHash({
      tool: 'llm.generate',
      toolVersion: '0.1.0',
      inputs: { story: 'hello' },
      config: { tier: 'heavy' },
    });
    expect(a).toBe(b);
  });

  it('key order in inputs does not change the hash', () => {
    const a = computeInputsHash({
      tool: 't',
      toolVersion: '1',
      inputs: { a: 1, b: 2, c: 3 },
      config: {},
    });
    const b = computeInputsHash({
      tool: 't',
      toolVersion: '1',
      inputs: { c: 3, a: 1, b: 2 },
      config: {},
    });
    expect(a).toBe(b);
  });

  it('file input hashes file contents — renaming the file does not change the hash', () => {
    const p1 = join(dir, 'foo.md');
    const p2 = join(dir, 'bar.md');
    writeFileSync(p1, 'hello world');
    writeFileSync(p2, 'hello world');

    const a = computeInputsHash({
      tool: 't',
      toolVersion: '1',
      inputs: { story: { kind: 'file', path: p1 } },
      config: {},
    });
    const b = computeInputsHash({
      tool: 't',
      toolVersion: '1',
      inputs: { story: { kind: 'file', path: p2 } },
      config: {},
    });
    expect(a).toBe(b);
  });

  it('flipping one byte in a file input changes the hash', () => {
    const p = join(dir, 'foo.md');
    writeFileSync(p, 'hello world');

    const a = computeInputsHash({ tool: 't', toolVersion: '1', inputs: { story: { kind: 'file', path: p } }, config: {} });

    writeFileSync(p, 'hello WORLD');
    const b = computeInputsHash({ tool: 't', toolVersion: '1', inputs: { story: { kind: 'file', path: p } }, config: {} });

    expect(a).not.toBe(b);
  });

  it('changing seed changes the hash', () => {
    const a = computeInputsHash({ tool: 't', toolVersion: '1', inputs: {}, config: {}, seed: 1 });
    const b = computeInputsHash({ tool: 't', toolVersion: '1', inputs: {}, config: {}, seed: 2 });
    expect(a).not.toBe(b);
  });

  it('changing config changes the hash', () => {
    const a = computeInputsHash({ tool: 't', toolVersion: '1', inputs: {}, config: { temperature: 0.7 } });
    const b = computeInputsHash({ tool: 't', toolVersion: '1', inputs: {}, config: { temperature: 0.9 } });
    expect(a).not.toBe(b);
  });

  it('changing toolVersion changes the hash', () => {
    const a = computeInputsHash({ tool: 't', toolVersion: '0.1.0', inputs: {}, config: {} });
    const b = computeInputsHash({ tool: 't', toolVersion: '0.2.0', inputs: {}, config: {} });
    expect(a).not.toBe(b);
  });

  it('missing file in {kind:"file"} throws a clear error', () => {
    expect(() => computeInputsHash({
      tool: 't', toolVersion: '1', inputs: { story: { kind: 'file', path: '/no/such/file' } }, config: {},
    })).toThrow(/file/i);
  });

  it('hash is a 64-char hex sha256', () => {
    const h = computeInputsHash({ tool: 't', toolVersion: '1', inputs: { x: 1 }, config: {} });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
