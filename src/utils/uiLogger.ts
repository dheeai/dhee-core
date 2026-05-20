/**
 * UI Logger - Captures screen output to a log file.
 * Mirrors exactly what appears in the UI, in the same order.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLogsDir } from './logsPath.js';

// Resolve lazily so a host that calls setLogsDir after import (e.g.
// dhee-desktop pointing at app.getPath('userData')/logs in a packaged
// build) still wins. getLogsDir() also ensures the directory exists.
function uiLogPath(): string {
  return path.join(getLogsDir(), 'ui-output.log');
}

/**
 * Write a line to the UI log file.
 */
function writeLog(line: string): void {
  try {
    fs.appendFileSync(uiLogPath(), line + '\n');
  } catch {
    // Ignore write errors
  }
}

/**
 * Initialize the log file for a new session.
 */
export function initUILog(): void {
  try {
    const header = `════════════════════════════════════════════════════════════════════════════════
 dhee SESSION LOG
════════════════════════════════════════════════════════════════════════════════
`;
    fs.writeFileSync(uiLogPath(), header);
  } catch {
    // Ignore initialization errors
  }
}

/**
 * Log user input - matches the green bordered box in ScrollableHistory.
 * Format: "👤 You: [content]"
 */
export function logUserInput(content: string): void {
  writeLog('');
  writeLog('┌──────────────────────────────────────────────────────────────────────────────┐');
  writeLog('│ 👤 You:');
  // Write content with proper indentation
  const lines = content.split('\n');
  for (const line of lines) {
    writeLog(`│ ${line}`);
  }
  writeLog('└──────────────────────────────────────────────────────────────────────────────┘');
}

/**
 * Log agent text - matches dimColor text in ScrollableHistory.
 */
export function logAgentText(text: string): void {
  if (!text.trim()) return;
  writeLog('');
  const lines = text.split('\n');
  for (const line of lines) {
    writeLog(line);
  }
}

/**
 * Log tool call start - matches ToolCallDisplay executing state.
 * Format: "◉ [Spinner] Running toolname"
 */
export function logToolStart(toolName: string, args?: Record<string, unknown>): void {
  writeLog('');
  writeLog(`┌─ 🔧 ${getToolDisplayName(toolName, true)} ─────────────────────────────────────`);
  if (args && Object.keys(args).length > 0) {
    writeLog(`│ ${formatToolCall(toolName, args)}`);
  }
}

/**
 * Log tool call completion - matches ToolCallDisplay completed state.
 * Format: "✓ Ran toolname (duration)"
 */
export function logToolComplete(
  toolName: string,
  result: unknown,
  duration?: number,
  isError = false
): void {
  const icon = isError ? '✗' : '✓';
  const durationStr = duration ? ` (${formatDuration(duration)})` : '';
  writeLog(`│ ${icon} ${getToolDisplayName(toolName, false)}${durationStr}`);

  // Log result for non-hidden tools
  if (!isHiddenTool(toolName)) {
    const resultStr = formatResult(result, isError);
    if (resultStr) {
      const lines = resultStr.split('\n');
      for (const line of lines) {
        writeLog(`│ ${line}`);
      }
    }
  }
  writeLog('└──────────────────────────────────────────────────────────────────────────────');
}

/**
 * Log question prompt - matches QuestionPrompt component.
 */
export function logQuestion(
  question: string,
  options?: Array<{ label: string; description?: string }>,
  isConfirmation = false,
  autoApproveTimeoutMs?: number
): void {
  writeLog('');
  writeLog('┌─ ❓ Question ────────────────────────────────────────────────────────────────┐');
  writeLog(`│ ${question}`);

  if (options && options.length > 0) {
    writeLog('│');
    options.forEach((opt, i) => {
      const selected = i === 0 ? '>' : ' ';
      const desc = opt.description ? ` - ${opt.description}` : '';
      writeLog(`│ ${selected} ${i + 1}. ${opt.label}${desc}`);
    });
  } else if (isConfirmation) {
    writeLog('│');
    writeLog('│   Press y for Yes, n for No');
  }

  if (autoApproveTimeoutMs) {
    writeLog('│');
    writeLog(`│ Auto-approve in ${Math.ceil(autoApproveTimeoutMs / 1000)}s`);
  }
  writeLog('└──────────────────────────────────────────────────────────────────────────────┘');
}

/**
 * Log status bar change - matches StatusBar component.
 */
export function logStatusChange(status: string, agentName?: string): void {
  const statusDisplay: Record<string, string> = {
    idle: '○ Idle',
    thinking: '● Thinking...',
    waiting: '? Waiting for input',
    completed: '✓ Completed',
    error: '✗ Error',
    started: '● Started',
  };
  const display = statusDisplay[status] || status;
  const name = agentName || 'Agent';
  writeLog(`[${name}] ${display}`);
}

/**
 * Log todo list - matches TodoList component.
 * Shows all todos with status icons.
 */
export function logTodoUpdate(todos: Array<{ content: string; status: string }>): void {
  if (todos.length === 0) return;

  const completed = todos.filter(t => t.status === 'completed').length;

  writeLog('');
  writeLog(`┌─ 📋 Todos (${completed}/${todos.length}) ─────────────────────────────────────────────────`);
  todos.forEach(todo => {
    const icon = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : '○';
    writeLog(`│ ${icon} ${todo.content}`);
  });
  writeLog('└──────────────────────────────────────────────────────────────────────────────');
}

