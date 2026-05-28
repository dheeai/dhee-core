/**
 * dhee_get_status — read walkState for a project and summarize as
 * status counts + a per-failed-node detail block.
 *
 * Intentionally NOT the full walkState dump — the LLM doesn't need
 * the entire JSON, just enough to (a) tell the user how the run is
 * going and (b) pick a node to investigate or regenerate.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

const Params = Type.Object({
  projectDir: Type.String({
    description: 'Absolute path to the project directory. Required.',
  }),
});

interface NodeEntry {
  status: string;
  outputPath?: string;
  itemId?: string;
  error?: string;
}

interface ProjectJsonLite {
  walkState?: {
    nodes?: Record<string, NodeEntry>;
    lastInvalidatedIds?: string[];
  };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

export function makeGetStatusTool() {
  return defineTool({
    name: 'dhee_get_status',
    label: 'Project status',
    description:
      'Summarize current run progress for a project — counts of pending / in_progress / completed / failed nodes, with the error text for every failed node. Read-only.',
    parameters: Params,
    async execute(_id, params) {
      const projectJsonPath = join(params.projectDir, 'project.json');
      if (!existsSync(projectJsonPath)) {
        return textResult(`project.json not found at ${projectJsonPath}`, true);
      }
      let project: ProjectJsonLite;
      try {
        project = JSON.parse(readFileSync(projectJsonPath, 'utf8'));
      } catch (err) {
        return textResult(`project.json failed to parse: ${(err as Error).message}`, true);
      }
      const nodes = project.walkState?.nodes ?? {};
      const buckets: Record<string, string[]> = {
        pending: [],
        in_progress: [],
        completed: [],
        failed: [],
      };
      const failedDetail: string[] = [];
      for (const [key, entry] of Object.entries(nodes)) {
        const status = entry.status;
        if (buckets[status]) buckets[status].push(key);
        else buckets[status] = [key];
        if (status === 'failed') {
          failedDetail.push(
            `  - ${key}${entry.error ? `\n      error: ${entry.error}` : ''}${entry.outputPath ? `\n      outputPath: ${entry.outputPath}` : ''}`,
          );
        }
      }
      const summary = [
        `Project: ${params.projectDir}`,
        `Status counts:`,
        `  pending:     ${buckets['pending']?.length ?? 0}`,
        `  in_progress: ${buckets['in_progress']?.length ?? 0}`,
        `  completed:   ${buckets['completed']?.length ?? 0}`,
        `  failed:      ${buckets['failed']?.length ?? 0}`,
      ];
      if (failedDetail.length > 0) {
        summary.push(``, `Failed nodes:`, ...failedDetail);
      }
      const invalidated = project.walkState?.lastInvalidatedIds ?? [];
      if (invalidated.length > 0) {
        summary.push(``, `Recently invalidated (will re-run on next dispatch): ${invalidated.join(', ')}`);
      }
      return textResult(summary.join('\n'));
    },
  });
}

export const dheeGetStatusTool = makeGetStatusTool();
