/**
 * Application state store.
 * Replaces the global variables from the inline SPA.
 * Uses React context + useReducer for predictable state management.
 */

import { createContext, useContext } from 'react'
import type { Timeline } from './timeline-types'

// ── Types ──────────────────────────────────────────────────

export interface Project {
  name: string
  phase?: string
  templateId?: string
}

export interface TodoItem {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  category?: string
}

export interface ToolCall {
  id: string
  toolName: string
  args?: Record<string, string>
  status: 'executing' | 'completed' | 'error'
  result?: unknown
  streamingContent?: string
  startTime: number
  duration?: number
  agentName?: string
}

export interface ChatMessage {
  id: string
  type: 'agent' | 'user' | 'system' | 'media'
  content: string
  timestamp: number
  agentName?: string
  /** Set on `type: 'media'` messages — frontend renders the image/video inline. */
  media?: {
    kind: 'image' | 'video'
    /** Path relative to <project>.dhee/. URL is built as /api/v1/assets/<project>/<path>. */
    path: string
    project: string
    /** Tool name that produced the asset, for the small caption above the media. */
    source?: string
  }
}

export interface MediaPreview {
  id: string
  type: 'image' | 'video'
  url: string
  label?: string
}

/**
 * Minimal executor node projection the frontend cares about.
 *
 * We only store the fields the UI actually reads. Not the full node —
 * things like `dependencies`, `promptHistory`, `createdAt` stay
 * server-side. Keeping this narrow also makes the WebSocket node-update
 * payload small and the reducer predictable.
 */
export interface ExecutorNodeInfo {
  id: string                 // e.g. "shot_image:scene_1_shot_3"
  typeId: string             // e.g. "shot_image", "shot_video", "shot_image_prompt"
  itemId?: string            // e.g. "scene_1_shot_3"
  displayName?: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | string
  /** Single output (most node types — shot_video, shot_motion_directive, etc.). */
  outputPath?: string
  /** Multi-frame output (shot_image: `{first_frame, last_frame, mid_frame?}`). */
  outputPaths?: Record<string, string>
}

export interface AppState {
  // Connection
  sessionId: string | null
  connectionStatus: 'connecting' | 'connected' | 'disconnected'

  // Project
  projects: Project[]
  selectedProject: string | null
  projectMode: 'none' | 'existing' | 'new'
  phase: string | null

  // Execution
  todos: TodoItem[]
  toolCalls: ToolCall[]
  chatMessages: ChatMessage[]
  streamingText: string | null
  agentStatus: 'idle' | 'thinking' | 'waiting' | 'completed' | 'error'

  // Timer
  timer: { elapsedMs: number; running: boolean; completed: boolean }

  // Context usage
  contextUsage: { percentage: number; promptTokens: number; maxTokens: number } | null

  // Assets
  assets: Array<{ id: string; path: string; url: string; type: string; nodeId?: string; frame?: 'first_frame' | 'last_frame' | 'mid_frame' | 'single' }>

  // Executor nodes — keyed by nodeId (e.g. "shot_image:scene_1_shot_3").
  // This is the canonical source of truth for "which files belong to which
  // shot". The Storyboard reads shot_image / shot_video nodes directly
  // from here to get outputPaths; filename parsing is gone. Populated
  // from `/api/v1/projects/:name` on project select and refreshed via
  // node update events over WebSocket.
  nodes: Record<string, ExecutorNodeInfo>

  // Timeline
  timeline: Timeline | null
  activeView: 'chat' | 'storyboard' | 'timeline'

  // Settings
  autonomousMode: boolean
  parallelMedia: boolean
}

export const initialState: AppState = {
  sessionId: null,
  connectionStatus: 'disconnected',
  projects: [],
  selectedProject: null,
  projectMode: 'none',
  phase: null,
  todos: [],
  toolCalls: [],
  chatMessages: [],
  streamingText: null,
  agentStatus: 'idle',
  timer: { elapsedMs: 0, running: false, completed: false },
  contextUsage: null,
  assets: [],
  nodes: {},
  timeline: null,
  activeView: 'chat' as const,
  autonomousMode: false,
  parallelMedia: false,
}

// ── Actions ────────────────────────────────────────────────

export type AppAction =
  | { type: 'SET_CONNECTION'; status: AppState['connectionStatus']; sessionId?: string }
  | { type: 'SET_PROJECTS'; projects: Project[] }
  | { type: 'SELECT_PROJECT'; name: string | null }
  | { type: 'ENTER_NEW_PROJECT_FLOW' }
  | { type: 'SET_PHASE'; phase: string | null }
  | { type: 'SET_TODOS'; todos: TodoItem[] }
  | { type: 'ADD_TOOL_CALL'; toolCall: ToolCall }
  | { type: 'UPDATE_TOOL_CALL'; id: string; updates: Partial<ToolCall> }
  | { type: 'APPEND_TOOL_STREAMING'; id: string; chunk: string; reset?: boolean }
  | { type: 'ADD_CHAT_MESSAGE'; message: ChatMessage }
  | { type: 'SET_STREAMING_TEXT'; text: string | null }
  | { type: 'APPEND_STREAMING_TEXT'; chunk: string }
  | { type: 'SET_AGENT_STATUS'; status: AppState['agentStatus'] }
  | { type: 'SET_CONTEXT_USAGE'; usage: AppState['contextUsage'] }
  | { type: 'SET_ASSETS'; assets: AppState['assets'] }
  | { type: 'ADD_ASSET'; asset: AppState['assets'][0] }
  /**
   * Overwrite the entire node map — used on initial project load where
   * we fetch `/api/v1/projects/:name` and hydrate from `executorState.nodes`.
   */
  | { type: 'SET_NODES'; nodes: Record<string, ExecutorNodeInfo> }
  /**
   * Merge a single node's info. WebSocket handlers dispatch this when
   * a shot_image / shot_video node completes and its outputPath(s)
   * become available. Keeps the Storyboard live without a full reload.
   */
  | { type: 'UPDATE_NODE'; node: ExecutorNodeInfo }
  | { type: 'SET_AUTONOMOUS'; enabled: boolean }
  | { type: 'SET_PARALLEL_MEDIA'; enabled: boolean }
  | { type: 'SET_TIMELINE'; timeline: Timeline | null }
  | { type: 'SET_ACTIVE_VIEW'; view: 'chat' | 'storyboard' | 'timeline' }
  | { type: 'SET_TIMER'; timer: AppState['timer'] }
  | { type: 'SET_HISTORY'; messages: ChatMessage[]; toolCalls: ToolCall[] }
  | { type: 'CLEAR_CHAT' }

