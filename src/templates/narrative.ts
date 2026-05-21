/**
 * Narrative Video Template
 *
 * Template for creating narrative/story-based videos.
 * This is a refactoring of the original 8-phase workflow into the generic template system.
 *
 * Flow: plot → story → characters/settings → scenes → ref_images → shot_breakdown → shot_images → shot_videos → final
 */

import type {
  VideoTemplate,
  ArtifactTypeDefinition,
  InputTypeConfig,
  PhaseDefinition,
  StyleConfig,
} from '../core/templates/types.js';

// =============================================================================
// ARTIFACT TYPE DEFINITIONS
// =============================================================================

const plotArtifact: ArtifactTypeDefinition = {
  id: 'plot',
  displayName: 'Plot Outline',
  category: 'concept',
  description: 'High-level plot outline with main story beats and structure',
  scope: 'chapter',
  isCollection: false,
  outputFormat: 'markdown',
  filePattern: 'chapters/{{chapter}}/plans/plot.md',
  agentType: 'planning',
  promptFile: 'narrative/plot.md',
  isExpensive: false,
  requiresPerItemApproval: false,
  dependencies: [],
};

const storyArtifact: ArtifactTypeDefinition = {
  id: 'story',
  displayName: 'Full Story',
  category: 'structure',
  description: 'Complete narrative story with dialogue, descriptions, and emotional beats',
  scope: 'chapter',
  isCollection: false,
  outputFormat: 'markdown',
  filePattern: 'chapters/{{chapter}}/plans/story.md',
  agentType: 'content',
  promptFile: 'narrative/story.md',
  isExpensive: false,
  requiresPerItemApproval: false,
  dependencies: [
    {
      artifactTypeId: 'plot',
      required: true,
      usage: 'context',
    },
  ],
};

const storyEssenceArtifact: ArtifactTypeDefinition = {
  id: 'story_essence',
  displayName: 'Story Essence',
  category: 'concept',
  description: 'Editorial intent — genre, throughline, tonal notes, dramatic emphasis. Tunes every downstream prompt to the kind of story being told.',
  scope: 'project',
  isCollection: false,
  outputFormat: 'json',
  filePattern: 'prompts/story_essence.json',
  agentType: 'content',
  promptFile: 'narrative/story_essence.md',
  isExpensive: false,
  requiresPerItemApproval: false,
  dependencies: [
    {
      artifactTypeId: 'story',
      required: true,
      usage: 'context',
    },
  ],
};

const characterArtifact: ArtifactTypeDefinition = {
  id: 'character',
  displayName: 'Characters',
  category: 'entity',
  description: 'Character descriptions including appearance, personality, and visual details',
  scope: 'project',
  isCollection: true,
  itemName: 'character',
  maxItems: 10,
  outputFormat: 'markdown',
  filePattern: 'characters/{{name}}.md',
  agentType: 'content',
  promptFile: 'narrative/character.md',
  isExpensive: false,
  requiresPerItemApproval: true,
  dependencies: [
    {
      artifactTypeId: 'story',
      required: true,
      usage: 'context',
    },
    {
      artifactTypeId: 'story_essence',
      required: true,
      usage: 'context',
    },
  ],
  metadataSchema: {
    gender: { type: 'string', required: false, description: 'Character gender' },
    age: { type: 'string', required: false, description: 'Character age or age range' },
    role: { type: 'string', required: false, description: 'Role in the story (protagonist, antagonist, etc.)' },
  },
};

const settingArtifact: ArtifactTypeDefinition = {
  id: 'setting',
  displayName: 'Settings',
  category: 'environment',
  description: 'Location/environment descriptions with visual details for image generation',
  scope: 'project',
  isCollection: true,
  itemName: 'setting',
  maxItems: 10,
  outputFormat: 'markdown',
  filePattern: 'settings/{{name}}.md',
  agentType: 'content',
  promptFile: 'narrative/setting.md',
  isExpensive: false,
  requiresPerItemApproval: true,
  dependencies: [
    {
      artifactTypeId: 'story',
      required: true,
      usage: 'context',
    },
    {
      artifactTypeId: 'story_essence',
      required: true,
      usage: 'context',
    },
  ],
  metadataSchema: {
    timeOfDay: { type: 'string', required: false, description: 'Time of day for the setting' },
    weather: { type: 'string', required: false, description: 'Weather conditions' },
    mood: { type: 'string', required: false, description: 'Emotional mood of the setting' },
  },
};

