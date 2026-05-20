/**
 * Expandable Todo Manager with hierarchical task support.
 * Ported from Python dhee GenericAgent.
 */
import type { ExpandableTodoItem, TodoManagerResult, TodoStatus } from './ExpandableTodoItem.js';
import { createTodoItem } from './ExpandableTodoItem.js';

/** Valid status values */
const VALID_STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed', 'cancelled', 'expanded']);

/**
 * Normalize a status value to lowercase and validate it.
 * Returns 'pending' for invalid values.
 */
function normalizeStatus(status: unknown): TodoStatus {
  if (typeof status !== 'string') return 'pending';
  const normalized = status.toLowerCase() as TodoStatus;
  return VALID_STATUSES.has(normalized) ? normalized : 'pending';
}

export class ExpandableTodoManager {
  private todos: ExpandableTodoItem[] = [];

  /**
   * Set the initial todo list from task descriptions.
   * Should only be used once at the start; use updateTodo or addSubtasks after.
   */
  setTodos(tasks: string[]): TodoManagerResult {
    if (this.todos.length > 0) {
      return {
        status: 'error',
        message: 'Todo list already exists. Use updateTodo or addSubtasks.',
        todos: this.todos,
        error: 'Todo list already exists',
      };
    }

    this.todos = tasks.map((task, i) =>
      createTodoItem(task, {
        status: i === 0 ? 'in_progress' : 'pending',
        depth: 0,
      })
    );

    return {
      status: 'success',
      message: `Created ${this.todos.length} todos`,
      todos: this.todos,
    };
  }

  /**
   * Update the status of a todo by matching its content.
   * Partial match is supported. Auto-starts next pending when completing.
   */
  updateTodo(task: string, status: TodoStatus): TodoManagerResult {
    if (!['completed', 'in_progress', 'pending', 'cancelled'].includes(status)) {
      return {
        status: 'error',
        message: `Invalid status: ${status}`,
        todos: this.todos,
        error: `Invalid status: ${status}`,
      };
    }

    // Find matching todo by content (partial match)
    const taskLower = task.toLowerCase();
    const matchIdx = this.todos.findIndex(
      t => taskLower.includes(t.content.toLowerCase()) || t.content.toLowerCase().includes(taskLower)
    );

    if (matchIdx === -1) {
      return {
        status: 'error',
        message: `No todo found matching '${task}'`,
        todos: this.todos,
        error: `No todo found matching '${task}'`,
      };
    }

    const todo = this.todos[matchIdx];
    if (!todo) {
      return {
        status: 'error',
        message: 'Todo not found',
        todos: this.todos,
        error: 'Todo not found',
      };
    }

    const oldStatus = todo.status;
    todo.status = status;

    // Auto-start next pending when completing/cancelling
    if (status === 'completed' || status === 'cancelled') {
      const nextPending = this.todos.find(t => t.status === 'pending');
      if (nextPending) {
        nextPending.status = 'in_progress';
      }
    }

    return {
      status: 'success',
      message: `Updated '${todo.content}' from ${oldStatus} to ${status}`,
      todos: this.todos,
    };
  }

  /**
   * Add subtasks under a parent task.
   * Parent becomes "expanded" and subtasks are inserted after it.
   */
  addSubtasks(parentTask: string, subtasks: string[]): TodoManagerResult {
    if (subtasks.length === 0) {
      return {
        status: 'error',
        message: 'No subtasks provided',
        todos: this.todos,
        error: 'No subtasks provided',
      };
    }

    // Find matching parent todo
    const taskLower = parentTask.toLowerCase();
    const parentIdx = this.todos.findIndex(
      t => taskLower.includes(t.content.toLowerCase()) || t.content.toLowerCase().includes(taskLower)
    );

    if (parentIdx === -1) {
      return {
        status: 'error',
        message: `No todo found matching '${parentTask}'`,
        todos: this.todos,
        error: `No todo found matching '${parentTask}'`,
      };
    }

    const parent = this.todos[parentIdx];
    if (!parent) {
      return {
        status: 'error',
        message: 'Parent not found',
        todos: this.todos,
        error: 'Parent not found',
      };
    }

    parent.status = 'expanded';

    const newItems: ExpandableTodoItem[] = subtasks.map((content, i) =>
      createTodoItem(content, {
        status: i === 0 ? 'in_progress' : 'pending',
        depth: parent.depth + 1,
      })
    );

    this.todos = [...this.todos.slice(0, parentIdx + 1), ...newItems, ...this.todos.slice(parentIdx + 1)];

    return {
      status: 'success',
      message: `Added ${subtasks.length} subtasks under '${parent.content}'`,
      todos: this.todos,
    };
  }

