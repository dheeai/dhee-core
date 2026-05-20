import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  createProject,
  loadProject,
  addProjectInput,
  updateProjectInput,
  deleteProjectInput,
  getProjectInput,
  setPrimaryNarration,
  getInputsByPurpose,
  getNarrationContent,
  getAllInputs,
  hasInputs,
  getInputsByStatus,
  getProjectDir,
} from '../../../src/tasks/video/workflow/ProjectManager.js';
import type { ProjectInput } from '../../../src/tasks/video/workflow/types.js';

const TEST_BASE_PATH = '/tmp/dhee-input-test-' + Date.now();

describe('ProjectManager Input Functions', () => {
  beforeEach(() => {
    // Create test project
    createProject('Test story for input handling', 'cinematic_realism', TEST_BASE_PATH);
  });

  afterEach(() => {
    // Clean up
    try {
      fs.rmSync(TEST_BASE_PATH, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('addProjectInput', () => {
    it('should add an input to the project', () => {
      const input: Omit<ProjectInput, 'id'> = {
        source: {
          type: 'local_path',
          value: '/path/to/file.mp4',
        },
        mediaType: 'video',
        purpose: 'style_ref',
        metadata: {
          addedAt: Date.now(),
        },
        processing: {
          status: 'pending',
        },
      };

      const added = addProjectInput(input, TEST_BASE_PATH);

      expect(added.id).toBeDefined();
      expect(added.id).toMatch(/^input-/);
      expect(added.source.value).toBe('/path/to/file.mp4');
      expect(added.mediaType).toBe('video');
      expect(added.purpose).toBe('style_ref');
    });

    it('should create inputs directory structure', () => {
      const input: Omit<ProjectInput, 'id'> = {
        source: { type: 'inline', value: 'test content' },
        mediaType: 'text',
        purpose: 'narration',
        metadata: { addedAt: Date.now() },
        processing: { status: 'pending' },
      };

      addProjectInput(input, TEST_BASE_PATH);

      const inputsDir = path.join(getProjectDir(TEST_BASE_PATH), 'inputs');
      expect(fs.existsSync(inputsDir)).toBe(true);
      expect(fs.existsSync(path.join(inputsDir, 'local'))).toBe(true);
      expect(fs.existsSync(path.join(inputsDir, 'remote'))).toBe(true);
      expect(fs.existsSync(path.join(inputsDir, 'youtube'))).toBe(true);
    });

    it('should persist input to project file', () => {
      const input: Omit<ProjectInput, 'id'> = {
        source: { type: 'inline', value: 'test' },
        mediaType: 'text',
        purpose: 'narration',
        metadata: { addedAt: Date.now() },
        processing: { status: 'pending' },
      };

      addProjectInput(input, TEST_BASE_PATH);

      const project = loadProject(TEST_BASE_PATH);
      expect(project?.inputs).toBeDefined();
      expect(project?.inputs?.length).toBe(1);
    });
  });

  describe('updateProjectInput', () => {
    it('should update an existing input', () => {
      const input: Omit<ProjectInput, 'id'> = {
        source: { type: 'inline', value: 'test' },
        mediaType: 'text',
        purpose: 'narration',
        metadata: { addedAt: Date.now() },
        processing: { status: 'pending' },
      };

      const added = addProjectInput(input, TEST_BASE_PATH);
      const updated = updateProjectInput(
        added.id,
        {
          processing: { status: 'completed', localPath: '/path/to/processed' },
        },
        TEST_BASE_PATH
      );

      expect(updated).not.toBeNull();
      expect(updated?.processing.status).toBe('completed');
      expect(updated?.processing.localPath).toBe('/path/to/processed');
    });

    it('should return null for non-existent input', () => {
      const result = updateProjectInput('non-existent-id', { notes: 'test' }, TEST_BASE_PATH);
      expect(result).toBeNull();
    });
  });

  describe('deleteProjectInput', () => {
    it('should delete an existing input', () => {
      const input: Omit<ProjectInput, 'id'> = {
        source: { type: 'inline', value: 'test' },
        mediaType: 'text',
        purpose: 'narration',
        metadata: { addedAt: Date.now() },
        processing: { status: 'pending' },
      };

      const added = addProjectInput(input, TEST_BASE_PATH);
      const deleted = deleteProjectInput(added.id, TEST_BASE_PATH);

      expect(deleted).toBe(true);
      expect(getProjectInput(added.id, TEST_BASE_PATH)).toBeNull();
    });

    it('should return false for non-existent input', () => {
      const result = deleteProjectInput('non-existent-id', TEST_BASE_PATH);
      expect(result).toBe(false);
    });
  });

  describe('getProjectInput', () => {
    it('should return an input by ID', () => {
      const input: Omit<ProjectInput, 'id'> = {
        source: { type: 'inline', value: 'test content' },
        mediaType: 'text',
        purpose: 'narration',
        metadata: { addedAt: Date.now() },
        processing: { status: 'pending' },
      };

      const added = addProjectInput(input, TEST_BASE_PATH);
      const retrieved = getProjectInput(added.id, TEST_BASE_PATH);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(added.id);
      expect(retrieved?.source.value).toBe('test content');
    });

    it('should return null for non-existent input', () => {
      const result = getProjectInput('non-existent-id', TEST_BASE_PATH);
      expect(result).toBeNull();
    });
  });

  describe('setPrimaryNarration', () => {
    it('should set text input as primary narration', () => {
      const input: Omit<ProjectInput, 'id'> = {
        source: { type: 'inline', value: 'Story narration text' },
        mediaType: 'text',
        purpose: 'narration',
        metadata: { addedAt: Date.now() },
        processing: { status: 'completed', localPath: '/tmp/test.txt' },
      };

      const added = addProjectInput(input, TEST_BASE_PATH);
      setPrimaryNarration(added.id, false, TEST_BASE_PATH);

      const project = loadProject(TEST_BASE_PATH);
      expect(project?.primaryNarration).toBeDefined();
      expect(project?.primaryNarration?.inputId).toBe(added.id);
      expect(project?.primaryNarration?.type).toBe('text');
      expect(project?.primaryNarration?.preserveAudio).toBe(false);
    });

    it('should set audio input as primary narration with preserved audio', () => {
      const input: Omit<ProjectInput, 'id'> = {
        source: { type: 'local_path', value: '/path/to/narration.mp3' },
        mediaType: 'audio',
        purpose: 'narration',
        metadata: { addedAt: Date.now() },
        processing: { status: 'completed' },
      };

      const added = addProjectInput(input, TEST_BASE_PATH);
      setPrimaryNarration(added.id, true, TEST_BASE_PATH);

      const project = loadProject(TEST_BASE_PATH);
      expect(project?.primaryNarration?.type).toBe('audio');
      expect(project?.primaryNarration?.preserveAudio).toBe(true);
    });

    it('should throw for non-existent input', () => {
      expect(() => setPrimaryNarration('non-existent', true, TEST_BASE_PATH)).toThrow(
        'Input not found'
      );
    });
  });

  describe('getInputsByPurpose', () => {
    it('should return inputs filtered by purpose', () => {
      // Add multiple inputs with different purposes
      addProjectInput(
        {
          source: { type: 'inline', value: 'narration 1' },
          mediaType: 'text',
          purpose: 'narration',
          metadata: { addedAt: Date.now() },
          processing: { status: 'pending' },
        },
        TEST_BASE_PATH
      );
      addProjectInput(
        {
          source: { type: 'local_path', value: '/path/style.jpg' },
          mediaType: 'image',
          purpose: 'style_ref',
          metadata: { addedAt: Date.now() },
          processing: { status: 'pending' },
        },
        TEST_BASE_PATH
      );
      addProjectInput(
        {
          source: { type: 'inline', value: 'narration 2' },
          mediaType: 'text',
          purpose: 'narration',
          metadata: { addedAt: Date.now() },
          processing: { status: 'pending' },
        },
        TEST_BASE_PATH
      );

      const narrationInputs = getInputsByPurpose('narration', TEST_BASE_PATH);
      const styleInputs = getInputsByPurpose('style_ref', TEST_BASE_PATH);

      expect(narrationInputs).toHaveLength(2);
      expect(styleInputs).toHaveLength(1);
    });

    it('should return empty array when no inputs match', () => {
      const result = getInputsByPurpose('anchor_video', TEST_BASE_PATH);
      expect(result).toHaveLength(0);
    });
  });

  describe('getAllInputs', () => {
    it('should return all inputs', () => {
      addProjectInput(
        {
          source: { type: 'inline', value: 'test 1' },
          mediaType: 'text',
          purpose: 'narration',
          metadata: { addedAt: Date.now() },
          processing: { status: 'pending' },
        },
        TEST_BASE_PATH
      );
      addProjectInput(
        {
          source: { type: 'inline', value: 'test 2' },
          mediaType: 'text',
          purpose: 'reference_general',
          metadata: { addedAt: Date.now() },
          processing: { status: 'pending' },
        },
        TEST_BASE_PATH
      );

      const all = getAllInputs(TEST_BASE_PATH);
      expect(all).toHaveLength(2);
    });

    it('should return empty array when no inputs', () => {
      const all = getAllInputs(TEST_BASE_PATH);
      expect(all).toHaveLength(0);
    });
  });

  describe('hasInputs', () => {
    it('should return false when no inputs', () => {
      expect(hasInputs(TEST_BASE_PATH)).toBe(false);
    });

    it('should return true when inputs exist', () => {
      addProjectInput(
        {
          source: { type: 'inline', value: 'test' },
          mediaType: 'text',
          purpose: 'narration',
          metadata: { addedAt: Date.now() },
          processing: { status: 'pending' },
        },
        TEST_BASE_PATH
      );

      expect(hasInputs(TEST_BASE_PATH)).toBe(true);
    });
  });

  describe('getInputsByStatus', () => {
    it('should return inputs filtered by status', () => {
      addProjectInput(
        {
          source: { type: 'inline', value: 'pending' },
          mediaType: 'text',
          purpose: 'narration',
          metadata: { addedAt: Date.now() },
          processing: { status: 'pending' },
        },
        TEST_BASE_PATH
      );

      const pending = addProjectInput(
        {
          source: { type: 'inline', value: 'also pending' },
          mediaType: 'text',
          purpose: 'narration',
          metadata: { addedAt: Date.now() },
          processing: { status: 'pending' },
        },
        TEST_BASE_PATH
      );

      // Update one to completed
      updateProjectInput(
        pending.id,
        { processing: { status: 'completed' } },
        TEST_BASE_PATH
      );

      const pendingInputs = getInputsByStatus('pending', TEST_BASE_PATH);
      const completedInputs = getInputsByStatus('completed', TEST_BASE_PATH);

      expect(pendingInputs).toHaveLength(1);
      expect(completedInputs).toHaveLength(1);
    });
  });

  describe('getNarrationContent', () => {
    it('should return null when no primary narration set', () => {
      const content = getNarrationContent(TEST_BASE_PATH);
      expect(content).toBeNull();
    });

    it('should return inline text content', () => {
      const testContent = 'Once upon a time in a faraway land...';
      const input = addProjectInput(
        {
          source: { type: 'inline', value: testContent },
          mediaType: 'text',
          purpose: 'narration',
          metadata: { addedAt: Date.now() },
          processing: { status: 'completed' },
        },
        TEST_BASE_PATH
      );

      setPrimaryNarration(input.id, false, TEST_BASE_PATH);
      const content = getNarrationContent(TEST_BASE_PATH);

      expect(content).not.toBeNull();
      expect(content?.content).toBe(testContent);
      expect(content?.audioPath).toBeUndefined();
    });

    it('should return transcription for audio with preserved audio', () => {
      const transcription = 'This is the transcribed narration.';
      const audioPath = '/tmp/test-audio.mp3';

      const input = addProjectInput(
        {
          source: { type: 'local_path', value: audioPath },
          mediaType: 'audio',
          purpose: 'narration',
          metadata: { addedAt: Date.now() },
          processing: {
            status: 'completed',
            localPath: audioPath,
            transcription,
            timingMarkers: [
              { start: 0, end: 2.5, text: 'This is' },
              { start: 2.5, end: 5, text: 'the transcribed narration.' },
            ],
          },
        },
        TEST_BASE_PATH
      );

      setPrimaryNarration(input.id, true, TEST_BASE_PATH);
      const content = getNarrationContent(TEST_BASE_PATH);

      expect(content?.content).toBe(transcription);
      expect(content?.audioPath).toBe(audioPath);
      expect(content?.timingMarkers).toHaveLength(2);
    });
  });
});
