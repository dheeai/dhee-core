import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  writeDiscoveryFile,
  removeDiscoveryFile,
  readDiscoveryFile,
  defaultDiscoveryPath,
} from '../../src/server/discovery.js';

describe('discovery — server discovery file for external agents', () => {
  let tmp: string;
  let discoveryPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dhee-discovery-'));
    discoveryPath = join(tmp, 'server.json');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes a discovery file containing url, port, host, pid, startedAt', () => {
    writeDiscoveryFile({
      path: discoveryPath,
      host: '127.0.0.1',
      port: 4321,
      pid: 9999,
      mode: 'local',
      version: '1.2.3',
    });
    const content = readDiscoveryFile(discoveryPath);
    expect(content).toBeTruthy();
    expect(content!.host).toBe('127.0.0.1');
    expect(content!.port).toBe(4321);
    expect(content!.url).toBe('http://127.0.0.1:4321');
    expect(content!.pid).toBe(9999);
    expect(content!.mode).toBe('local');
    expect(content!.version).toBe('1.2.3');
    expect(typeof content!.startedAt).toBe('number');
  });

  it('overwrites an existing discovery file', () => {
    writeDiscoveryFile({ path: discoveryPath, host: '127.0.0.1', port: 1, pid: 1 });
    writeDiscoveryFile({ path: discoveryPath, host: '127.0.0.1', port: 2, pid: 2 });
    expect(readDiscoveryFile(discoveryPath)!.port).toBe(2);
  });

  it('writes the file with mode 0600 so other users cannot read it', () => {
    writeDiscoveryFile({ path: discoveryPath, host: '127.0.0.1', port: 1, pid: 1 });
    const mode = statSync(discoveryPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates parent directories if they do not exist', () => {
    const nested = join(tmp, 'nested', 'dir', 'server.json');
    writeDiscoveryFile({ path: nested, host: '127.0.0.1', port: 1, pid: 1 });
    expect(existsSync(nested)).toBe(true);
  });

  it('removes the discovery file', () => {
    writeDiscoveryFile({ path: discoveryPath, host: '127.0.0.1', port: 1, pid: 1 });
    expect(existsSync(discoveryPath)).toBe(true);
    removeDiscoveryFile(discoveryPath);
    expect(existsSync(discoveryPath)).toBe(false);
  });

  it('removeDiscoveryFile is a no-op when file does not exist', () => {
    expect(() => removeDiscoveryFile(discoveryPath)).not.toThrow();
  });

  it('readDiscoveryFile returns null for missing file', () => {
    expect(readDiscoveryFile(discoveryPath)).toBeNull();
  });

  it('readDiscoveryFile returns null for unparseable JSON without throwing', () => {
    writeFileSync(discoveryPath, '{not json');
    expect(readDiscoveryFile(discoveryPath)).toBeNull();
  });

  it('defaultDiscoveryPath returns ~/.dhee/server.json on the user home', () => {
    const path = defaultDiscoveryPath();
    expect(path.endsWith('server.json')).toBe(true);
    expect(path.includes('.dhee')).toBe(true);
  });

  it('honours dhee_DISCOVERY_FILE env override', () => {
    const prev = process.env['dhee_DISCOVERY_FILE'];
    process.env['dhee_DISCOVERY_FILE'] = '/tmp/custom-discovery.json';
    try {
      expect(defaultDiscoveryPath()).toBe('/tmp/custom-discovery.json');
    } finally {
      if (prev === undefined) delete process.env['dhee_DISCOVERY_FILE'];
      else process.env['dhee_DISCOVERY_FILE'] = prev;
    }
  });

  it('isDiscoveryFileStale reports false for a live pid (this process)', async () => {
    const { isDiscoveryFileStale } = await import('../../src/server/discovery.js');
    writeDiscoveryFile({ path: discoveryPath, host: '127.0.0.1', port: 1, pid: process.pid });
    expect(isDiscoveryFileStale(discoveryPath)).toBe(false);
  });

  it('isDiscoveryFileStale reports true when pid is no longer alive', async () => {
    const { isDiscoveryFileStale } = await import('../../src/server/discovery.js');
    // pid 0x7FFFFFFF is unlikely to be in use; we treat ESRCH as stale.
    writeDiscoveryFile({ path: discoveryPath, host: '127.0.0.1', port: 1, pid: 0x7FFFFFFF });
    expect(isDiscoveryFileStale(discoveryPath)).toBe(true);
  });

  it('isDiscoveryFileStale reports true when file is missing', async () => {
    const { isDiscoveryFileStale } = await import('../../src/server/discovery.js');
    expect(isDiscoveryFileStale(discoveryPath)).toBe(true);
  });
});
