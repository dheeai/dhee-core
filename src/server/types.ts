/**
 * WebSocket message types for dhee-core server.
 * Follows the same pattern as the Python dhee project.
 */

/**
 * Message types sent from server to client.
 */
export type ServerMessageType =
  | 'status'              // Connection/session status
  | 'progress'            // Agent progress updates
  | 'agent_response'      // Final agent response
  | 'agent_question'      // Agent asking user a question
  | 'tool_call'           // Tool execution notification
  | 'todo_update'         // Todo list changes
  | 'stream_chunk'        // Streaming text chunk
  | 'stream_end'          // End of streaming
  | 'context_usage'       // Context window usage stats
  | 'phase_transition'    // Workflow phase change
  | 'timeline_update'     // Full timeline state update
  | 'notification'        // User-facing notification
  | 'error'               // Error message
  // Remote file system messages (server → client)
  | 'file_read_request'       // Server asks client for file content
  | 'file_write_command'       // Server tells client to write a file
  | 'file_delete_command'      // Server tells client to delete a file
  | 'file_list_request'        // Server asks for directory listing
  | 'file_exists_request'      // Server asks if path exists
  | 'file_stat_request'        // Server asks for file stats
  | 'file_mkdir_command'       // Server tells client to create directory
  | 'file_copy_command'        // Server tells client to copy a file
  | 'file_read_buffer_request' // Server asks for binary file
  | 'file_write_buffer_command' // Server tells client to write binary
  | 'file_delete_dir_command'  // Server tells client to delete directory
  | 'batch_write_command'      // Server tells client to write multiple files
  | 'session_timer'            // Production timer updates
  | 'asset_transfer'           // Server sends generated asset to client
  | 'assets_refresh'           // Server pushes full asset list (e.g. after reset)
  | 'timeline_assembly_request' // Server asks desktop to assemble final video
  | 'history'                  // Replayed chat history snapshot on resume
  | 'history_cleared';         // Confirmation that chat history was purged

/**
 * Message types sent from client to server.
 */
export type ClientMessageType =
  | 'start_task'           // Start a new task
  | 'user_response'       // Response to agent question
  | 'cancel'              // Cancel current task
  | 'configure_project'   // Configure the active project/session
  | 'select_project'      // Select active project
  | 'create_project'      // Create a new project
  | 'ping'                // Keep-alive ping
  // Remote file system messages (client → server)
  | 'file_read_response'      // Client sends file content back
  | 'file_write_ack'          // Client confirms write applied
  | 'file_list_response'      // Client sends directory listing
  | 'file_exists_response'    // Client confirms if path exists
  | 'file_stat_response'      // Client sends file stats
  | 'file_buffer_response'    // Client sends binary file content
  | 'set_autonomous'          // Toggle autonomous mode at runtime
  | 'set_parallel_media'      // Toggle parallel media generation at runtime
  | 'project_state_sync'      // Client sends full project snapshot
  | 'redo_node'               // Redo a specific node (invalidate + re-execute)
  | 'reset_project'           // Reset project to a specific stage
  | 'timeline_assembly_progress' // Desktop reports assembly progress
  | 'timeline_assembly_result' // Desktop reports assembly result
  | 'clear_chat_history';        // User asked to wipe persisted chat for this session

/**
 * Base message structure for server messages.
 */
export interface ServerMessage<T = unknown> {
  type: ServerMessageType;
  sessionId: string;
  timestamp: number;
  data: T;
}

/**
 * Base message structure for client messages.
 */
export interface ClientMessage<T = unknown> {
  type: ClientMessageType;
  sessionId?: string;  // Optional for new sessions
  data: T;
}

/**
 * Status message data.
 */
export interface StatusData {
  status: 'connected' | 'ready' | 'busy' | 'completed' | 'error' | 'paused';
  message?: string;
  /** Tool names available to the agent (included with 'ready' status after project selection) */
  tools?: string[];
  /** Project name (included after create_project to auto-select in UI) */
  projectName?: string;
  /**
   * Set when status='paused' to tell the UI which `/run-to <stage>` gate
   * fired. UI can show a "paused — send /run-to <next> to continue"
   * affordance keyed off this field.
   */
  pausedAtStage?: string;
}

/**
 * Progress message data.
 */
export interface ProgressData {
  iteration: number;
  maxIterations: number;
  status: string;
}

/**
 * Agent response message data.
 */
export interface AgentResponseData {
  output: string;
  status: 'completed' | 'awaiting_input' | 'error' | 'max_iterations';
}

/**
 * Agent question message data.
 */
export interface AgentQuestionData {
  question: string;
  toolCallId: string;
  options?: Array<{ label: string; description?: string }>;
  isConfirmation?: boolean;
  autoApproveTimeoutMs?: number;
}

/**
 * Tool call message data.
 */
