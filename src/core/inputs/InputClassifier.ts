/**
 * InputClassifier - Uses LLM to classify the purpose of user-provided inputs.
 *
 * Analyzes inputs based on:
 * - Media type (text, audio, image, video)
 * - Filename and context
 * - User message when providing input
 * - Current workflow phase
 * - Other existing inputs
 */

import type { LLMClient } from '../llm/LLMClient.js';
import type {
  InputMediaType,
  InputPurpose,
  ProjectInput,
  WorkflowPhase,
} from '../../tasks/video/workflow/types.js';

/**
 * Classification result from the LLM.
 */
export interface ClassificationResult {
  /** Most likely purpose for this input */
  suggestedPurpose: InputPurpose;
  /** Confidence level (0-1) */
  confidence: number;
  /** Alternative purposes that could apply */
  alternatives: InputPurpose[];
  /** Explanation of why this purpose was suggested */
  reasoning: string;
}

/**
 * Parameters for classification.
 */
export interface ClassifyParams {
  /** Media type of the input */
  mediaType: InputMediaType;
  /** Original filename (if available) */
  filename?: string;
  /** What the user said when providing the input */
  userMessage?: string;
  /** Current workflow phase */
  currentPhase?: WorkflowPhase;
  /** Other inputs already in the project */
  existingInputs?: ProjectInput[];
}

/**
 * Option for user question.
 */
export interface PurposeOption {
  label: string;
  description: string;
  purpose: InputPurpose;
}

/**
 * Parameters for ask_user tool.
 */
export interface AskUserQuestionParams {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{
      label: string;
      description: string;
    }>;
    multiSelect: boolean;
  }>;
}

/**
 * Purpose descriptions for user-facing display.
 */
const PURPOSE_DESCRIPTIONS: Record<InputPurpose, { label: string; description: string }> = {
  narration: {
    label: 'Narration/Story',
    description: 'Use as the story narration or script for the video',
  },
  style_ref: {
    label: 'Style Reference',
    description: 'Use as a visual style reference for generated images/videos',
  },
  motion_ref: {
    label: 'Motion Reference',
    description: 'Use as a reference for motion/animation style',
  },
  character_ref: {
    label: 'Character Reference',
    description: 'Use as a reference for character appearance',
  },
  setting_ref: {
    label: 'Setting Reference',
    description: 'Use as a reference for settings/locations',
  },
  anchor_video: {
    label: 'Anchor Video',
    description: 'Pre-recorded speaker video to integrate with generated content',
  },
  background_music: {
    label: 'Background Music',
    description: 'Use as background audio/music in the final video',
  },
  reference_general: {
    label: 'General Reference',
    description: 'General reference material (you can specify how to use it)',
  },
};

/**
 * Valid purposes by media type.
 */
const PURPOSES_BY_MEDIA_TYPE: Record<InputMediaType, InputPurpose[]> = {
  text: ['narration', 'reference_general'],
  audio: ['narration', 'background_music', 'reference_general'],
  image: ['style_ref', 'character_ref', 'setting_ref', 'reference_general'],
  video: [
    'anchor_video',
    'style_ref',
    'motion_ref',
    'character_ref',
    'setting_ref',
    'reference_general',
  ],
};

/**
 * InputClassifier class for LLM-based purpose classification.
 */
export class InputClassifier {
  private llmClient: LLMClient | null;
  private useLLM: boolean;

  constructor(llmClient?: LLMClient | null, useLLM: boolean = false) {
    // By default, don't use LLM - use heuristics only
    // LLM can be enabled for enhanced classification
    this.llmClient = llmClient ?? null;
    this.useLLM = useLLM && this.llmClient !== null;
  }

