import type { Runner } from './types.js';

export function defineRunner<T extends Runner>(runner: T): T {
  return runner;
}
