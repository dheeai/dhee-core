import * as fs from 'fs';
import * as path from 'path';

import { getCurrentSession, getSessionFs } from '../../../core/fs/index.js';
import { getActiveProjectDir } from './activeProject.js';
import { atomicWriteFileSync } from '../../../utils/atomicWrite.js';

/**
 * Default basePath for project filesystem helpers. Reads
 * `dhee_PROJECTS_DIR` first so embedded hosts (dhee-desktop's
 * Electron main process) can point dhee-core at the right dir
 * without chdir-ing process-globally — that breaks unrelated
 * `process.cwd()` callers in the host. Falls back to process.cwd()
 * for the standalone CLI (where cwd IS the projects dir).
 */
export function defaultBasePath(): string {
  const override = process.env['dhee_PROJECTS_DIR'];
  return override && override.length > 0 ? override : process.cwd();
}

interface RemoteProjectCacheLike {
  getFile(path: string): string | undefined;
  setFile(path: string, content: string): void;
  hasFile(path: string): boolean | undefined;
  markDirectory(path: string): void;
  listFiles?(prefix?: string): string[];
  listDirectories?(prefix?: string): string[];
  listEntries?(prefix?: string): Array<{ path: string; type: 'file' | 'directory' }>;
  getProjectRoot?(): string | null;
}

interface RemoteSocketLike {
  readyState?: number;
  send(payload: string): void;
}

interface RemoteProjectFsLike {
  getCache?: () => RemoteProjectCacheLike | null;
  socket?: RemoteSocketLike;
}

export interface ProjectTreeEntry {
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

function looksAbsolute(targetPath: string): boolean {
  return path.isAbsolute(targetPath) || /^[A-Za-z]:[\\/]/.test(targetPath);
}

function getRemoteProjectFs(): RemoteProjectFsLike | null {
  const session = getCurrentSession();
  if (session?.mode !== 'remote') {
    return null;
  }

  return getSessionFs() as RemoteProjectFsLike;
}

function getRemoteProjectCache(): RemoteProjectCacheLike | null {
  return getRemoteProjectFs()?.getCache?.() ?? null;
}

function tryNormalizeProjectRelativePath(
  targetPath: string,
  basePath: string = defaultBasePath(),
): string | null {
  try {
    return normalizeProjectRelativePath(targetPath, basePath);
  } catch {
    return null;
  }
}

function normalizeProjectRelativePath(
  targetPath: string,
  basePath: string = defaultBasePath(),
): string {
  const trimmed = targetPath.trim();
  if (!trimmed) {
    return '';
  }

  const projectRoot = getProjectRoot(basePath);
  const normalizedTarget = trimmed.replace(/\\/g, '/');
  const relativePath = looksAbsolute(trimmed)
    ? path.relative(projectRoot, trimmed)
    : normalizedTarget;
  const normalizedRelative = path.posix
    .normalize(relativePath.replace(/\\/g, '/'))
    .replace(/^\.\/+/, '');

  if (
    normalizedRelative === '..' ||
    normalizedRelative.startsWith('../') ||
    normalizedRelative === '.' ||
    normalizedRelative === ''
  ) {
    if (normalizedRelative === '' || normalizedRelative === '.') {
      return '';
    }
    throw new Error(`Path escapes project root: ${targetPath}`);
  }

  return normalizedRelative;
}

function markRemoteDirectory(relativeDir: string): void {
  const cache = getRemoteProjectCache();
  if (!cache || !relativeDir) {
    return;
  }

  const segments = relativeDir.split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    cache.markDirectory(current);
  }
}

function sendRemoteProjectCommand(type: string, data: Record<string, unknown>): void {
  const remoteFs = getRemoteProjectFs();
  const socket = remoteFs?.socket;
  if (!socket || socket.readyState !== 1) {
    const session = getCurrentSession();
    const projectRoot = session ? getProjectRoot() : null;
    const details = {
      sessionId: session?.sessionId ?? null,
      mode: session?.mode ?? 'none',
      projectDir: session?.projectDir ?? null,
      projectRoot,
      socketReadyState: socket?.readyState ?? null,
      commandType: type,
    };
    console.error(
      '[projectFileIO] Remote project filesystem is not connected',
      details,
    );
    throw new Error(
      `Remote project filesystem is not connected for ${type} (mode=${details.mode}, projectDir=${details.projectDir ?? 'unknown'}, readyState=${details.socketReadyState ?? 'missing'})`,
    );
  }

  socket.send(JSON.stringify({ type, data }));
}