const objectArtifact: ArtifactTypeDefinition = {
  id: 'object',
  displayName: 'Objects/Props',
  category: 'entity',
  description: 'Distinctive objects, props, vehicles, or items that need visual consistency across shots',
  scope: 'project',
  isCollection: true,
  itemName: 'object',
  maxItems: 10,
  outputFormat: 'markdown',
  filePattern: 'objects/{{name}}.md',
  agentType: 'content',
  promptFile: 'narrative/object.md',
  isExpensive: false,
  requiresPerItemApproval: true,
  dependencies: [
    {
      artifactTypeId: 'story',
      required: true,
      usage: 'context',
    },
  ],
  metadataSchema: {
    objectType: { type: 'string', required: false, description: 'Type of object (vehicle, weapon, artifact, prop)' },
  },
};

const objectImageArtifact: ArtifactTypeDefinition = {
  id: 'object_image',
  displayName: 'Object Reference Images',
  category: 'visual_ref',
  description: 'Reference images for distinctive objects/props for visual consistency',
  scope: 'project',
  isCollection: true,
  itemName: 'object_image',
  maxItems: 10,
  outputFormat: 'image',
  filePattern: 'assets/images/objects/{{name}}.png',
  agentType: 'image',
  promptFile: 'narrative/object_image.md',
  isExpensive: true,
  requiresPerItemApproval: true,
  dependencies: [
    {
      artifactTypeId: 'object',
      required: true,
      usage: 'input',
      scope: 'matching',
    },
    {
      artifactTypeId: 'world_style',
      required: true,
      usage: 'context',
      scope: 'all',
    },
  ],
};

const sceneArtifact: ArtifactTypeDefinition = {
  id: 'scene',
  displayName: 'Scenes',
  category: 'segment',
  description: 'Individual scene descriptions with action, dialogue, and visual direction',
  scope: 'chapter',
  isCollection: true,
  itemName: 'scene',
  maxItems: 12,
  outputFormat: 'markdown',
  filePattern: 'chapters/{{chapter}}/scenes/scene_{{index}}.md',
  agentType: 'content',
  promptFile: 'narrative/scene.md',
  isExpensive: false,
  requiresPerItemApproval: true,
  dependencies: [
    {
      artifactTypeId: 'story',
      required: true,
      usage: 'context',
    },
    {
      artifactTypeId: 'story_essence',
      required: true,
      usage: 'context',
    },
    {
      artifactTypeId: 'character',
      required: true,
      usage: 'context',
      scope: 'all',
    },
    {
      artifactTypeId: 'setting',
      required: true,
      usage: 'context',
      scope: 'all',
    },
  ],
  metadataSchema: {
    characters: { type: 'array', required: true, description: 'Characters appearing in this scene' },
    setting: { type: 'string', required: true, description: 'Setting where scene takes place' },
    duration: { type: 'number', required: false, description: 'Estimated duration in seconds' },
  },
};

const characterImageArtifact: ArtifactTypeDefinition = {
  id: 'character_image',
  displayName: 'Character Reference Images',
  category: 'visual_ref',
  description: 'Reference images for characters to ensure visual consistency',
  scope: 'project',
  isCollection: true,
  itemName: 'character image',
  outputFormat: 'image',
  filePattern: 'assets/images/characters/{{name}}.png',
  agentType: 'image',
  promptFile: 'common/character-image.md',
  isExpensive: true,
  requiresPerItemApproval: true,
  dependencies: [
    {
      artifactTypeId: 'character',
      required: true,
      usage: 'context',
      scope: 'matching',
    },
    {
      artifactTypeId: 'world_style',
      required: true,
      usage: 'context',
      scope: 'all',
    },
  ],
  metadataSchema: {
    characterId: { type: 'string', required: true, description: 'ID of the source character' },
    seed: { type: 'number', required: false, description: 'Generation seed for reproducibility' },
  },
};

