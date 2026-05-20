/**
 * Pure helper that formats the user-facing notification when the
 * executor gives up after exhausting its retry attempts.
 *
 * Lives in its own module (rather than inlined in ExecutorAgent's
 * run loop) so the formatting can be unit-tested without standing
 * up the full agent. The notification flows into the chat as the
 * `level: 'error'` event the user sees just before the executor
 * stops, so the format directly determines whether the failure is
 * actionable or silent.
 */
import type { ExecutionNode } from './types.js';

export function buildFailedNodesNotification(
  failedNodes: ExecutionNode[],
  maxRetries: number,
): string {
  const header =
    `${failedNodes.length} node(s) failed after ${maxRetries} retry attempt(s):`;
  const lines = failedNodes.map(n => {
    const err = n.error?.trim();
    return err ? `  - ${n.displayName}: ${err}` : `  - ${n.displayName}`;
  });
  return `${header}\n${lines.join('\n')}\nSend any message to retry.`;
}