function ensureProjectParent(relativePath: string, basePath: string = defaultBasePath()): void {
  const parentDir = path.posix.dirname(relativePath);
  if (parentDir && parentDir !== '.') {
    ensureProjectDir(parentDir, basePath);
  }
}

export function getProjectRoot(basePath: string = defaultBasePath()): string {
  const activeProjectDir = getActiveProjectDir();
  if (looksAbsolute(activeProjectDir)) {
    return activeProjectDir;
  }
  return path.join(basePath, activeProjectDir);
}

export function projectPath(
  relativePath: string,
  basePath: string = defaultBasePath(),
): string {
  const normalizedRelative = normalizeProjectRelativePath(relativePath, basePath);
  return normalizedRelative
    ? path.join(getProjectRoot(basePath), normalizedRelative)
    : getProjectRoot(basePath);
}

export function projectRelativePath(
  targetPath: string,
  basePath: string = defaultBasePath(),
): string {
  return normalizeProjectRelativePath(targetPath, basePath);
}

export function isWithinProjectRoot(
  targetPath: string,
  basePath: string = defaultBasePath(),
): boolean {
  try {
    normalizeProjectRelativePath(targetPath, basePath);
    return true;
  } catch {
    return false;
  }
}

export function ensureProjectDir(
  relativeDir: string,
  basePath: string = defaultBasePath(),
): void {
  const normalizedRelative = normalizeProjectRelativePath(relativeDir, basePath);
  const remoteFs = getRemoteProjectFs();

  if (!remoteFs) {
    fs.mkdirSync(projectPath(normalizedRelative, basePath), { recursive: true });
    return;
  }

  if (!normalizedRelative) {
    return;
  }

  markRemoteDirectory(normalizedRelative);
  sendRemoteProjectCommand('file_mkdir_command', {
    path: normalizedRelative,
    options: { recursive: true },
  });
}

export function projectDirExists(
  relativeDir: string = '',
  basePath: string = defaultBasePath(),
): boolean {
  const normalizedRelative = tryNormalizeProjectRelativePath(relativeDir, basePath);
  if (normalizedRelative === null) {
    return false;
  }

  const remoteFs = getRemoteProjectFs();
  if (!remoteFs) {
    const resolvedPath = normalizedRelative
      ? projectPath(normalizedRelative, basePath)
      : getProjectRoot(basePath);
    try {
      return fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory();
    } catch {
      return false;
    }
  }

  if (!normalizedRelative) {
    return Boolean(getRemoteProjectCache()?.getProjectRoot?.());
  }

  const cache = getRemoteProjectCache();
  if (!cache) {
    return false;
  }

  if (cache.hasFile(normalizedRelative) === true) {
    return true;
  }

  return (cache.listEntries?.(normalizedRelative).length ?? 0) > 0;
}