const settingImageArtifact: ArtifactTypeDefinition = {
  id: 'setting_image',
  displayName: 'Setting Reference Images',
  category: 'visual_ref',
  description: 'Reference images for settings/locations to ensure visual consistency',
  scope: 'project',
  isCollection: true,
  itemName: 'setting image',
  outputFormat: 'image',
  filePattern: 'assets/images/settings/{{name}}.png',
  agentType: 'image',
  promptFile: 'common/setting-image.md',
  isExpensive: true,
  requiresPerItemApproval: true,
  dependencies: [
    {
      artifactTypeId: 'setting',
      required: true,
      usage: 'context',
      scope: 'matching',
    },
    {
      artifactTypeId: 'world_style',
      required: true,
      usage: 'context',
      scope: 'all',
    },
  ],
  metadataSchema: {
    settingId: { type: 'string', required: true, description: 'ID of the source setting' },
    seed: { type: 'number', required: false, description: 'Generation seed for reproducibility' },
  },
};

// world_style: defines the visual/auditory style bible for the entire project
// Generated once, injected as context into all downstream prompts
const worldStyleArtifact: ArtifactTypeDefinition = {
  id: 'world_style',
  displayName: 'World Style Bible',
  category: 'structure',
  description: 'Visual and auditory style guide ensuring consistency across all shots — color palette, lighting, atmosphere, sound world',
  scope: 'chapter',
  isCollection: false,
  outputFormat: 'markdown',
  filePattern: 'plans/world_style.md',
  agentType: 'content',
  promptFile: 'narrative/world-style.md',
  isExpensive: false,
  requiresPerItemApproval: false,
  dependencies: [
    { artifactTypeId: 'story', required: true, usage: 'context', scope: 'matching' },
    { artifactTypeId: 'scene', required: true, usage: 'context', scope: 'all' },
    { artifactTypeId: 'setting', required: true, usage: 'context', scope: 'all' },
  ],
  metadataSchema: {},
};

// Stage A of the hierarchical scene-breakdown flow. Emits a lightweight
// shot plan JSON (one entry per shot — shotNumber + purpose + duration +
// oneLineSummary) per scene. Stays under ~1k completion tokens regardless
// of scene length, so it doesn't hit the truncation problems the legacy
// single-call scene_video_prompt suffered from.
const sceneShotPlanArtifact: ArtifactTypeDefinition = {
  id: 'scene_shot_plan',
  displayName: 'Scene Shot Plan',
  category: 'structure',
  description: 'Lightweight per-scene shot plan: shotNumber, purpose, duration, one-line summary. Drives Stage B per-shot expansion downstream.',
  scope: 'chapter',
  isCollection: true,
  itemName: 'shot plan',
  outputFormat: 'json',
  filePattern: 'prompts/videos/scenes/scene-{{index}}.plan.json',
  agentType: 'content',
  promptFile: 'narrative/scene-shot-plan.md',
  isExpensive: false,
  requiresPerItemApproval: false,
  dependencies: [
    { artifactTypeId: 'scene', required: true, usage: 'context', scope: 'matching' },
    { artifactTypeId: 'world_style', required: true, usage: 'context', scope: 'matching' },
  ],
};

// Stage B of the hierarchical scene-breakdown flow. One node per shot
// (expanded from scene_shot_plan's shotPlan array via the existing
// shouldExpandSceneCollectionToShots mechanism). Each emits a single
// fully-expanded shot object — cameraWork, perspective, focus, audio,
// transition, etc. Per-shot calls are small (~700 tokens out) and run
// in parallel, so a single shot's failure doesn't waste the rest.
const shotBreakdownArtifact: ArtifactTypeDefinition = {
  id: 'shot_breakdown',
  displayName: 'Shot Breakdowns',
  category: 'structure',
  description: 'Per-shot expansion of the scene shot plan: full shot object with cameraWork, perspective, focus, audio, transition.',
  scope: 'chapter',
  isCollection: true,
  itemName: 'shot breakdown',
  outputFormat: 'json',
  filePattern: 'prompts/videos/scenes/scene-{{index}}.shots/{{subindex}}.json',
  agentType: 'content',
  promptFile: 'narrative/shot-breakdown.md',
  isExpensive: false,
  requiresPerItemApproval: false,
  dependencies: [
    { artifactTypeId: 'scene_shot_plan', required: true, usage: 'context', scope: 'matching' },
    { artifactTypeId: 'world_style', required: true, usage: 'context', scope: 'matching' },
  ],
};