  /**
   * Legacy expand_todo support (index-based).
   */
  expandTodo(
    todoIndex: number,
    subTodos: Array<{ content: string; visible?: boolean }>
  ): TodoManagerResult {
    if (todoIndex < 0 || todoIndex >= this.todos.length) {
      return {
        status: 'error',
        message: `Invalid todo index: ${todoIndex}`,
        todos: this.todos,
        error: `Invalid todo index: ${todoIndex}`,
      };
    }

    const original = this.todos[todoIndex];
    if (!original) {
      return {
        status: 'error',
        message: 'Todo not found',
        todos: this.todos,
        error: 'Todo not found',
      };
    }

    original.status = 'expanded';

    const newItems: ExpandableTodoItem[] = subTodos.map((sub, i) =>
      createTodoItem(sub.content, {
        status: i === 0 ? 'in_progress' : 'pending',
        visible: sub.visible ?? true,
        depth: original.depth + 1,
      })
    );

    this.todos = [
      ...this.todos.slice(0, todoIndex + 1),
      ...newItems,
      ...this.todos.slice(todoIndex + 1),
    ];

    return {
      status: 'success',
      message: `Expanded '${original.content}' into ${newItems.length} sub-todos`,
      todos: this.todos,
    };
  }

  /**
   * Remove todos by their IDs.
   * Returns the removed count.
   */
  removeTodosById(ids: string[]): TodoManagerResult {
    const idSet = new Set(ids);
    const before = this.todos.length;
    this.todos = this.todos.filter(t => !idSet.has(t.id));
    const removed = before - this.todos.length;

    return {
      status: 'success',
      message: `Removed ${removed} todo(s)`,
      todos: this.todos,
    };
  }

  /**
   * Direct todo list write - for backwards compatibility and testing.
   * Preserves completed todos that are not in the new list.
   */
  writeTodos(todos: Array<Record<string, unknown>>): TodoManagerResult {
    // Get existing completed todos to preserve them
    const existingCompleted = this.todos.filter(t => t.status === 'completed');

    // Create new todos from input
    const newTodos = todos.map(t => {
      const content = (t['content'] as string | undefined) ?? '';
      const status = normalizeStatus(t['status']);
      const activeForm = t['activeForm'] as string | undefined;

      // Preserve explicit IDs if provided (Claude SDK-style TodoWrite), otherwise generate.
      const providedId = t['id'] as string | undefined;
      const item = createTodoItem(content, {
        status,
        activeForm,
        visible: (t['visible'] as boolean | undefined) ?? true,
        depth: (t['depth'] as number | undefined) ?? 0,
      });
      if (providedId) item.id = providedId;
      return item;
    });

    // Check if new todos contain the completed ones (by content)
    const newContents = new Set(newTodos.map(t => t.content.toLowerCase()));

    // Add back completed todos that are missing from new list
    const preservedCompleted = existingCompleted.filter(
      completed => !newContents.has(completed.content.toLowerCase())
    );

    // Combine: preserved completed first, then new todos
    this.todos = [...preservedCompleted, ...newTodos];

    return {
      status: 'success',
      message: `Todo list updated with ${this.todos.length} items (${preservedCompleted.length} completed preserved)`,
      todos: this.todos,
    };
  }

