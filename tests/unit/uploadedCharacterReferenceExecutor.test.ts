import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutorAgent } from '../../src/core/planner/ExecutorAgent.js';
import { DependencyGraphExecutor } from '../../src/core/planner/DependencyGraphExecutor.js';
import { resolveInputs } from '../../src/core/planner/contentResolver.js';
import type { ExecutionNode, ExecutorState } from '../../src/core/planner/types.js';
import type { ProjectInput } from '../../src/tasks/video/workflow/types.js';

const template = {
  id: 'test-template',
  name: 'Test Template',
  version: '1.0',
  description: 'test',
  artifactTypes: {
    character_image: {
      id: 'character_image',
      displayName: 'Character Reference Image',
      category: 'visual_ref',
      isCollection: true,
      isExpensive: true,
      dependencies: [],
      filePattern: 'prompts/images/characters/{{name}}.json',
    },
    setting_image: {
      id: 'setting_image',
      displayName: 'Setting Reference Image',
      category: 'visual_ref',
      isCollection: true,
      isExpensive: true,
      dependencies: [],
      filePattern: 'prompts/images/settings/{{name}}.json',
    },
    shot_image: {
      id: 'shot_image',
      displayName: 'Shot Image',
      category: 'visual_ref',
      isCollection: true,
      isExpensive: true,
      dependencies: [],
      filePattern: 'prompts/images/shots/{{name}}.json',
    },
  },
  phases: [],
  constraints: {},
  contextVariables: {},
} as any;

let tempDir: string | null = null;

class ThrowingLLM {
  calls = 0;

  async generate(): Promise<never> {
    this.calls += 1;
    throw new Error('LLM should not be called');
  }
}

function makeProjectDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'dhee-uploaded-charref-executor-'));
  mkdirSync(join(tempDir, 'assets/uploads/characters'), { recursive: true });
  mkdirSync(join(tempDir, 'assets/uploads/settings'), { recursive: true });
  mkdirSync(join(tempDir, 'logs'), { recursive: true });
  return tempDir;
}