// Stage C of the hierarchical scene-breakdown flow.
//
// scene_video_prompt is now a DETERMINISTIC assembler — no LLM call.
// It depends on scene_shot_plan + the per-shot shot_breakdown nodes
// (which the matching expansion resolves to shot_breakdown:scene_N
// initially, then the executor's repair pass rewires to the per-shot
// children once the plan is expanded). Reads them all from disk and
// stitches into the existing sceneVideoPromptSchema shape so downstream
// consumers (shot_image_prompt builder, shot_motion_directive, etc.)
// see byte-shape-identical input to today's single-call output.
//
// The output disk path stays exactly as before so consumers don't move.
const sceneVideoPromptArtifact: ArtifactTypeDefinition = {
  id: 'scene_video_prompt',
  displayName: 'Scene Breakdown',
  category: 'structure',
  description: 'Deterministic assembly of scene_shot_plan + per-shot shot_breakdown into the final scene shot list. No LLM call.',
  scope: 'chapter',
  isCollection: true,
  itemName: 'motion prompt',
  outputFormat: 'json',
  filePattern: 'prompts/videos/scenes/scene-{{index}}.motion.json',
  agentType: 'content',
  promptFile: 'narrative/scene-video-prompt.md',
  isExpensive: false,
  requiresPerItemApproval: true,
  dependencies: [
    { artifactTypeId: 'scene_shot_plan', required: true, usage: 'context', scope: 'matching' },
    { artifactTypeId: 'shot_breakdown', required: true, usage: 'context', scope: 'matching' },
  ],
};

const shotImagePromptArtifact: ArtifactTypeDefinition = {
  id: 'shot_image_prompt',
  displayName: 'Shot Composition',
  category: 'structure',
  description: 'Per-shot image generation prompts with reference image integration for visual consistency',
  scope: 'chapter',
  isCollection: true,
  itemName: 'shot prompt',
  outputFormat: 'markdown',
  filePattern: 'prompts/images/shots/scene-{{index}}-shot-{{subindex}}.json',
  agentType: 'content',
  promptFile: 'narrative/shot-image-prompt.md',
  isExpensive: false,
  requiresPerItemApproval: false,
  dependencies: [
    // Only depends on scene_video_prompt for the shot structure + character/setting IDs.
    // Reference images (character_image, setting_image) are resolved by refId at
    // ComfyUI generation time, NOT at prompt generation time. This allows shot prompts
    // to be generated in parallel with image generation.
    { artifactTypeId: 'scene_video_prompt', required: true, usage: 'context', scope: 'matching' },
    { artifactTypeId: 'world_style', required: true, usage: 'context', scope: 'matching' },
  ],
};

// shot_motion_directive: rewrites shot description into concise LTX-optimized motion prompt
// Separate LLM call per shot — produces 1-2 sentences focused on camera movement and physical action
const shotMotionDirectiveArtifact: ArtifactTypeDefinition = {
  id: 'shot_motion_directive',
  displayName: 'Shot Motion Directives',
  category: 'structure',
  description: 'Concise, LTX-optimized motion prompts per shot — camera movement, subject action, atmosphere',
  scope: 'chapter',
  isCollection: true,
  itemName: 'motion directive',
  outputFormat: 'markdown',
  filePattern: 'prompts/motion/scene-{{index}}-shot-{{subindex}}.txt',
  agentType: 'content',
  promptFile: 'narrative/shot-motion-directive.md',
  isExpensive: false,
  requiresPerItemApproval: false,
  dependencies: [
    { artifactTypeId: 'scene_video_prompt', required: true, usage: 'context', scope: 'matching' },
    { artifactTypeId: 'shot_image_prompt', required: true, usage: 'context', scope: 'matching' },
    { artifactTypeId: 'world_style', required: true, usage: 'context', scope: 'matching' },
  ],
  metadataSchema: {},
};