  /**
   * Classify the purpose of an input.
   * Uses heuristics by default, with optional LLM enhancement.
   */
  async classifyPurpose(params: ClassifyParams): Promise<ClassificationResult> {
    const { mediaType, filename, userMessage, currentPhase, existingInputs } = params;

    // Get valid purposes for this media type
    const validPurposes = PURPOSES_BY_MEDIA_TYPE[mediaType] || ['reference_general'];

    // First, try heuristic classification (fast, no network)
    const heuristicResult = this.heuristicClassification(params, validPurposes);

    // If confidence is high enough or LLM is not enabled, return heuristic result
    if (heuristicResult.confidence >= 0.7 || !this.useLLM || !this.llmClient) {
      return heuristicResult;
    }

    // Try LLM for better classification (optional enhancement)
    try {
      const llmResult = await this.classifyWithLLM(params, validPurposes);
      if (llmResult) {
        return llmResult;
      }
    } catch (error) {
      // LLM failed, fall back to heuristics
      console.warn('LLM classification failed, using heuristics:', error);
    }

    return heuristicResult;
  }

  /**
   * Classify using LLM (when enabled).
   */
  private async classifyWithLLM(
    params: ClassifyParams,
    validPurposes: InputPurpose[]
  ): Promise<ClassificationResult | null> {
    if (!this.llmClient) return null;

    const { mediaType, filename, userMessage, currentPhase, existingInputs } = params;

    // Build context for the LLM
    const contextParts: string[] = [];

    if (filename) {
      contextParts.push(`Filename: ${filename}`);
    }

    if (userMessage) {
      contextParts.push(`User said: "${userMessage}"`);
    }

    if (currentPhase) {
      contextParts.push(`Current workflow phase: ${currentPhase}`);
    }

    if (existingInputs && existingInputs.length > 0) {
      const existingDesc = existingInputs
        .map(inp => `- ${inp.purpose} (${inp.mediaType})`)
        .join('\n');
      contextParts.push(`Existing inputs:\n${existingDesc}`);
    }

    const purposeOptions = validPurposes
      .map(p => `- ${p}: ${PURPOSE_DESCRIPTIONS[p].description}`)
      .join('\n');

    const prompt = `You are classifying the purpose of a user-provided input for a video generation workflow.

Input details:
- Media type: ${mediaType}
${contextParts.length > 0 ? contextParts.join('\n') : ''}

Valid purposes for this ${mediaType} input:
${purposeOptions}

Based on the context, classify this input's most likely purpose. Consider:
1. The media type's natural uses (text is often narration, images are often references)
2. Any hints in the filename or user message
3. What purposes are already filled by existing inputs
4. The current workflow phase

Respond in JSON format:
{
  "purpose": "<most_likely_purpose>",
  "confidence": <0.0-1.0>,
  "alternatives": ["<other_possible_purpose>", ...],
  "reasoning": "<brief explanation>"
}`;

    try {
      const response = await this.llmClient.generate({
        messages: [
          { role: 'system', content: 'You are an input classifier. Respond only with valid JSON.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
      });

      if (response.content) {
        // Extract JSON from response
        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as {
            purpose: string;
            confidence: number;
            alternatives: string[];
            reasoning: string;
          };

          // Validate the purpose is in our valid list
          const suggestedPurpose = validPurposes.includes(parsed.purpose as InputPurpose)
            ? (parsed.purpose as InputPurpose)
            : this.getDefaultPurpose(mediaType);

          const alternatives = (parsed.alternatives || [])
            .filter((p): p is InputPurpose => validPurposes.includes(p as InputPurpose))
            .filter(p => p !== suggestedPurpose);

          return {
            suggestedPurpose,
            confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
            alternatives,
            reasoning: parsed.reasoning || 'Classification based on media type and context',
          };
        }
      }
    } catch {
      // LLM parsing failed
    }

    // Return null to indicate LLM didn't help
    return null;
  }

  /**
   * Heuristic-based classification when LLM is unavailable.
   */
  private heuristicClassification(
    params: ClassifyParams,
    validPurposes: InputPurpose[]
  ): ClassificationResult {
    const { mediaType, filename, userMessage } = params;

    // Check for keywords in filename or user message
    const text = `${filename || ''} ${userMessage || ''}`.toLowerCase();

    // Keyword-based detection
    const keywordMatches: Record<InputPurpose, string[]> = {
      narration: ['narration', 'story', 'script', 'voiceover', 'voice-over', 'speech', 'dialogue'],
      style_ref: ['style', 'reference', 'aesthetic', 'look', 'visual'],
      motion_ref: ['motion', 'movement', 'animation', 'action'],
      character_ref: ['character', 'person', 'actor', 'face', 'portrait'],
      setting_ref: ['setting', 'location', 'place', 'background', 'scene', 'environment'],
      anchor_video: ['anchor', 'speaker', 'presenter', 'host', 'talking head'],
      background_music: ['music', 'background', 'soundtrack', 'audio', 'track', 'bgm'],
      reference_general: ['reference', 'ref', 'example'],
    };

    for (const purpose of validPurposes) {
      if (keywordMatches[purpose]?.some(kw => text.includes(kw))) {
        return {
          suggestedPurpose: purpose,
          confidence: 0.7,
          alternatives: validPurposes.filter(p => p !== purpose).slice(0, 2),
          reasoning: `Detected keywords suggesting ${PURPOSE_DESCRIPTIONS[purpose].label}`,
        };
      }
    }

    // Default by media type
    const defaultPurpose = this.getDefaultPurpose(mediaType);
    return {
      suggestedPurpose: defaultPurpose,
      confidence: 0.5,
      alternatives: validPurposes.filter(p => p !== defaultPurpose).slice(0, 2),
      reasoning: `Default purpose for ${mediaType} content`,
    };
  }

  /**
   * Get the default purpose for a media type.
   */
  private getDefaultPurpose(mediaType: InputMediaType): InputPurpose {
    switch (mediaType) {
      case 'text':
        return 'narration';
      case 'audio':
        return 'narration';
      case 'image':
        return 'style_ref';
      case 'video':
        return 'anchor_video';
      default:
        return 'reference_general';
    }
  }

  /**
   * Build an ask_user question for purpose confirmation.
   */
  buildPurposeQuestion(
    mediaType: InputMediaType,
    suggestions: Array<{ purpose: InputPurpose; reason: string }>
  ): AskUserQuestionParams {
    const validPurposes = PURPOSES_BY_MEDIA_TYPE[mediaType] || ['reference_general'];

    // Build options, putting suggestions first
    const options: PurposeOption[] = [];

    // Add suggested options first
    for (const suggestion of suggestions) {
      if (validPurposes.includes(suggestion.purpose)) {
        const desc = PURPOSE_DESCRIPTIONS[suggestion.purpose];
        options.push({
          label: options.length === 0 ? `${desc.label} (Recommended)` : desc.label,
          description: `${desc.description}${suggestion.reason ? ` - ${suggestion.reason}` : ''}`,
          purpose: suggestion.purpose,
        });
      }
    }

    // Add remaining valid purposes
    for (const purpose of validPurposes) {
      if (!options.find(o => o.purpose === purpose)) {
        const desc = PURPOSE_DESCRIPTIONS[purpose];
        options.push({
          label: desc.label,
          description: desc.description,
          purpose,
        });
      }
    }

    // Limit to 4 options for the question
    const limitedOptions = options.slice(0, 4);

    return {
      questions: [
        {
          question: `How should this ${mediaType} input be used in your video project?`,
          header: 'Input Purpose',
          options: limitedOptions.map(o => ({
            label: o.label,
            description: o.description,
          })),
          multiSelect: false,
        },
      ],
    };
  }

  /**
   * Get all valid purposes for a media type.
   */
  getValidPurposes(mediaType: InputMediaType): InputPurpose[] {
    return PURPOSES_BY_MEDIA_TYPE[mediaType] || ['reference_general'];
  }

  /**
   * Get the description for a purpose.
   */
  getPurposeDescription(purpose: InputPurpose): { label: string; description: string } {
    return PURPOSE_DESCRIPTIONS[purpose] || {
      label: purpose,
      description: 'Unknown purpose',
    };
  }

  /**
   * Map a user's answer label back to a purpose.
   */
  labelToPurpose(label: string): InputPurpose | null {
    // Remove "(Recommended)" suffix if present
    const cleanLabel = label.replace(/\s*\(Recommended\)$/, '');

    for (const [purpose, desc] of Object.entries(PURPOSE_DESCRIPTIONS)) {
      if (desc.label === cleanLabel) {
        return purpose as InputPurpose;
      }
    }

    return null;
  }
}

/**
 * Singleton instance for convenience.
 */
export const inputClassifier = new InputClassifier();
