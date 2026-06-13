/**
 * Pure decision function for ComfyUI WebSocket messages.
 *
 * Extracted from `ComfyUIClient.queueAndWaitWS`'s inline `ws.on('message')`
 * handler so the routing — especially the foreign-prompt filtering —
 * can be unit-tested without standing up a real WebSocket. The handler
 * stays responsible for side effects (callbacks, finish(), debug
 * logging); this function decides which side effect to fire.
 *
 * Foreign-prompt filtering matters because ComfyUI Cloud broadcasts
 * `executed`, `execution_success`, and `execution_error` events to
 * every subscriber on the shared client websocket. Without the
 * filter, a stranger's job blowing up resolves OUR in-flight prompt
 * as `status: error` (the BurgerEating "ServiceError lora_name not in
 * list" incident, 2026-05-03), and a stranger's `executed` payload
 * pollutes our outputs (the "Noir potter" incident, 2026-04-22).
 */

export interface ComfyWsMessage {
  type?: string;
  data?: {
    prompt_id?: string;
    node?: string | number;
    output?: {
      images?: Array<{ filename?: string; subfolder?: string; type?: string }>;
      gifs?: Array<{ filename?: string; subfolder?: string; type?: string }>;
      videos?: Array<{ filename?: string; subfolder?: string; type?: string }>;
      audio?: Array<{ filename?: string; subfolder?: string; type?: string }>;
    };
    value?: number;
    max?: number;
    status?: { exec_info?: { queue_remaining?: number } };
    exception_message?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface CapturedOutputItem {
  filename: string;
  subfolder: string;
  type: string;
  node_id: string | number | undefined;
}

export type WsAction =
  | { kind: 'ignore' }
  | { kind: 'ignore_foreign_output'; eventPromptId: string }
  | { kind: 'ignore_foreign_success'; eventPromptId: string }
  | { kind: 'ignore_foreign_error'; eventPromptId: string }
  | { kind: 'progress'; percentage: number; message: string; step?: number; maxSteps?: number }
  | { kind: 'executing'; node: string | number }
  | { kind: 'queued'; remaining: number }
  | { kind: 'capture_output'; items: CapturedOutputItem[] }
  | { kind: 'finish_completed' }
  | { kind: 'finish_error'; payload: ComfyWsMessage['data'] };

function isForeignPrompt(eventPromptId: string | undefined, ourPromptId: string): boolean {
  // Only "foreign" if the cloud explicitly tagged the event with a
  // prompt_id that doesn't match ours. Missing prompt_id is treated as
  // ours (fail-closed) so cloud rejections without an id still surface.
  return !!ourPromptId && !!eventPromptId && eventPromptId !== ourPromptId;
}

export function decideWsAction(msg: ComfyWsMessage, ourPromptId: string): WsAction {
  const msgType = msg.type;
  const data = msg.data ?? {};
  const eventPromptId =
    typeof data.prompt_id === 'string' ? data.prompt_id : undefined;

  if (msgType === 'progress' && typeof data.value === 'number' && typeof data.max === 'number') {
    const pct = data.max > 0 ? Math.round((data.value / data.max) * 100) : 0;
    return {
      kind: 'progress',
      percentage: pct,
      message: `Step ${data.value}/${data.max}`,
      step: data.value,
      maxSteps: data.max,
    };
  }

  if (msgType === 'executing' && data.node !== undefined && data.node !== null) {
    return { kind: 'executing', node: data.node };
  }

  if (msgType === 'executed' && data.output) {
    if (isForeignPrompt(eventPromptId, ourPromptId)) {
      return { kind: 'ignore_foreign_output', eventPromptId: eventPromptId! };
    }
    const items: CapturedOutputItem[] = [];
    // 'audio' covers SaveAudio / VibeVoice-style TTS nodes — without it,
    // an audio-only workflow surfaces zero outputs over the WS path.
    for (const key of ['images', 'gifs', 'videos', 'audio'] as const) {
      const list = data.output[key];
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item.filename) {
            items.push({
              filename: item.filename,
              subfolder: item.subfolder ?? '',
              type: item.type ?? 'output',
              node_id: data.node,
            });
          }
        }
      }
    }
    return { kind: 'capture_output', items };
  }

  if (msgType === 'execution_success') {
    if (isForeignPrompt(eventPromptId, ourPromptId)) {
      return { kind: 'ignore_foreign_success', eventPromptId: eventPromptId! };
    }
    return { kind: 'finish_completed' };
  }

  if (msgType === 'execution_error') {
    if (isForeignPrompt(eventPromptId, ourPromptId)) {
      return { kind: 'ignore_foreign_error', eventPromptId: eventPromptId! };
    }
    return { kind: 'finish_error', payload: data };
  }

  if (msgType === 'status') {
    const qr = data.status?.exec_info?.queue_remaining;
    if (typeof qr === 'number' && qr > 0) {
      return { kind: 'queued', remaining: qr };
    }
  }

  return { kind: 'ignore' };
}