// shot_image: generates the actual shot image from the prompt JSON + reference images via ComfyUI
// This is the ComfyUI execution step — it needs the actual .png reference images
const shotImageArtifact: ArtifactTypeDefinition = {
  id: 'shot_image',
  displayName: 'Shot Images',
  category: 'visual_ref',
  description: 'Generated shot images from prompts with reference image compositing via FLUX Klein',
  scope: 'chapter',
  isCollection: true,
  itemName: 'shot image',
  outputFormat: 'image',
  filePattern: 'assets/images/shots/scene-{{index}}-shot-{{subindex}}.png',
  agentType: 'image',
  promptFile: 'narrative/shot-image.md',
  isExpensive: true,
  requiresPerItemApproval: false,
  dependencies: [
    // The prompt JSON tells us what to generate and which refs to use
    { artifactTypeId: 'shot_image_prompt', required: true, usage: 'input', scope: 'matching' },
    // Actual .png files needed for FLUX Klein image-to-image compositing
    { artifactTypeId: 'character_image', required: true, usage: 'reference', scope: 'all' },
    { artifactTypeId: 'setting_image', required: true, usage: 'reference', scope: 'all' },
    { artifactTypeId: 'object_image', required: false, usage: 'reference', scope: 'all' },
  ],
  metadataSchema: {
    shotNumber: { type: 'number', required: true, description: 'Shot number within the scene' },
  },
};

// shot_video: generates a video clip from each shot image using the motion prompt
// A scene is an array of shots — each shot starts with a shot image
const shotVideoArtifact: ArtifactTypeDefinition = {
  id: 'shot_video',
  displayName: 'Shot Videos',
  category: 'clip',
  description: 'Video clips for each shot, generated from shot images with motion prompts',
  scope: 'chapter',
  isCollection: true,
  itemName: 'shot video',
  outputFormat: 'video',
  filePattern: 'assets/videos/shots/scene-{{index}}-shot-{{subindex}}.mp4',
  agentType: 'video',
  promptFile: 'common/shot-video.md',
  isExpensive: true,
  requiresPerItemApproval: true,
  dependencies: [
    {
      artifactTypeId: 'shot_image',
      required: true,
      usage: 'input',
      scope: 'matching',
    },
    {
      artifactTypeId: 'shot_motion_directive',
      required: true,
      usage: 'context',
      scope: 'matching',
    },
  ],
  metadataSchema: {
    shotNumber: { type: 'number', required: true, description: 'Shot number within the scene' },
    duration: { type: 'number', required: false, description: 'Shot duration in seconds' },
  },
};

const finalVideoArtifact: ArtifactTypeDefinition = {
  id: 'final_video',
  displayName: 'Final Video',
  category: 'final',
  description: 'The assembled final video combining all scene videos',
  scope: 'chapter',
  isCollection: false,
  outputFormat: 'video',
  filePattern: 'chapters/{{chapter}}/assets/videos/final/{{name}}.mp4',
  agentType: 'video',
  promptFile: 'common/final-video.md',
  isExpensive: true,
  requiresPerItemApproval: false,
  dependencies: [
    {
      artifactTypeId: 'shot_video',
      required: true,
      usage: 'input',
      scope: 'all',
    },
  ],
  metadataSchema: {
    totalDuration: { type: 'number', required: false, description: 'Total video duration' },
    resolution: { type: 'object', required: false, description: 'Video resolution' },
  },
};

// =============================================================================
// INPUT TYPE CONFIGURATIONS
// =============================================================================

const ideaInput: InputTypeConfig = {
  id: 'idea',
  displayName: 'Story Idea',
  description: 'A brief story idea, concept, or premise that will be developed into a full narrative',
  examples: [
    'A robot learns to love',
    'Two strangers meet on a train and discover they share a secret',
    'A chef must save their restaurant from closure',
  ],
  skipsArtifacts: [],
  mapsToArtifact: 'plot',
  detectionPatterns: [
    {
      type: 'length',
      config: { maxLength: 500 },
      weight: 3,
    },
    {
      type: 'keywords',
      config: { keywords: ['about', 'story about', 'idea', 'concept', 'what if', 'create a', 'make a'], minMatches: 1 },
      weight: 1,
    },
  ],
};

