#!/usr/bin/env tsx
/**
 * Signal a running `pnpm run-to` (or any executor) to stop.
 *
 * Drops `.executor.stop` in the project dir; the executor consumes
 * it on its next loop tick, calls its in-process `stop()` (which
 * cancels ComfyUI in-flight work), and exits with stopReason='cancelled'.
 *
 * Usage:
 *   pnpm stop <project>
 *
 * Out-of-process by design: any caller that can write a file can
 * stop the executor — pi agent, Hermes, OpenClaw, a panicked human.
 */
import { resolve } from 'path';
import { existsSync } from 'fs';
import { writeStopFile } from '../src/core/planner/stopFile.js';

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || argv[0] === '--help' || argv[0] === '-h') {
    console.error('Usage: pnpm stop <project>');
    process.exit(argv[0] === '--help' || argv[0] === '-h' ? 0 : 1);
  }
  const projectName = argv[0]!;
  const projectDir = resolve(`${projectName}.dhee`);
  if (!existsSync(projectDir)) {
    console.error(`Project not found: ${projectDir}`);
    process.exit(1);
  }
  writeStopFile(projectDir);
  console.log(`stop signal sent to ${projectName} (${projectDir}/.executor.stop)`);
  console.log('Running executor will pick this up on its next loop tick (~250ms).');
}

main();