export interface ToolCallData {
  toolName: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
  status: 'started' | 'completed' | 'error';
  result?: unknown;
  error?: string;
  agentName?: string;  // Which agent made this call (e.g., "Content Agent", "Orchestrator")
}

/**
 * Todo update message data.
 */
export interface TodoUpdateData {
  todos: Array<{
    id: string;
    task: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    depth: number;
    hasSubtasks: boolean;
    parentId?: string;
  }>;
}

/**
 * Stream chunk message data.
 */
export interface StreamChunkData {
  content: string;
  done: boolean;
  agentName?: string;  // Which agent is streaming (e.g., "Content Agent", "Orchestrator")
  toolCallId?: string; // For tool streaming, the associated tool call
  toolName?: string;   // For tool streaming, the tool name
  reset?: boolean;     // Reset streaming content before appending
}

/**
 * Error message data.
 */
export interface ErrorData {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Context usage message data.
 */
export interface ContextUsageData {
  promptTokens: number;
  maxTokens: number;
  percentage: number;
  wasCompressed: boolean;
  iteration: number;
}

/**
 * Phase transition message data.
 */
export interface PhaseTransitionData {
  fromPhase: string;
  toPhase: string;
  displayName?: string;
  description?: string;
}

/**
 * Timeline update message data.
 */
export interface TimelineUpdateData {
  timeline: unknown;
}

/**
 * Notification message data.
 */
export interface NotificationData {
  level: 'info' | 'warning' | 'error';
  message: string;
}

/**
 * Session timer message data.
 */
export interface SessionTimerData {
  elapsedMs: number;
  running: boolean;
  completed?: boolean;
}

/**
 * Select project client message data.
 */
export interface SelectProjectData {
  projectName: string;
}

/**
 * Configure project client message data.
 */
export interface ConfigureProjectData {
  projectDir: string;
  projectName?: string;
  templateId: string;
  style: string;
  duration: number;
  autonomousMode?: boolean;
}

// ==========================================================================
// REMOTE FILE SYSTEM PROTOCOL TYPES
// ==========================================================================

/**
 * File read response from client.
 */
export interface FileReadResponseData {
  requestId: string;
  content: string;
  error?: string;
}

/**
 * File write acknowledgment from client.
 */
export interface FileWriteAckData {
  requestId: string;
  success: boolean;
  error?: string;
}

/**
 * File list response from client.
 */
export interface FileListResponseData {
  requestId: string;
  entries: string[];
  error?: string;
}

/**
 * File exists response from client.
 */
export interface FileExistsResponseData {
  requestId: string;
  exists: boolean;
  error?: string;
}

/**
 * File stat response from client.
 */
export interface FileStatResponseData {
  requestId: string;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  error?: string;
}

/**
 * Project state sync from client (full snapshot on connect).
 */
export interface ProjectStateSyncData {
  files: Record<string, string>;
  directories: string[];
  assetHashes?: Record<string, string>;
  projectRoot: string;
}

/**
 * Asset transfer data (server → client).
 */
export interface AssetTransferData {
  path: string;
  /** Base64-encoded data for inline transfer (<1MB) */
  data?: string;
  /** HTTP download URL for large assets */
  downloadUrl?: string;
  mimeType?: string;
  size: number;
}

export interface TimelineAssemblyProgressData {
  requestId: string;
  progress?: number;
  stage?: 'preparing' | 'rendering' | 'persisting' | 'finalizing';
  message?: string;
}

export interface TimelineAssemblyResultData {
  requestId: string;
  status: 'completed' | 'failed';
  outputPath?: string;
  duration?: number;
  artifactId?: string;
  manifestRelativePath?: string;
  error?: string;
}

/**
 * Create project client message data.
 */
export interface CreateProjectData {
  title: string;
  templateId: string;
  style: string;
  duration: number;
  content: string;
  /** Video resolution preset (e.g., '480p', '720p', '1080p', '4k') */
  resolution?: string;
  /** Video width in pixels */
  resolutionWidth?: number;
  /** Video height in pixels */
  resolutionHeight?: number;
  /** Optional per-capability provider configuration */
  providerConfig?: {
    imageGeneration?: string;
    imageEditing?: string;
    videoGeneration?: string;
  };
  /** Run end-to-end without confirmations */
  autonomousMode?: boolean;
}

/**
 * Start task client message data.
 */
export interface StartTaskData {
  task: string;
  options?: {
    maxIterations?: number;
    temperature?: number;
  };
  /**
   * When set, the executor runs until every node of the given stage is
   * terminal, then pauses. Stage names are the same canonical set used
   * by `/reset` — see `src/core/planner/stages.ts` STAGE_ALIASES.
   * Unknown stage names cause the handler to reject the message.
   */
  stopAtStage?: string;
}

/**
 * Redo node client message data.
 */
export interface RedoNodeData {
  /** The node ID to invalidate and re-execute (e.g., "character:alice", "shot_video:scene_1_shot_2") */
  nodeId: string;
  /** Optional edited prompt — if provided, saved to disk before redo */
  editedPrompt?: Record<string, unknown>;
  /**
   * Optional frame key for multi-frame shot_image nodes (first_frame | last_frame | mid_frame).
   * When set, only that frame is invalidated — the other frames keep their existing outputs
   * and will be skipped by the executor's incremental retry check.
   */
  frame?: string;
  /**
   * Optional scope hint. When set to 'prompt' and nodeId is a shot_image node,
   * the backend invalidates both the shot_image_prompt and the shot_image — so
   * the LLM re-writes the prompt AND the image regenerates. Does NOT cascade
   * to shot_video/final so downstream stays put.
   */
  scope?: 'prompt';
}

/**
 * User response client message data.
 */
export interface UserResponseData {
  response: string;
  toolCallId?: string;
}

/**
 * Session state for tracking active conversations.
 */
export interface SessionState {
  id: string;
  createdAt: number;
  lastActivity: number;
  status: 'idle' | 'running' | 'awaiting_input' | 'completed' | 'error';
  taskHistory: string[];
  /** When true, skip all confirmations and run without iteration limit */
  autonomousMode?: boolean;
}

/**
 * Helper type guards.
 */
export function isStartTaskMessage(msg: ClientMessage): msg is ClientMessage<StartTaskData> {
  return msg.type === 'start_task';
}

export function isUserResponseMessage(msg: ClientMessage): msg is ClientMessage<UserResponseData> {
  return msg.type === 'user_response';
}

export function isCancelMessage(msg: ClientMessage): msg is ClientMessage<void> {
  return msg.type === 'cancel';
}

export function isPingMessage(msg: ClientMessage): msg is ClientMessage<void> {
  return msg.type === 'ping';
}

export function isSelectProjectMessage(msg: ClientMessage): msg is ClientMessage<SelectProjectData> {
  return msg.type === 'select_project';
}

export function isConfigureProjectMessage(
  msg: ClientMessage,
): msg is ClientMessage<ConfigureProjectData> {
  return msg.type === 'configure_project';
}

export function isCreateProjectMessage(msg: ClientMessage): msg is ClientMessage<CreateProjectData> {
  return msg.type === 'create_project';
}

export function isRedoNodeMessage(msg: ClientMessage): msg is ClientMessage<RedoNodeData> {
  return msg.type === 'redo_node';
}

export interface ResetProjectData {
  /** Project name (without .dhee suffix) */
  projectName: string;
  /** Stage to reset to (e.g., "characters", "shot_image_prompt") */
  stage: string;
}

export function isResetProjectMessage(msg: ClientMessage): msg is ClientMessage<ResetProjectData> {
  return msg.type === 'reset_project';
}

export function isTimelineAssemblyProgressMessage(
  msg: ClientMessage,
): msg is ClientMessage<TimelineAssemblyProgressData> {
  return msg.type === 'timeline_assembly_progress';
}

export function isTimelineAssemblyResultMessage(
  msg: ClientMessage,
): msg is ClientMessage<TimelineAssemblyResultData> {
  return msg.type === 'timeline_assembly_result';
}

/**
 * Chat history snapshot, replayed in one shot to a freshly-connected
 * frontend after a session is resumed from disk. Frontend overwrites its
 * `chatMessages` and `toolCalls` state with this payload — much simpler
 * than streaming individual events out of order.
 */
export interface HistoryChatMessage {
  id: string;
  type: 'agent' | 'user' | 'system' | 'media';
  content: string;
  timestamp: number;
  agentName?: string;
  media?: {
    kind: 'image' | 'video';
    path: string;
    project: string;
    source?: string;
  };
}

export interface HistoryToolCall {
  id: string;
  toolName: string;
  args?: Record<string, string>;
  status: 'executing' | 'completed' | 'error';
  result?: unknown;
  startTime: number;
  duration?: number;
  agentName?: string;
}

export interface HistoryData {
  /** Ordered transcript bubbles (user / agent / media). */
  messages: HistoryChatMessage[];
  /** Ordered tool-call cards. */
  toolCalls: HistoryToolCall[];
  /** Current focused project, if any (so the frontend can re-select it). */
  focusedProject?: string;
  /** Number of compaction events seen — informational. */
  compactionCount: number;
}

export function isClearChatHistoryMessage(msg: ClientMessage): msg is ClientMessage<void> {
  return msg.type === 'clear_chat_history';
}

/**
 * Create a server message.
 */
export function createServerMessage<T>(
  type: ServerMessageType,
  sessionId: string,
  data: T
): ServerMessage<T> {
  return {
    type,
    sessionId,
    timestamp: Date.now(),
    data,
  };
}