const storyInput: InputTypeConfig = {
  id: 'story',
  displayName: 'Complete Story',
  description: 'A fully written story with scenes, dialogue, and descriptions',
  examples: [
    'A complete short story manuscript',
    'A screenplay or script',
    'A detailed narrative with multiple scenes',
  ],
  skipsArtifacts: ['plot', 'story'],
  mapsToArtifact: 'story',
  detectionPatterns: [
    // Long content is likely a story (>800 chars)
    {
      type: 'length',
      config: { minLength: 800 },
      weight: 3,
    },
    // Even longer content is very likely a story (>2000 chars)
    {
      type: 'length',
      config: { minLength: 2000 },
      weight: 2,
    },
    // Has paragraphs (at least 2 paragraph breaks)
    {
      type: 'structure',
      config: { hasParagraphs: true },
      weight: 2,
    },
    // Has dialogue markers
    {
      type: 'structure',
      config: { hasDialogue: true },
      weight: 2,
    },
    // Contains narrative keywords (only need 2 matches)
    {
      type: 'keywords',
      config: {
        keywords: [
          'said', 'asked', 'replied', 'whispered', 'shouted',  // dialogue tags
          'walked', 'looked', 'turned', 'ran', 'sat', 'stood',  // action verbs
          'chapter', 'scene', 'INT.', 'EXT.',  // structure markers
          'she', 'he', 'they', 'her', 'his', 'their',  // pronouns (narrative)
          'morning', 'evening', 'night', 'day',  // time markers
        ],
        minMatches: 2,
      },
      weight: 2,
    },
  ],
};

// =============================================================================
// PHASE DEFINITIONS
// =============================================================================

const phases: PhaseDefinition[] = [
  {
    id: 'concept',
    displayName: 'Concept Development',
    description: 'Develop the core story concept and plot outline',
    order: 1,
    artifactTypes: ['plot'],
    requiresConfirmation: false,
    promptFile: 'narrative/phases/concept.md',
  },
  {
    id: 'narrative',
    displayName: 'Story Writing',
    description: 'Write the full narrative story',
    order: 2,
    artifactTypes: ['story'],
    requiresConfirmation: false,
    promptFile: 'narrative/phases/narrative.md',
  },
  {
    id: 'breakdown',
    displayName: 'Story Breakdown',
    description: 'Identify the editorial intent then break the story into characters, settings, and scenes',
    order: 3,
    artifactTypes: ['story_essence', 'character', 'setting', 'object', 'scene'],
    requiresConfirmation: false,
    promptFile: 'narrative/phases/breakdown.md',
  },
  {
    id: 'world_style',
    displayName: 'World Style',
    description: 'Define the visual and auditory style bible for the project',
    order: 3.5,
    artifactTypes: ['world_style'],
    requiresConfirmation: false,
    promptFile: 'narrative/phases/world-style.md',
  },
  {
    id: 'reference_images',
    displayName: 'Reference Image Generation',
    description: 'Generate reference images for characters and settings',
    order: 4,
    artifactTypes: ['character_image', 'setting_image', 'object_image'],
    requiresConfirmation: true,
    promptFile: 'narrative/phases/reference-images.md',
  },
  {
    id: 'shot_breakdown',
    displayName: 'Shot Breakdown',
    description: 'Break scenes into cinematic shots and generate per-shot image prompts',
    order: 5,
    artifactTypes: ['scene_video_prompt', 'shot_image_prompt', 'shot_motion_directive', 'shot_image'],
    requiresConfirmation: true,
    promptFile: 'narrative/phases/shot-breakdown.md',
  },
  {
    id: 'shot_videos',
    displayName: 'Shot Video Generation',
    description: 'Generate video clips for each shot from shot images',
    order: 6,
    artifactTypes: ['shot_video'],
    requiresConfirmation: true,
    promptFile: 'narrative/phases/shot-videos.md',
  },
  {
    id: 'final_assembly',
    displayName: 'Final Assembly',
    description: 'Assemble all shot videos into the final video',
    order: 7,
    artifactTypes: ['final_video'],
    requiresConfirmation: true,
    promptFile: 'narrative/phases/final-assembly.md',
  },
];

// =============================================================================
// STYLE CONFIGURATIONS
// =============================================================================