function makeState(nodes: Record<string, Partial<ExecutionNode>>): ExecutorState {
  const fullNodes: Record<string, ExecutionNode> = {};
  for (const [id, partial] of Object.entries(nodes)) {
    fullNodes[id] = {
      id,
      typeId: partial.typeId ?? id.split(':')[0]!,
      status: partial.status ?? 'pending',
      displayName: partial.displayName ?? id,
      isExpensive: partial.isExpensive ?? false,
      isCollection: partial.isCollection ?? false,
      dependencies: partial.dependencies ?? [],
      dependents: partial.dependents ?? [],
      itemId: partial.itemId,
      ...partial,
    } as ExecutionNode;
  }
  return {
    nodes: fullNodes,
    targetArtifacts: ['character_image'],
    goalDescription: 'test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as ExecutorState;
}

function characterInput(filename: string): ProjectInput {
  return {
    id: 'input-boy',
    source: {
      type: 'local_path',
      value: `assets/uploads/characters/${filename}`,
    },
    mediaType: 'image',
    purpose: 'character_ref',
    metadata: {
      originalFilename: filename,
      addedAt: 1,
      processedAt: 1,
    },
    processing: {
      status: 'completed',
      localPath: `assets/uploads/characters/${filename}`,
    },
  };
}

function settingInput(filename: string): ProjectInput {
  return {
    id: 'input-field',
    source: {
      type: 'local_path',
      value: `assets/uploads/settings/${filename}`,
    },
    mediaType: 'image',
    purpose: 'setting_ref',
    metadata: {
      originalFilename: filename,
      addedAt: 1,
      processedAt: 1,
      referenceRole: 'setting',
    },
    processing: {
      status: 'completed',
      localPath: `assets/uploads/settings/${filename}`,
    },
  };
}

function makeAgent(projectDir: string, state: ExecutorState, inputs: ProjectInput[], llm: ThrowingLLM): ExecutorAgent {
  return new ExecutorAgent(llm as any, {
    template,
    project: {
      version: '3.0',
      id: 'uploaded-charref-test',
      title: 'Uploaded Char Ref Test',
      templateId: 'test-template',
      templateVersion: '1.0',
      style: 'cinematic_realism',
      inputType: 'idea',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      artifacts: {},
      assets: [],
      contextStore: {},
      settings: [],
      inputs,
      executorState: state,
    } as any,
    projectDir,
    goal: {
      description: 'test',
      targetArtifacts: ['character_image'],
      preferences: {},
    },
    name: 'test-executor',
  });
}

describe('uploaded character references in executor graph', () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('uses an uploaded character image to complete a pending character_image node', async () => {
    const projectDir = makeProjectDir();
    writeFileSync(join(projectDir, 'assets/uploads/characters/boy.png'), 'image');
    const llm = new ThrowingLLM();

    const agent = makeAgent(projectDir, makeState({
      'character_image:leo': {
        typeId: 'character_image',
        itemId: 'leo',
        displayName: 'Character Reference Images: Leo',
        status: 'pending',
        isCollection: true,
        isExpensive: true,
      },
    }), [characterInput('boy.png')], llm);

    const result = await agent.run('');

    expect(result.status).toBe('completed');
    expect(llm.calls).toBe(0);

    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8'));
    const node = project.executorState.nodes['character_image:leo'];
    expect(node.status).toBe('completed');
    expect(node.outputPath).toBe('assets/uploads/characters/boy.png');
    expect(node.artifactId).toBe('uploaded_charref_leo_input-boy');
    expect(project.inputs[0].metadata).toEqual(expect.objectContaining({
      matchedCharacterId: 'leo',
      matchedCharacterName: 'Leo',
      matchStrategy: 'ordered_fallback',
    }));

    const manifest = JSON.parse(readFileSync(join(projectDir, 'assets/manifest.json'), 'utf-8'));
    expect(manifest.assets).toEqual([
      expect.objectContaining({
        id: 'uploaded_charref_leo_input-boy',
        type: 'character_ref',
        path: 'assets/uploads/characters/boy.png',
        nodeId: 'character_image:leo',
        metadata: expect.objectContaining({
          source: 'user_upload',
          inputId: 'input-boy',
          originalFilename: 'boy.png',
          matchStrategy: 'ordered_fallback',
        }),
      }),
    ]);
  });

  it('prefers the uploaded reference over an existing promptPath on a reset node', async () => {
    const projectDir = makeProjectDir();
    writeFileSync(join(projectDir, 'assets/uploads/characters/boy.png'), 'image');
    mkdirSync(join(projectDir, 'prompts/images/characters'), { recursive: true });
    writeFileSync(join(projectDir, 'prompts/images/characters/leo.json'), JSON.stringify({
      imagePrompt: 'Generated prompt that should not be used',
    }));
    const llm = new ThrowingLLM();

    const agent = makeAgent(projectDir, makeState({
      'character_image:leo': {
        typeId: 'character_image',
        itemId: 'leo',
        displayName: 'Character Reference Images: Leo',
        status: 'pending',
        isCollection: true,
        isExpensive: true,
        promptPath: 'prompts/images/characters/leo.json',
      },
    }), [characterInput('boy.png')], llm);

    await agent.run('');

    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8'));
    expect(project.executorState.nodes['character_image:leo'].outputPath).toBe(
      'assets/uploads/characters/boy.png',
    );
    expect(llm.calls).toBe(0);
  });

  it('uses an uploaded setting image to complete a pending setting_image node', async () => {
    const projectDir = makeProjectDir();
    writeFileSync(join(projectDir, 'assets/uploads/settings/field.png'), 'image');
    const llm = new ThrowingLLM();

    const agent = makeAgent(projectDir, makeState({
      'setting_image:football_field': {
        typeId: 'setting_image',
        itemId: 'football_field',
        displayName: 'Setting Reference Images: football field',
        status: 'pending',
        isCollection: true,
        isExpensive: true,
      },
    }), [settingInput('field.png')], llm);

    const result = await agent.run('');

    expect(result.status).toBe('completed');
    expect(llm.calls).toBe(0);

    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8'));
    const node = project.executorState.nodes['setting_image:football_field'];
    expect(node.status).toBe('completed');
    expect(node.outputPath).toBe('assets/uploads/settings/field.png');
    expect(node.artifactId).toBe('uploaded_settingref_football_field_input-field');
    expect(project.inputs[0].metadata).toEqual(expect.objectContaining({
      matchedSettingId: 'football_field',
      matchedSettingName: 'football field',
      matchStrategy: 'filename',
    }));
    expect(project.settings[0]).toEqual(expect.objectContaining({
      id: 'football_field',
      referenceImagePath: 'assets/uploads/settings/field.png',
    }));

    const manifest = JSON.parse(readFileSync(join(projectDir, 'assets/manifest.json'), 'utf-8'));
    expect(manifest.assets).toEqual([
      expect.objectContaining({
        id: 'uploaded_settingref_football_field_input-field',
        type: 'setting_ref',
        path: 'assets/uploads/settings/field.png',
        nodeId: 'setting_image:football_field',
        metadata: expect.objectContaining({
          source: 'user_upload',
          inputId: 'input-field',
          originalFilename: 'field.png',
          matchStrategy: 'filename',
        }),
      }),
    ]);
  });

  it('lets downstream shot inputs resolve the uploaded character path through the graph', () => {
    const projectDir = makeProjectDir();
    writeFileSync(join(projectDir, 'assets/uploads/characters/boy.png'), 'image');

    const executor = DependencyGraphExecutor.fromState(makeState({
      'character_image:leo': {
        typeId: 'character_image',
        itemId: 'leo',
        displayName: 'Character Reference Images: Leo',
        status: 'completed',
        outputPath: 'assets/uploads/characters/boy.png',
      },
      'shot_image:scene_1_shot_1': {
        typeId: 'shot_image',
        itemId: 'scene_1_shot_1',
        displayName: 'Shot Images: S1 Shot 1',
        status: 'pending',
        dependencies: ['character_image:leo'],
      },
    }), template);

    const shotNode = executor.getNode('shot_image:scene_1_shot_1');
    expect(shotNode).toBeDefined();
    const inputs = resolveInputs(shotNode!, executor, projectDir);

    expect(existsSync(join(projectDir, inputs.referenceImages[0]!.path))).toBe(true);
    expect(inputs.referenceImages).toEqual([
      {
        name: 'leo',
        path: 'assets/uploads/characters/boy.png',
        type: 'character',
      },
    ]);
  });

  it('lets downstream shot inputs resolve the uploaded setting path through the graph', () => {
    const projectDir = makeProjectDir();
    writeFileSync(join(projectDir, 'assets/uploads/settings/field.png'), 'image');

    const executor = DependencyGraphExecutor.fromState(makeState({
      'setting_image:field': {
        typeId: 'setting_image',
        itemId: 'field',
        displayName: 'Setting Reference Images: field',
        status: 'completed',
        outputPath: 'assets/uploads/settings/field.png',
      },
      'shot_image:scene_1_shot_1': {
        typeId: 'shot_image',
        itemId: 'scene_1_shot_1',
        displayName: 'Shot Images: S1 Shot 1',
        status: 'pending',
        dependencies: ['setting_image:field'],
      },
    }), template);

    const shotNode = executor.getNode('shot_image:scene_1_shot_1');
    expect(shotNode).toBeDefined();
    const inputs = resolveInputs(shotNode!, executor, projectDir);

    expect(existsSync(join(projectDir, inputs.referenceImages[0]!.path))).toBe(true);
    expect(inputs.referenceImages).toEqual([
      {
        name: 'field',
        path: 'assets/uploads/settings/field.png',
        type: 'setting',
      },
    ]);
  });
});
