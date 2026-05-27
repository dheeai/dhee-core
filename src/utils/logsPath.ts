import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
export function getLogsDir(): string {
  const dir = join(process.cwd(), 'logs');
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}
