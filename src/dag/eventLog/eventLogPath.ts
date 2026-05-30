import { join } from 'node:path';

/** Location of the event log file for a given project. */
export function eventLogPath(projectDir: string): string {
  return join(projectDir, '.dhee', 'events.jsonl');
}

/** The `.dhee` directory for a given project (holds events.jsonl + future state). */
export function dheeDir(projectDir: string): string {
  return join(projectDir, '.dhee');
}
