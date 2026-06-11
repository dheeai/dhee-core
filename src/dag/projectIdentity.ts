import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function normalizeProjectDirForIdentity(projectDir: string): string {
  return resolve(projectDir).replace(/\\/g, '/').replace(/\/+$/, '');
}

export function readProjectId(projectDir: string): string | null {
  try {
    const projectJsonPath = join(projectDir, 'project.json');
    if (!existsSync(projectJsonPath)) return null;
    const project = JSON.parse(readFileSync(projectJsonPath, 'utf8')) as {
      projectId?: unknown;
    };
    const projectId = typeof project.projectId === 'string'
      ? project.projectId.trim()
      : '';
    return projectId || null;
  } catch {
    return null;
  }
}

export function getProjectCacheScope(projectDir: string): string {
  return readProjectId(projectDir) ?? normalizeProjectDirForIdentity(projectDir);
}
