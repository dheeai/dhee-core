#!/usr/bin/env node
import { startProductionStdio } from './stdio.js';
startProductionStdio().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