// ── Reducer ────────────────────────────────────────────────

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_CONNECTION':
      return {
        ...state,
        connectionStatus: action.status,
        sessionId: action.sessionId ?? state.sessionId,
      }

    case 'SET_PROJECTS':
      return { ...state, projects: action.projects }

    case 'SELECT_PROJECT':
      // Project-scoped state (todos, assets, nodes, timeline, phase) is
      // wiped because those are derived from the project on disk.
      // chat state is NOT wiped — it lives on the agent session, which
      // is shared across project switches and persisted to disk. Wiping
      // it here would hide messages the agent still remembers in its
      // context, breaking resume on every project switch. Use the
      // "New chat" button (CLEAR_CHAT) for an explicit reset.
      return {
        ...state,
        selectedProject: action.name,
        projectMode: action.name ? 'existing' : 'none',
        phase: null,
        todos: [],
        assets: [],
        nodes: {},
        streamingText: null,
        agentStatus: 'idle',
        timer: { elapsedMs: 0, running: false, completed: false },
        timeline: null,
        activeView: 'chat',
      }

    case 'ENTER_NEW_PROJECT_FLOW':
      return {
        ...state,
        selectedProject: null,
        projectMode: 'new',
        phase: null,
        todos: [],
        assets: [],
        chatMessages: [],
        toolCalls: [],
        streamingText: null,
        agentStatus: 'idle',
        timer: { elapsedMs: 0, running: false, completed: false },
        contextUsage: null,
        timeline: null,
        activeView: 'chat',
      }

    case 'SET_PHASE':
      return { ...state, phase: action.phase }

    case 'SET_TODOS':
      return { ...state, todos: action.todos }

    case 'ADD_TOOL_CALL':
      return { ...state, toolCalls: [...state.toolCalls, action.toolCall] }

    case 'UPDATE_TOOL_CALL':
      return {
        ...state,
        toolCalls: state.toolCalls.map(tc =>
          tc.id === action.id ? { ...tc, ...action.updates } : tc
        ),
      }

    case 'APPEND_TOOL_STREAMING': {
      return {
        ...state,
        toolCalls: state.toolCalls.map(tc => {
          if (tc.id !== action.id) return tc
          const content = action.reset ? action.chunk : (tc.streamingContent ?? '') + action.chunk
          return { ...tc, streamingContent: content }
        }),
      }
    }

    case 'ADD_CHAT_MESSAGE':
      return { ...state, chatMessages: [...state.chatMessages, action.message] }

    case 'SET_STREAMING_TEXT':
      return { ...state, streamingText: action.text }

    case 'APPEND_STREAMING_TEXT':
      return { ...state, streamingText: (state.streamingText ?? '') + action.chunk }

    case 'SET_AGENT_STATUS':
      return { ...state, agentStatus: action.status }

    case 'SET_CONTEXT_USAGE':
      return { ...state, contextUsage: action.usage }

    case 'SET_ASSETS':
      return { ...state, assets: action.assets }

    case 'ADD_ASSET':
      // Avoid duplicates by path
      if (state.assets.some(a => a.path === action.asset.path)) return state
      return { ...state, assets: [...state.assets, action.asset] }

    case 'SET_NODES':
      return { ...state, nodes: action.nodes }

    case 'UPDATE_NODE': {
      // Merge-by-id. Preserves fields we already had (e.g. displayName,
      // typeId) if the incoming partial omits them.
      const existing = state.nodes[action.node.id]
      return { ...state, nodes: { ...state.nodes, [action.node.id]: { ...existing, ...action.node } } }
    }

    case 'SET_AUTONOMOUS':
      return { ...state, autonomousMode: action.enabled }

    case 'SET_PARALLEL_MEDIA':
      return { ...state, parallelMedia: action.enabled }

    case 'SET_TIMELINE':
      return { ...state, timeline: action.timeline }

    case 'SET_TIMER':
      return { ...state, timer: action.timer }

    case 'SET_ACTIVE_VIEW':
      return { ...state, activeView: action.view }

    case 'SET_HISTORY':
      // Hydrate chat panel from a server-replayed snapshot. Overwrites
      // any in-flight streaming state since the server is authoritative
      // on what happened before this connection.
      return {
        ...state,
        chatMessages: action.messages,
        toolCalls: action.toolCalls,
        streamingText: null,
      }

    case 'CLEAR_CHAT':
      return {
        ...state,
        chatMessages: [],
        toolCalls: [],
        streamingText: null,
        agentStatus: 'idle',
        contextUsage: null,
        todos: [],
      }

    default:
      return state
  }
}

// ── Context ────────────────────────────────────────────────

export const AppStateContext = createContext<AppState>(initialState)
export const AppDispatchContext = createContext<React.Dispatch<AppAction>>(() => {})

export function useAppState() {
  return useContext(AppStateContext)
}

export function useAppDispatch() {
  return useContext(AppDispatchContext)
}