  /**
   * Merge todo updates by id (Claude SDK-style TodoWrite merge=true).
   * - Updates existing items if id matches
   * - Adds new items if id is new
   * - Leaves unspecified items unchanged
   *
   * IMPORTANT: Creates new objects to ensure React re-renders (React.memo compares by reference)
   */
  mergeTodosById(updates: Array<Record<string, unknown>>): TodoManagerResult {
    // Build update map
    const updateMap = new Map<string, Record<string, unknown>>();
    for (const u of updates) {
      const id = u['id'] as string | undefined;
      if (id) updateMap.set(id, u);
    }

    // Track which IDs we've seen (for adding new items)
    const existingIds = new Set(this.todos.map(t => t.id));

    // Create new array with updated items (immutable update pattern)
    let newTodos = this.todos.map(todo => {
      const update = updateMap.get(todo.id);
      if (!update) return todo; // No update for this item, keep as-is

      const content = update['content'] as string | undefined;
      const status = update['status'] !== undefined ? normalizeStatus(update['status']) : undefined;
      const activeForm = update['activeForm'] as string | undefined;

      // Create a NEW object with updated properties (for React.memo to detect change)
      return {
        ...todo,
        ...(typeof content === 'string' ? { content } : {}),
        ...(typeof activeForm === 'string' ? { activeForm } : {}),
        ...(status ? { status } : {}),
      };
    });

    // Add new items that don't exist yet
    for (const u of updates) {
      const id = u['id'] as string | undefined;
      if (!id || existingIds.has(id)) continue;

      const content = u['content'] as string | undefined;
      const status = u['status'] !== undefined ? normalizeStatus(u['status']) : 'pending';
      const activeForm = u['activeForm'] as string | undefined;

      const item = createTodoItem(content ?? '', {
        status,
        activeForm,
        depth: 0,
      });
      item.id = id;
      newTodos.push(item);
    }

    // Ensure exactly one in_progress if possible (auto-heal)
    // Also use immutable updates here
    const inProgressIndices = newTodos
      .map((t, i) => (t.status === 'in_progress' ? i : -1))
      .filter(i => i !== -1);

    if (inProgressIndices.length === 0) {
      const pendingIdx = newTodos.findIndex(t => t.status === 'pending');
      if (pendingIdx !== -1) {
        newTodos = newTodos.map((t, i) =>
          i === pendingIdx ? { ...t, status: 'in_progress' as const } : t
        );
      }
    } else if (inProgressIndices.length > 1) {
      // Keep first, demote the rest to pending
      const toKeep = inProgressIndices[0];
      newTodos = newTodos.map((t, i) =>
        inProgressIndices.includes(i) && i !== toKeep
          ? { ...t, status: 'pending' as const }
          : t
      );
    }

    this.todos = newTodos;

    return {
      status: 'success',
      message: `Merged ${updates.length} todo updates by id`,
      todos: this.todos,
    };
  }

  /**
   * Get the current todo list.
   */
  getTodos(visibleOnly = false): ExpandableTodoItem[] {
    if (visibleOnly) {
      return this.todos.filter(t => t.visible);
    }
    return [...this.todos];
  }

  /**
   * Get the next actionable todo (first pending or in_progress).
   */
  getNextActionable(): { index: number; todo: ExpandableTodoItem } | null {
    for (let i = 0; i < this.todos.length; i++) {
      const todo = this.todos[i];
      if (todo && (todo.status === 'in_progress' || todo.status === 'pending')) {
        return { index: i, todo };
      }
    }
    return null;
  }

  /**
   * Check for out-of-order todos and return warnings.
   */
  getOrderingWarnings(): string[] {
    const warnings: string[] = [];
    const seenPendingAtDepth: Map<number, string> = new Map();

    for (const todo of this.todos) {
      const depth = todo.depth;

      if (todo.status === 'pending') {
        if (!seenPendingAtDepth.has(depth)) {
          seenPendingAtDepth.set(depth, todo.content);
        }
      } else if (todo.status === 'in_progress') {
        const pendingContent = seenPendingAtDepth.get(depth);
        if (pendingContent) {
          warnings.push(
            `WARNING: Working on '${todo.content}' while earlier task '${pendingContent}' is still pending`
          );
        }
      }
    }

    return warnings;
  }

  /**
   * Build the todo list as a system reminder with prominent next-todo guidance.
   */
  toReminderText(): string {
    if (this.todos.length === 0) {
      return '<system-reminder>\nYour todo list is empty. Create todos to plan your work.\n</system-reminder>';
    }

    const lines = [
      '<system-reminder>',
      '## RESUMING SESSION - Existing Todo List',
      '',
      '⚠️ IMPORTANT: These todos were persisted from a previous session.',
      '⚠️ DO NOT recreate or replace this list. CONTINUE working on the next pending task.',
      '',
    ];

    for (let i = 0; i < this.todos.length; i++) {
      const todo = this.todos[i];
      if (!todo?.visible) continue;
      const indent = '  '.repeat(todo.depth);
      lines.push(`${i + 1}. [${todo.status}]${indent} ${todo.content}`);
    }

    // Add ordering warnings
    const warnings = this.getOrderingWarnings();
    if (warnings.length > 0) {
      lines.push('');
      lines.push('🚨 ORDERING VIOLATION DETECTED 🚨');
      for (const warning of warnings) {
        lines.push(`⚠️ ${warning}`);
      }
      lines.push('FIX THIS: Complete earlier pending todos before continuing.');
    }

    // Add prominent next-todo guidance
    const next = this.getNextActionable();
    if (next) {
      lines.push('');
      lines.push(`>>> NEXT TODO (index ${next.index}): ${next.todo.content}`);
      lines.push('>>> You MUST work on this task NOW. Do NOT skip to later todos.');
    }

    lines.push('');
    lines.push('STRICT RULE: Complete todos IN ORDER from top to bottom. Never skip ahead.');
    lines.push('</system-reminder>');

    return lines.join('\n');
  }

  /**
   * Clear all todos (for sub-agent isolation).
   */
  clear(): void {
    this.todos = [];
  }
}