const styles: StyleConfig[] = [
  {
    id: 'cinematic_realism',
    displayName: 'Cinematic Realism',
    description: 'Photorealistic cinematic style with dramatic lighting',
    promptModifiers: [
      'cinematic',
      'photorealistic',
      'dramatic lighting',
      'film grain',
      'depth of field',
      '8k resolution',
      'professional photography',
    ],
    negativePrompt: [
      'cartoon',
      'anime',
      'illustration',
      'painting',
      'drawing',
      'sketch',
      'low quality',
      'blurry',
    ],
    comfySettings: {
      sampler: 'dpmpp_2m_sde',
      scheduler: 'karras',
      steps: 30,
      cfg: 7.5,
    },
  },
  {
    id: 'anime',
    displayName: 'Anime',
    description: 'Japanese anime art style',
    promptModifiers: [
      'anime',
      'anime style',
      'high quality anime',
      'detailed anime',
      'vibrant colors',
      'clean lines',
    ],
    negativePrompt: [
      'photorealistic',
      'photograph',
      'realistic',
      '3d render',
      'low quality',
      'blurry',
      'bad anatomy',
    ],
    comfySettings: {
      sampler: 'euler_ancestral',
      scheduler: 'normal',
      steps: 25,
      cfg: 8,
    },
  },
  {
    id: 'stylized_3d',
    displayName: 'Stylized 3D',
    description: 'Pixar/Disney-style 3D animation look',
    promptModifiers: [
      '3d render',
      'pixar style',
      'disney style',
      'stylized',
      'vibrant',
      'detailed',
      'high quality 3d',
    ],
    negativePrompt: [
      'photorealistic',
      'anime',
      '2d',
      'flat',
      'low quality',
      'blurry',
    ],
    comfySettings: {
      sampler: 'dpmpp_2m',
      scheduler: 'karras',
      steps: 28,
      cfg: 7,
    },
  },
  {
    id: 'watercolor',
    displayName: 'Watercolor',
    description: 'Soft watercolor painting style',
    promptModifiers: [
      'watercolor',
      'watercolor painting',
      'soft colors',
      'flowing',
      'artistic',
      'delicate brushstrokes',
    ],
    negativePrompt: [
      'photorealistic',
      'photograph',
      '3d',
      'digital art',
      'sharp edges',
      'low quality',
    ],
    comfySettings: {
      sampler: 'euler',
      scheduler: 'normal',
      steps: 25,
      cfg: 7,
    },
  },
];

// =============================================================================
// NARRATIVE TEMPLATE
// =============================================================================

export const narrativeTemplate: VideoTemplate = {
  id: 'narrative',
  displayName: 'Narrative Story Video',
  description: 'Create a video from a story idea or complete narrative. Perfect for short films, animated stories, and visual storytelling.',
  version: '3.0.0',
  defaultStyle: 'cinematic_realism',
  styles,
  inputTypes: [ideaInput, storyInput],
  artifactTypes: {
    plot: plotArtifact,
    story: storyArtifact,
    story_essence: storyEssenceArtifact,
    character: characterArtifact,
    setting: settingArtifact,
    object: objectArtifact,
    scene: sceneArtifact,
    world_style: worldStyleArtifact,
    character_image: characterImageArtifact,
    setting_image: settingImageArtifact,
    object_image: objectImageArtifact,
    scene_shot_plan: sceneShotPlanArtifact,
    shot_breakdown: shotBreakdownArtifact,
    scene_video_prompt: sceneVideoPromptArtifact,
    shot_image_prompt: shotImagePromptArtifact,
    shot_motion_directive: shotMotionDirectiveArtifact,
    shot_image: shotImageArtifact,
    shot_video: shotVideoArtifact,
    final_video: finalVideoArtifact,
  },
  phases,
  constraints: {
    maxSegments: 12,
    maxEntities: 10,
    maxDuration: 300, // 5 minutes
  },
  contextVariables: {
    $original_input: 'plot', // Original input maps to plot processing
    $plot: 'plot',
    $story: 'story',
    $characters: 'character',
    $settings: 'setting',
    $scenes: 'scene',
  },
  orchestratorPrompt: 'narrative/orchestrator.md',
};

export default narrativeTemplate;