/**
 * Log auto-approve event.
 */
export function logAutoApprove(selectedOption: string): void {
  writeLog('');
  writeLog(`⏰ Auto-approved: ${selectedOption}`);
}

/**
 * Log context usage update.
 */
export function logContextUsage(percentage: number, promptTokens: number, maxTokens: number, iteration: number, wasCompressed: boolean): void {
  const barWidth = 20;
  const filled = Math.round((percentage / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const compressedLabel = wasCompressed ? ' [COMPRESSED]' : '';
  writeLog(`CTX [${bar}] ${percentage}% (${promptTokens}/${maxTokens}) #${iteration}${compressedLabel}`);
}

/**
 * Log error display - matches error state in AgentView.
 */
export function logError(error: string): void {
  writeLog('');
  writeLog(`✗ Error: ${error}`);
}

/**
 * Log streaming text when it completes.
 */
export function logStreamingComplete(text: string): void {
  // Streaming text becomes agent_text in history, so just log as agent text
  logAgentText(text);
}

/**
 * Log session end.
 */
export function logSessionEnd(): void {
  writeLog('');
  writeLog('════════════════════════════════════════════════════════════════════════════════');
  writeLog(' SESSION ENDED');
  writeLog('════════════════════════════════════════════════════════════════════════════════');
}

/**
 * Get the log file path.
 */
export function getUILogPath(): string {
  return uiLogPath();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions (matching ToolCallDisplay.tsx logic)
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_DISPLAY_NAMES: Record<string, { gerund: string; past: string }> = {
  think: { gerund: 'Thinking', past: 'Thought' },
  AskUserQuestion: { gerund: 'Asking user', past: 'Asked user' },
  ask_user: { gerund: 'Asking user', past: 'Asked user' },
  dispatch_agent: { gerund: 'Dispatching agent', past: 'Dispatched agent' },
  generate_image: { gerund: 'Generating image', past: 'Generated image' },
  generate_video: { gerund: 'Generating video', past: 'Generated video' },
  edit_image: { gerund: 'Editing image', past: 'Edited image' },
  wait_for_job: { gerund: 'Waiting for job', past: 'Job completed' },
  read_project: { gerund: 'Reading project', past: 'Read project' },
  update_project: { gerund: 'Updating project', past: 'Updated project' },
  read_file: { gerund: 'Reading file', past: 'Read file' },
  import_file: { gerund: 'Importing file', past: 'Imported file' },
  TodoWrite: { gerund: 'Updating todos', past: 'Updated todos' },
  todo_write: { gerund: 'Updating todos', past: 'Updated todos' },
};

const HIDDEN_TOOLS = new Set(['TodoWrite', 'todo_write']);

function isHiddenTool(toolName: string): boolean {
  return HIDDEN_TOOLS.has(toolName);
}

function getToolDisplayName(toolName: string, isExecuting: boolean): string {
  const names = TOOL_DISPLAY_NAMES[toolName];
  if (!names) {
    return isExecuting ? `Running ${toolName}` : `Ran ${toolName}`;
  }
  return isExecuting ? names.gerund : names.past;
}

function formatToolCall(name: string, args?: Record<string, unknown>): string {
  if (!args || Object.keys(args).length === 0) {
    return `${name}()`;
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      // No truncation - show full string
      parts.push(`${key}="${value}"`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}=${String(value)}`);
    } else if (Array.isArray(value)) {
      // Show full array as JSON
      parts.push(`${key}=${JSON.stringify(value)}`);
    } else if (value !== null && typeof value === 'object') {
      // Show full object as JSON
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }

  return `${name}(${parts.join(', ')})`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function formatResult(result: unknown, isError: boolean): string {
  if (result === undefined || result === null) return '';

  const resultObj = result as Record<string, unknown>;

  // For dispatch_agent with plan, show the full plan
  if (resultObj['plan']) {
    const plan = String(resultObj['plan']);
    return `Plan: ${plan}`;
  }

  // For errors, show the error
  if (isError || resultObj['status'] === 'error') {
    return `Error: ${resultObj['error'] || resultObj['warning'] || JSON.stringify(result, null, 2)}`;
  }

  // For loop warnings
  if (resultObj['status'] === 'loop_warning' || resultObj['status'] === 'loop_blocked') {
    return String(resultObj['warning']);
  }

  // For simple status results
  if (resultObj['status'] === 'success' && resultObj['message']) {
    return String(resultObj['message']);
  }

  // For awaiting_verification (content was already streamed), show summary only
  if (resultObj['status'] === 'awaiting_verification') {
    const contentType = resultObj['content_type'] || 'content';
    const outputFile = resultObj['output_file'] || '';
    return `Generated ${contentType}${outputFile ? ` (will save to ${outputFile})` : ''}`;
  }

  // For approved content, show summary without full content
  if (resultObj['status'] === 'approved' && resultObj['message']) {
    return String(resultObj['message']);
  }

  // Default: full JSON output (no truncation)
  return JSON.stringify(result, null, 2);
}
