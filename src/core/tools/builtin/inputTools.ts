/**
 * Input Tools - Agent tools for managing multi-input projects.
 *
 * These tools allow the agent to:
 * - Add new inputs from various sources (files, URLs, YouTube)
 * - List all project inputs
 * - Read processed input content
 * - Use inputs as references for generation
 * - Get audio timing for video synchronization
 */

import type { ToolDefinition } from '../../llm/index.js';
import { createTool } from '../ToolRegistry.js';
import {
  inputDetector,
  inputClassifier,
  inputProcessor,
  type ProjectInput,
  type InputPurpose,
  type AnchorWorkflowMode,
} from '../../inputs/index.js';
import {
  loadProject,
  saveProject,
  addProjectInput,
  updateProjectInput,
  getInputsByPurpose,
  getNarrationContent,
  setPrimaryNarration,
} from '../../../tasks/video/workflow/ProjectManager.js';
import * as fs from 'fs';
import {
  projectExists,
  projectRelativePath,
} from '../../../tasks/video/workflow/projectFileIO.js';

function referencePathExists(targetPath: string): boolean {
  if (fs.existsSync(targetPath)) {
    return true;
  }

  try {
    return projectExists(projectRelativePath(targetPath));
  } catch {
    return projectExists(targetPath);
  }
}

/**
 * Add a new input to the project.
 */
