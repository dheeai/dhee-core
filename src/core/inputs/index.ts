/**
 * Multi-Input Support Module
 *
 * This module provides functionality for handling diverse input types
 * in the dhee-core video generation workflow.
 *
 * Supported input sources:
 * - Local file paths
 * - Remote URLs
 * - YouTube videos
 * - Inline text
 *
 * Supported media types:
 * - Text (.txt, .md)
 * - Audio (.mp3, .wav, .m4a)
 * - Images (.jpg, .png, .gif)
 * - Video (.mp4, .mov, .webm)
 */

// Input Detection
export { InputDetector, inputDetector } from './InputDetector.js';
export type { DetectionResult } from './InputDetector.js';

// Input Classification
export { InputClassifier, inputClassifier } from './InputClassifier.js';
export type {
  ClassificationResult,
  ClassifyParams,
  PurposeOption,
  AskUserQuestionParams,
} from './InputClassifier.js';

// Input Processing
export { InputProcessor, inputProcessor } from './InputProcessor.js';
export type {
  DownloadResult,
  YouTubeDownloadResult,
  TranscriptionResult,
  ValidationResult,
  InputProcessorConfig,
} from './InputProcessor.js';

// Re-export types from workflow types for convenience
export type {
  InputSourceType,
  InputMediaType,
  InputPurpose,
  AnchorWorkflowMode,
  InputProcessingStatus,
  ProjectInput,
  PrimaryNarrationConfig,
} from '../../tasks/video/workflow/types.js';