export function listProjectEntries(
  relativeDir: string = '',
  basePath: string = defaultBasePath(),
): ProjectTreeEntry[] {
  const normalizedRelative = tryNormalizeProjectRelativePath(relativeDir, basePath);
  if (normalizedRelative === null) {
    return [];
  }

  const remoteFs = getRemoteProjectFs();
  if (!remoteFs) {
    const resolvedDir = normalizedRelative
      ? projectPath(normalizedRelative, basePath)
      : getProjectRoot(basePath);
    if (!fs.existsSync(resolvedDir)) {
      return [];
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(resolvedDir);
    } catch {
      return [];
    }
    if (!stats.isDirectory()) {
      return [];
    }

    try {
      return fs.readdirSync(resolvedDir, { withFileTypes: true })
        .map((entry): ProjectTreeEntry | null => {
          const entryPath = normalizedRelative
            ? `${normalizedRelative}/${entry.name}`
            : entry.name;
          if (entry.isDirectory()) {
            return { path: entryPath, type: 'directory' };
          }
          if (entry.isFile()) {
            try {
              const entryStats = fs.statSync(projectPath(entryPath, basePath));
              return { path: entryPath, type: 'file', size: entryStats.size };
            } catch {
              return { path: entryPath, type: 'file' };
            }
          }
          return null;
        })
        .filter((entry): entry is ProjectTreeEntry => entry !== null)
        .sort((a, b) => a.path.localeCompare(b.path));
    } catch {
      return [];
    }
  }

  const cache = getRemoteProjectCache();
  if (!cache) {
    return [];
  }

  const directEntries = cache.listEntries?.(normalizedRelative) ?? [];
  return directEntries
    .map((entry): ProjectTreeEntry => ({ path: entry.path, type: entry.type }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function listProjectTree(
  options: {
    relativeDir?: string;
    maxDepth?: number;
    excludeDirectories?: string[];
  } = {},
  basePath: string = defaultBasePath(),
): ProjectTreeEntry[] {
  const relativeDir = options.relativeDir ?? '';
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const excluded = new Set(options.excludeDirectories ?? []);
  const rootRelative = tryNormalizeProjectRelativePath(relativeDir, basePath);
  if (rootRelative === null) {
    return [];
  }

  const results: ProjectTreeEntry[] = [];
  const walk = (currentRelative: string, depth: number) => {
    if (depth > maxDepth) {
      return;
    }

    for (const entry of listProjectEntries(currentRelative, basePath)) {
      const basename = path.posix.basename(entry.path);
      if (entry.type === 'directory' && excluded.has(basename)) {
        continue;
      }

      results.push(entry);
      if (entry.type === 'directory') {
        walk(entry.path, depth + 1);
      }
    }
  };

  walk(rootRelative, 0);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

export function getKnownProjectPaths(basePath: string = defaultBasePath()): string[] {
  const remoteFs = getRemoteProjectFs();
  if (!remoteFs) {
    return listProjectTree({ maxDepth: Number.POSITIVE_INFINITY }, basePath)
      .filter(entry => entry.type === 'file')
      .map(entry => entry.path);
  }

  const cache = getRemoteProjectCache();
  if (!cache) {
    return [];
  }

  return (cache.listFiles?.('') ?? [])
    .slice()
    .sort((a, b) => a.localeCompare(b));
}

export function writeProjectText(
  relativePath: string,
  content: string,
  basePath: string = defaultBasePath(),
): void {
  const normalizedRelative = normalizeProjectRelativePath(relativePath, basePath);
  if (!normalizedRelative) {
    throw new Error('writeProjectText requires a file path inside the project root');
  }

  ensureProjectParent(normalizedRelative, basePath);

  const remoteFs = getRemoteProjectFs();
  if (!remoteFs) {
    atomicWriteFileSync(projectPath(normalizedRelative, basePath), content, 'utf-8');
    return;
  }

  getRemoteProjectCache()?.setFile(normalizedRelative, content);
  sendRemoteProjectCommand('file_write_command', {
    path: normalizedRelative,
    content,
  });
}

export function readProjectText(
  relativePath: string,
  basePath: string = defaultBasePath(),
): string | null {
  const normalizedRelative = normalizeProjectRelativePath(relativePath, basePath);
  if (!normalizedRelative) {
    return null;
  }

  const remoteFs = getRemoteProjectFs();
  if (!remoteFs) {
    const resolvedPath = projectPath(normalizedRelative, basePath);
    if (!fs.existsSync(resolvedPath)) {
      return null;
    }
    return fs.readFileSync(resolvedPath, 'utf-8');
  }

  return getRemoteProjectCache()?.getFile(normalizedRelative) ?? null;
}

export function writeProjectBuffer(
  relativePath: string,
  data: Buffer,
  basePath: string = defaultBasePath(),
): void {
  const normalizedRelative = normalizeProjectRelativePath(relativePath, basePath);
  if (!normalizedRelative) {
    throw new Error('writeProjectBuffer requires a file path inside the project root');
  }

  ensureProjectParent(normalizedRelative, basePath);

  const remoteFs = getRemoteProjectFs();
  if (!remoteFs) {
    atomicWriteFileSync(projectPath(normalizedRelative, basePath), data);
    return;
  }

  sendRemoteProjectCommand('file_write_buffer_command', {
    path: normalizedRelative,
    data: data.toString('base64'),
  });
}

export function ensureProjectPathDir(
  targetDir: string,
  basePath: string = defaultBasePath(),
): boolean {
  if (!isWithinProjectRoot(targetDir, basePath)) {
    return false;
  }

  ensureProjectDir(projectRelativePath(targetDir, basePath), basePath);
  return true;
}

export function writeProjectBufferAtPath(
  targetPath: string,
  data: Buffer,
  basePath: string = defaultBasePath(),
): boolean {
  if (!isWithinProjectRoot(targetPath, basePath)) {
    return false;
  }

  writeProjectBuffer(projectRelativePath(targetPath, basePath), data, basePath);
  return true;
}

export function projectExists(
  relativePath: string,
  basePath: string = defaultBasePath(),
): boolean {
  const normalizedRelative = normalizeProjectRelativePath(relativePath, basePath);
  if (!normalizedRelative) {
    return fs.existsSync(getProjectRoot(basePath));
  }

  const remoteFs = getRemoteProjectFs();
  if (!remoteFs) {
    return fs.existsSync(projectPath(normalizedRelative, basePath));
  }

  return getRemoteProjectCache()?.hasFile(normalizedRelative) ?? false;
}