export const addInputTool: ToolDefinition = createTool(
  'add_input',
  `Add a new input to the project. Accepts:
- Local file paths: /path/to/file.mp4
- Remote URLs: https://example.com/video.mp4
- YouTube URLs: https://youtube.com/watch?v=xyz
- Inline text: Just paste the text directly

The tool will detect the input type and process it accordingly.
If purpose is not specified, you should ask the user to confirm the intended purpose.

Parameters:
- input: The input string (file path, URL, or text content)
- purpose: Optional - how this input should be used (narration, style_ref, character_ref, setting_ref, motion_ref, anchor_video, background_music)
- anchor_mode: Required if purpose is anchor_video - how to use the anchor video (b_roll_overlay, scene_integration, audio_extraction)
- notes: Optional - user notes about this input`,
  {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'The input (file path, URL, or text content)',
      },
      purpose: {
        type: 'string',
        enum: [
          'narration',
          'style_ref',
          'motion_ref',
          'character_ref',
          'setting_ref',
          'anchor_video',
          'background_music',
          'reference_general',
        ],
        description: 'How this input should be used in the project',
      },
      anchor_mode: {
        type: 'string',
        enum: ['b_roll_overlay', 'scene_integration', 'audio_extraction'],
        description: 'Required if purpose is anchor_video - how to use the anchor video',
      },
      notes: {
        type: 'string',
        description: 'Optional notes about this input',
      },
    },
    required: ['input'],
  },
  async (args) => {
    const inputValue = args['input'] as string;
    const purpose = args['purpose'] as InputPurpose | undefined;
    const anchorMode = args['anchor_mode'] as AnchorWorkflowMode | undefined;
    const notes = args['notes'] as string | undefined;

    if (!inputValue) {
      return { status: 'error', error: 'input is required' };
    }

    // Validate anchor_mode requirement
    if (purpose === 'anchor_video' && !anchorMode) {
      return {
        status: 'error',
        error: 'anchor_mode is required when purpose is anchor_video',
      };
    }

    try {
      // Detect input type
      const detection = inputDetector.detect(inputValue);

      // Determine purpose if not provided
      let finalPurpose = purpose;
      let needsUserConfirmation = false;

      if (!finalPurpose) {
        if (detection.mediaType) {
          const classification = await inputClassifier.classifyPurpose({
            mediaType: detection.mediaType,
            filename: detection.metadata.filename,
          });
          finalPurpose = classification.suggestedPurpose;
          needsUserConfirmation = classification.confidence < 0.8;
        } else {
          finalPurpose = 'reference_general';
          needsUserConfirmation = true;
        }
      }

      // Create the input entry
      const inputId = `input-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const projectInput: Omit<ProjectInput, 'id'> = {
        source: {
          type: detection.sourceType,
          value: inputValue,
          originalValue: inputValue,
        },
        mediaType: detection.mediaType || 'text',
        purpose: finalPurpose,
        anchorMode: purpose === 'anchor_video' ? anchorMode : undefined,
        metadata: {
          originalFilename: detection.metadata.filename,
          youtubeId: detection.metadata.youtubeId,
          addedAt: Date.now(),
        },
        processing: {
          status: 'pending',
        },
        notes,
      };

      // Add to project
      const addedInput = addProjectInput(projectInput);

      // Start processing asynchronously
      processInputAsync(addedInput.id).catch((error) => {
        console.error(`Failed to process input ${addedInput.id}:`, error);
      });

      return {
        status: 'success',
        input_id: addedInput.id,
        source_type: detection.sourceType,
        media_type: detection.mediaType || 'text',
        purpose: finalPurpose,
        needs_user_confirmation: needsUserConfirmation,
        message: needsUserConfirmation
          ? `Input added. Please confirm that "${finalPurpose}" is the correct purpose for this input.`
          : `Input added and queued for processing.`,
        detected: {
          confidence: detection.confidence,
          youtubeId: detection.metadata.youtubeId,
          filename: detection.metadata.filename,
        },
      };
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
);

/**
 * Process an input asynchronously.
 */
async function processInputAsync(inputId: string): Promise<void> {
  const project = loadProject();
  if (!project || !project.inputs) return;

  const input = project.inputs.find((i) => i.id === inputId);
  if (!input) return;

  try {
    const processed = await inputProcessor.process(input);
    updateProjectInput(inputId, processed);
  } catch (error) {
    updateProjectInput(inputId, {
      processing: {
        ...input.processing,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * List all inputs in the project.
 */
export const listInputsTool: ToolDefinition = createTool(
  'list_inputs',
  `List all inputs in the project with their types, purposes, and processing status.
Returns a summary of each input including:
- Input ID
- Source type (local_path, remote_url, youtube, inline)
- Media type (text, audio, image, video)
- Purpose (narration, style_ref, etc.)
- Processing status (pending, processing, completed, failed)`,
  {
    type: 'object',
    properties: {
      filter_purpose: {
        type: 'string',
        enum: [
          'narration',
          'style_ref',
          'motion_ref',
          'character_ref',
          'setting_ref',
          'anchor_video',
          'background_music',
          'reference_general',
        ],
        description: 'Optional - filter by purpose',
      },
      filter_status: {
        type: 'string',
        enum: ['pending', 'processing', 'completed', 'failed'],
        description: 'Optional - filter by processing status',
      },
    },
    required: [],
  },
  async (args) => {
    const filterPurpose = args['filter_purpose'] as InputPurpose | undefined;
    const filterStatus = args['filter_status'] as string | undefined;

    try {
      const project = loadProject();
      if (!project) {
        return { status: 'error', error: 'No project found' };
      }

      let inputs = project.inputs || [];

      // Apply filters
      if (filterPurpose) {
        inputs = inputs.filter((i) => i.purpose === filterPurpose);
      }
      if (filterStatus) {
        inputs = inputs.filter((i) => i.processing.status === filterStatus);
      }

      // Build summary
      const summary = inputs.map((input) => ({
        id: input.id,
        source_type: input.source.type,
        media_type: input.mediaType,
        purpose: input.purpose,
        anchor_mode: input.anchorMode,
        status: input.processing.status,
        has_transcription: !!input.processing.transcription,
        has_keyframes: (input.processing.keyframePaths?.length || 0) > 0,
        duration: input.metadata.duration,
        filename: input.metadata.originalFilename || input.metadata.youtubeTitle,
        notes: input.notes,
        added_at: new Date(input.metadata.addedAt).toISOString(),
        error: input.processing.error,
      }));

      return {
        status: 'success',
        total_inputs: inputs.length,
        inputs: summary,
        primary_narration: project.primaryNarration,
      };
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
);

/**
 * Read the processed content of an input.
 */
export const readInputTool: ToolDefinition = createTool(
  'read_input',
  `Read the processed content of an input.
For text inputs: Returns the text content
For audio inputs: Returns transcription (if available) and timing markers
For image inputs: Returns path to the local file
For video inputs: Returns transcription, keyframe paths, and extracted audio path`,
  {
    type: 'object',
    properties: {
      input_id: {
        type: 'string',
        description: 'ID of the input to read',
      },
      include_content: {
        type: 'boolean',
        description: 'Whether to include full text/transcription content (default: true)',
      },
    },
    required: ['input_id'],
  },
  async (args) => {
    const inputId = args['input_id'] as string;
    const includeContent = (args['include_content'] as boolean) ?? true;

    if (!inputId) {
      return { status: 'error', error: 'input_id is required' };
    }

    try {
      const project = loadProject();
      if (!project || !project.inputs) {
        return { status: 'error', error: 'No project found' };
      }

      const input = project.inputs.find((i) => i.id === inputId);
      if (!input) {
        return { status: 'error', error: `Input not found: ${inputId}` };
      }

      if (input.processing.status !== 'completed') {
        return {
          status: 'pending',
          message: `Input is still ${input.processing.status}`,
          processing_status: input.processing.status,
          error: input.processing.error,
        };
      }

      const result: Record<string, unknown> = {
        status: 'success',
        input_id: inputId,
        media_type: input.mediaType,
        purpose: input.purpose,
        local_path: input.processing.localPath,
        duration: input.metadata.duration,
      };

      // Add content based on media type
      if (input.mediaType === 'text' && includeContent && input.processing.localPath) {
        try {
          const content = await fs.promises.readFile(input.processing.localPath, 'utf-8');
          result['content'] = content;
        } catch {
          result['content_error'] = 'Could not read text content';
        }
      }

      if ((input.mediaType === 'audio' || input.mediaType === 'video') && input.processing.transcription) {
        result['transcription'] = includeContent ? input.processing.transcription : '[available]';
        result['timing_markers'] = input.processing.timingMarkers;
        result['transcription_path'] = input.processing.transcriptionPath;
      }

      if (input.mediaType === 'video') {
        result['extracted_audio_path'] = input.processing.extractedAudioPath;
        result['keyframe_paths'] = input.processing.keyframePaths;
        result['keyframe_count'] = input.processing.keyframePaths?.length || 0;
      }

      return result;
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
);

/**
 * Use an input as a reference for generation.
 */
export const useInputAsReferenceTool: ToolDefinition = createTool(
  'use_input_as_reference',
  `Get reference data from an input for use in image or video generation.
Returns the appropriate artifact path based on the reference type:
- style: Returns image/keyframe path for style reference
- motion: Returns video path or keyframe paths for motion reference
- character: Returns image path for character appearance reference
- setting: Returns image path for setting/location reference`,
  {
    type: 'object',
    properties: {
      input_id: {
        type: 'string',
        description: 'ID of the input to use as reference',
      },
      reference_type: {
        type: 'string',
        enum: ['style', 'motion', 'character', 'setting'],
        description: 'How to use this reference in generation',
      },
      keyframe_index: {
        type: 'number',
        description: 'For video inputs - which keyframe to use (0-based index)',
      },
    },
    required: ['input_id', 'reference_type'],
  },
  async (args) => {
    const inputId = args['input_id'] as string;
    const referenceType = args['reference_type'] as string;
    const keyframeIndex = args['keyframe_index'] as number | undefined;

    if (!inputId || !referenceType) {
      return { status: 'error', error: 'input_id and reference_type are required' };
    }

    try {
      const project = loadProject();
      if (!project || !project.inputs) {
        return { status: 'error', error: 'No project found' };
      }

      const input = project.inputs.find((i) => i.id === inputId);
      if (!input) {
        return { status: 'error', error: `Input not found: ${inputId}` };
      }

      if (input.processing.status !== 'completed') {
        return {
          status: 'pending',
          message: `Input is still ${input.processing.status}. Wait for processing to complete.`,
        };
      }

      // Determine reference path based on input type and reference type
      let referencePath: string | undefined;
      const referenceType_: string = referenceType;

      if (input.mediaType === 'image') {
        referencePath = input.processing.localPath;
      } else if (input.mediaType === 'video') {
        if (referenceType === 'motion') {
          // For motion reference, use the video itself
          referencePath = input.processing.localPath;
        } else {
          // For other references, use keyframes
          const keyframes = input.processing.keyframePaths || [];
          if (keyframes.length === 0) {
            return {
              status: 'error',
              error: 'No keyframes extracted from video. Processing may have failed.',
            };
          }
          const index = keyframeIndex ?? 0;
          referencePath = keyframes[Math.min(index, keyframes.length - 1)];
        }
      } else {
        return {
          status: 'error',
          error: `Cannot use ${input.mediaType} input as a visual reference`,
        };
      }

      if (!referencePath || !referencePathExists(referencePath)) {
        return {
          status: 'error',
          error: 'Reference file not found. Processing may have failed.',
        };
      }

      return {
        status: 'success',
        reference_path: referencePath,
        reference_type: referenceType_,
        input_id: inputId,
        media_type: input.mediaType,
        available_keyframes: input.processing.keyframePaths?.length || 0,
      };
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
);

/**
 * Get audio timing markers for video synchronization.
 */
export const getAudioTimingTool: ToolDefinition = createTool(
  'get_audio_timing',
  `Get timing markers from a narration audio/video for synchronizing generated video scenes.
Returns an array of segments with start time, end time, and text content.
Use these to determine scene durations that match the narration pacing.`,
  {
    type: 'object',
    properties: {
      input_id: {
        type: 'string',
        description: 'ID of the narration input (must be audio or video type)',
      },
    },
    required: ['input_id'],
  },
  async (args) => {
    const inputId = args['input_id'] as string;

    if (!inputId) {
      return { status: 'error', error: 'input_id is required' };
    }

    try {
      const project = loadProject();
      if (!project || !project.inputs) {
        return { status: 'error', error: 'No project found' };
      }

      const input = project.inputs.find((i) => i.id === inputId);
      if (!input) {
        return { status: 'error', error: `Input not found: ${inputId}` };
      }

      if (input.mediaType !== 'audio' && input.mediaType !== 'video') {
        return {
          status: 'error',
          error: `Input must be audio or video type, got: ${input.mediaType}`,
        };
      }

      if (input.processing.status !== 'completed') {
        return {
          status: 'pending',
          message: `Input is still ${input.processing.status}. Wait for processing to complete.`,
        };
      }

      if (!input.processing.timingMarkers || input.processing.timingMarkers.length === 0) {
        return {
          status: 'error',
          error: 'No timing markers available. Audio transcription may have failed.',
          transcription_available: !!input.processing.transcription,
        };
      }

      return {
        status: 'success',
        input_id: inputId,
        total_duration: input.metadata.duration,
        segment_count: input.processing.timingMarkers.length,
        timing_markers: input.processing.timingMarkers,
        audio_path: input.processing.extractedAudioPath || input.processing.localPath,
      };
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
);

/**
 * Set an input as the primary narration source.
 */
export const setPrimaryNarrationTool: ToolDefinition = createTool(
  'set_primary_narration',
  `Set an input as the primary narration source for the video.
The narration provides the story content and optionally the audio track.
When preserve_audio is true, the generated video will be synchronized
to match the original audio timing.`,
  {
    type: 'object',
    properties: {
      input_id: {
        type: 'string',
        description: 'ID of the input to use as narration',
      },
      preserve_audio: {
        type: 'boolean',
        description: 'Whether to use the original audio in the final video (default: true for audio/video, false for text)',
      },
    },
    required: ['input_id'],
  },
  async (args) => {
    const inputId = args['input_id'] as string;
    const preserveAudio = args['preserve_audio'] as boolean | undefined;

    if (!inputId) {
      return { status: 'error', error: 'input_id is required' };
    }

    try {
      const project = loadProject();
      if (!project || !project.inputs) {
        return { status: 'error', error: 'No project found' };
      }

      const input = project.inputs.find((i) => i.id === inputId);
      if (!input) {
        return { status: 'error', error: `Input not found: ${inputId}` };
      }

      // Determine narration type
      let narrationType: 'text' | 'audio' | 'transcription';
      let shouldPreserveAudio: boolean;

      if (input.mediaType === 'text') {
        narrationType = 'text';
        shouldPreserveAudio = false;
      } else if (input.mediaType === 'audio') {
        narrationType = 'audio';
        shouldPreserveAudio = preserveAudio ?? true;
      } else if (input.mediaType === 'video') {
        narrationType = 'transcription';
        shouldPreserveAudio = preserveAudio ?? true;
      } else {
        return {
          status: 'error',
          error: `Cannot use ${input.mediaType} as narration source`,
        };
      }

      // Update project
      setPrimaryNarration(inputId, shouldPreserveAudio);

      return {
        status: 'success',
        input_id: inputId,
        narration_type: narrationType,
        preserve_audio: shouldPreserveAudio,
        message: shouldPreserveAudio
          ? 'Narration set. Generated video will be synchronized to the original audio.'
          : 'Narration set. Text/transcription will be used for story content.',
      };
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
);

/**
 * Get the narration content for story generation.
 */
export const getNarrationContentTool: ToolDefinition = createTool(
  'get_narration_content',
  `Get the narration content from the primary narration source.
Returns the text content (from text input or audio transcription)
along with timing information if audio is being preserved.`,
  {
    type: 'object',
    properties: {},
    required: [],
  },
  async () => {
    try {
      const content = getNarrationContent();

      if (!content) {
        return {
          status: 'error',
          error: 'No primary narration source set. Use set_primary_narration first.',
        };
      }

      return {
        status: 'success',
        content: content.content,
        has_audio: !!content.audioPath,
        audio_path: content.audioPath,
        timing_markers: content.timingMarkers,
      };
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
);

/**
 * Get all input tools.
 */
export function getInputTools(): ToolDefinition[] {
  return [
    addInputTool,
    listInputsTool,
    readInputTool,
    useInputAsReferenceTool,
    getAudioTimingTool,
    setPrimaryNarrationTool,
    getNarrationContentTool,
  ];
}
