/**
 * Project state management for video creation tasks.
 * Handles persistence of story, characters, settings, storyboard, and assets.
 */

/**
 * Character definition in project state.
 */
export interface Character {
  name: string;
  description: string;
  visualDescription: string;
  personality?: string;
  backstory?: string;
  referenceImageId?: string;
}

/**
 * Setting/environment definition in project state.
 */
export interface Setting {
  name: string;
  description: string;
  visualDescription: string;
  mood?: string;
  referenceImageId?: string;
}

/**
 * Storyboard scene definition.
 */
export interface StoryboardScene {
  sceneNumber: number;
  description: string;
  characters: string[];
  setting: string;
  action: string;
  dialogue?: string;
  imagePrompt: string;
  imageArtifactId?: string;
  duration?: number;
}

/**
 * Complete project state.
 */
export interface ProjectState {
  id: string;
  title?: string;
  plot?: string;
  characters: Map<string, Character>;
  settings: Map<string, Setting>;
  storyboard: StoryboardScene[];
  assets: Map<string, { type: string; path: string; metadata?: Record<string, unknown> }>;
  createdAt: number;
  updatedAt: number;
}

// In-memory project state (would be persisted to DB in production)
// Note: The workflow now uses file-based state in .dhee/ directory instead.
// These functions are kept for backwards compatibility but may be removed later.
let currentProjectId: string | null = null;

/**
 * Reset project state (for testing or starting fresh).
 */
export function resetProjectState(): void {
  currentProjectId = null;
}

/**
 * Set the current project ID (for session management).
 */
export function setCurrentProjectId(id: string): void {
  currentProjectId = id;
}
