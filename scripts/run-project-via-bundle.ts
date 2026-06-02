#!/usr/bin/env tsx
import 'dotenv/config';
import { runProjectViaBundle } from '../src/server/runners/runProjectViaBundle.js';

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: pnpm tsx scripts/run-project-via-bundle.ts <projectDir> [--stopAt <nodeId>]');
  process.exit(1);
}
const projectDir = args[0]!;
let stopAt: string | undefined;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--stopAt') { stopAt = args[i + 1]; i++; }
}

const result = await runProjectViaBundle({ projectDir, ...(stopAt ? { stopAt } : {}) });
if (!result.ok) {
  console.error(`\n✗ ${result.error}`);
  process.exit(1);
}
console.log(`\n✓ Bundle walk complete.`);
if (result.finalVideoAbs) console.log(`  Final video: ${result.finalVideoAbs}`);
