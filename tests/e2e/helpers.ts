/**
 * E2E Test Helpers
 *
 * Utilities for running the executor one step at a time and validating outputs.
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LLMClient } from '../../src/core/llm/index.js';
import { ExecutorAgent } from '../../src/core/planner/ExecutorAgent.js';
import { narrativeTemplate } from '../../src/templates/narrative.js';
import type { GenericProjectFile, VideoTemplate } from '../../src/core/templates/types.js';
import type { ExecutionNode } from '../../src/core/planner/types.js';

/**
 * Create a test project directory with original_input.md.
 */
export function createTestProject(inputText?: string): string {
  const projectDir = join(tmpdir(), `dhee-e2e-${Date.now()}`);
  mkdirSync(projectDir, { recursive: true });

  // Copy fixture or use provided text
  const input = inputText ?? readFileSync(join(__dirname, 'fixtures', 'original_input.md'), 'utf-8');
  writeFileSync(join(projectDir, 'original_input.md'), input);

  // Create empty project.json
  const project: GenericProjectFile = {
    version: '3.0',
    id: `test_${Date.now()}`,
    title: 'E2E Test Project',
    templateId: 'narrative',
    templateVersion: '3.0.0',
    style: 'cinematic_realism',
    inputType: 'idea',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    artifacts: {},
    assets: [],
    contextStore: {},
  };
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(project, null, 2));

  return projectDir;
}

/**
 * Create an LLM client from environment variables.
 */
export function createTestLLM(): LLMClient {
  return new LLMClient({
    baseUrl: process.env['LLM_BASE_URL'],
    apiKey: process.env['LLM_API_KEY'],
    model: process.env['LLM_MODEL'],
  });
}

/**
 * Create an ExecutorAgent for a test project.
 */
export function createTestExecutor(
  projectDir: string,
  llm: LLMClient,
  template: VideoTemplate = narrativeTemplate,
  options?: { stopAfterNodeType?: string; skipMediaGeneration?: boolean },
): ExecutorAgent {
  const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8')) as GenericProjectFile;

  return new ExecutorAgent(llm, {
    template,
    project,
    projectDir,
    goal: {
      targetArtifacts: ['final_video'],
      preferences: { style: 'cinematic_realism', duration: 60 },
      description: 'Create a 1-minute cinematic video',
    },
    name: 'e2e-test',
    stopAfterNodeType: options?.stopAfterNodeType,
    skipMediaGeneration: options?.skipMediaGeneration,
  });
}

/**
 * Run the executor until a specific node type completes (or the first node completes).
 * Returns the completed node.
 */
export async function runUntilNodeCompletes(
  executor: ExecutorAgent,
  targetTypeId?: string,
): Promise<{ node: ExecutionNode; outputPath: string } | null> {
  const graph = executor.getExecutor();

  return new Promise((resolve) => {
    let resolved = false;

    // Listen for node completion via events
    executor.on('agent_text', (event) => {
      if (resolved) return;

      // Check if the target node completed
      const allNodes = graph.getAllNodes();
      for (const node of allNodes) {
        if (node.status === 'completed' && node.outputPath) {
          if (!targetTypeId || node.typeId === targetTypeId) {
            resolved = true;
            executor.stop();
            resolve({ node, outputPath: node.outputPath });
            return;
          }
        }
      }
    });

    // Also listen for completion/error
    executor.on('notification', () => {
      // Track notifications if needed
    });

    // Start execution
    executor.run('Continue').then(() => {
      if (!resolved) {
        // Executor finished without finding the target
        const allNodes = graph.getAllNodes();
        const completed = allNodes.filter(n => n.status === 'completed' && n.outputPath);
        if (targetTypeId) {
          const match = completed.find(n => n.typeId === targetTypeId);
          if (match) {
            resolve({ node: match, outputPath: match.outputPath! });
          } else {
            resolve(null);
          }
        } else if (completed.length > 0) {
          resolve({ node: completed[completed.length - 1], outputPath: completed[completed.length - 1].outputPath! });
        } else {
          resolve(null);
        }
      }
    });
  });
}

/**
 * Read and parse a JSON output file from the project.
 */
export function readJsonOutput(projectDir: string, relativePath: string): unknown {
  const fullPath = join(projectDir, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Output file not found: ${fullPath}`);
  }
  const content = readFileSync(fullPath, 'utf-8');
  let cleaned = content.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return JSON.parse(cleaned);
}

/**
 * Read a markdown output file from the project.
 */
export function readMdOutput(projectDir: string, relativePath: string): string {
  const fullPath = join(projectDir, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Output file not found: ${fullPath}`);
  }
  return readFileSync(fullPath, 'utf-8');
}

/**
 * Get the executor's project.json (reloaded from disk).
 */
export function reloadProject(projectDir: string): GenericProjectFile {
  return JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8'));
}

/**
 * Count words in a string.
 */
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Check if a string contains "image N" references.
 */
export function extractImageReferences(text: string): number[] {
  const matches = text.matchAll(/(?:from\s+)?image\s+(\d+)/gi);
  return [...matches].map(m => parseInt(m[1], 10));
}
