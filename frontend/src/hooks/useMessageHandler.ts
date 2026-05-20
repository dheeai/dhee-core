/**
 * Maps incoming WebSocket messages to store actions.
 * This replaces the monolithic handleServerMessage() from the inline SPA.
 */

import { useCallback } from 'react'
import type { ServerMessage } from './useWebSocket'
import type { AppAction } from '../lib/store'

let toolCounter = 0

export function useMessageHandler(dispatch: React.Dispatch<AppAction>) {
  return useCallback((msg: ServerMessage) => {
    const { type, data } = msg

    switch (type) {
      case 'status': {
        const status = data.status as string
        const projectName = data.projectName as string | undefined

        if (projectName) {
          dispatch({ type: 'SELECT_PROJECT', name: projectName })
        }

        if (status === 'ready' || status === 'completed') {
          dispatch({ type: 'SET_AGENT_STATUS', status: 'idle' })
        } else if (status === 'busy') {
          dispatch({ type: 'SET_AGENT_STATUS', status: 'thinking' })
        } else if (status === 'paused') {
          // `/run-to <stage>` gate fired — executor stopped cleanly at the
          // stage boundary. Agent is idle (input re-enabled) and we show
          // the user which stage we paused at so they know what to inspect
          // and how to resume.
          dispatch({ type: 'SET_AGENT_STATUS', status: 'idle' })
          const stage = data.pausedAtStage as string | undefined
          const body = stage
            ? `Paused at **${stage}**. Inspect the outputs, then send \`/run-to <next-stage>\` to continue.`
            : 'Paused. Send any message to continue.'
          dispatch({
            type: 'ADD_CHAT_MESSAGE',
            message: {
              id: `paused_${Date.now()}`,
              type: 'system',
              content: body,
              timestamp: Date.now(),
            },
          })
        }
        // Phase update
        if (data.phase) {
          dispatch({ type: 'SET_PHASE', phase: data.phase as string })
        }
        break
      }

      case 'tool_call': {
        const toolName = data.toolName as string
        const toolCallId = data.toolCallId as string
        const status = data.status as string
        const args = data.arguments as Record<string, unknown> | undefined
        const result = data.result
        const agentName = data.agentName as string | undefined

        if (status === 'started' || (!status && !result)) {
          toolCounter++
          const id = toolCallId || `tool_${toolCounter}`
          dispatch({
            type: 'ADD_TOOL_CALL',
            toolCall: {
              id,
              toolName,
              args: args as Record<string, string> | undefined,
              status: 'executing',
              startTime: Date.now(),
              agentName,
            },
          })
        } else if (status === 'completed' || status === 'error') {
          dispatch({
            type: 'UPDATE_TOOL_CALL',
            id: toolCallId || toolName,
            updates: {
              status: status === 'error' ? 'error' : 'completed',
              result,
              duration: Date.now(),
            },
          })
          // Auto-add completed image assets to sidebar
          if (status === 'completed' && result && typeof result === 'object') {
            const r = result as Record<string, unknown>
            const filePath = r['file_path'] as string | undefined
            if (filePath?.match(/\.(png|jpg|jpeg|webp)$/i)) {
              // Extract shot metadata from toolCallId + result for storyboard grouping.
              // toolCallId patterns (backend, ExecutorAgent.ts):
              //   frame_scene_1_shot_3_last_frame_1733...    (multi-frame shot additional frame)
              //   shotimg_shot_image:scene_1_shot_3_1733...   (first frame via executeShotImageGeneration)
              const resultFrame = (r['frame'] as string | undefined) ?? undefined
              const idForParse = toolCallId ?? ''
              const scenePart = idForParse.match(/scene_(\d+)_shot_(\d+)/)
              let nodeId: string | undefined
              let frame: 'first_frame' | 'last_frame' | 'mid_frame' | 'single' | undefined
              if (scenePart) {
                nodeId = `shot_image:scene_${scenePart[1]}_shot_${scenePart[2]}`
                // Prefer explicit result.frame; else infer from toolCallId
                if (resultFrame === 'first_frame' || resultFrame === 'last_frame' || resultFrame === 'mid_frame') {
                  frame = resultFrame
                } else if (idForParse.includes('_last_frame_')) {
                  frame = 'last_frame'
                } else if (idForParse.includes('_first_frame_')) {
                  frame = 'first_frame'
                } else if (idForParse.includes('_mid_frame_')) {
                  frame = 'mid_frame'
                } else {
                  frame = 'single'
                }
              }
              dispatch({
                type: 'ADD_ASSET',
                asset: {
                  id: `asset_${Date.now()}_${toolCounter}`,
                  path: filePath,
                  url: filePath,
                  type: 'image',
                  ...(nodeId ? { nodeId } : {}),
                  ...(frame ? { frame } : {}),
                },
              })
            }
          }
        }
        break
      }

      case 'stream_chunk': {
        const toolCallId = data.toolCallId as string | undefined
        const chunk = data.content as string
        const done = data.done as boolean
        const agentName = data.agentName as string | undefined
        const reset = data.reset as boolean | undefined

        if (toolCallId) {
          // Tool streaming — append to tool card
          dispatch({
            type: 'APPEND_TOOL_STREAMING',
            id: toolCallId,
            chunk: chunk || '',
            reset,
          })
        } else {
          // Agent text streaming
          if (done) {
            // Finalize: move streaming text to a chat message
            dispatch({
              type: 'ADD_CHAT_MESSAGE',
              message: {
                id: `msg_${Date.now()}`,
                type: 'agent',
                content: chunk || '',
                timestamp: Date.now(),
                agentName,
              },
            })
            dispatch({ type: 'SET_STREAMING_TEXT', text: null })
          } else {
            dispatch({ type: 'APPEND_STREAMING_TEXT', chunk: chunk || '' })
          }
        }
        break
      }

      case 'todo_update': {
        const todos = (data.todos as Array<{
          content?: string
          text?: string
          task?: string
          status: string
          id?: string
          category?: string
        }>) || []
        dispatch({
          type: 'SET_TODOS',
          todos: todos.map((t, i) => ({
            id: t.id || `todo_${i}`,
            text: t.task || t.content || t.text || '',
            status: (t.status === 'cancelled' ? 'failed' : t.status) as 'pending' | 'in_progress' | 'completed' | 'failed',
            category: t.category,
          })),
        })
        // Backend sends a parallel `nodes` array alongside `todos` with
        // typeId + itemId + outputPath(s) per node. Feed it into the
        // store so the Storyboard stays live as shots complete —
        // without it, we'd only update on a full project reload.
        const nodeInfos = (data.nodes as Array<{
          id: string
          typeId: string
          itemId?: string
          status: string
          outputPath?: string
          outputPaths?: Record<string, string>
        }> | undefined) ?? []
        for (const n of nodeInfos) {
          if (!n.id || !n.typeId) continue
          dispatch({
            type: 'UPDATE_NODE',
            node: {
              id: n.id,
              typeId: n.typeId,
              itemId: n.itemId,
              status: (n.status === 'cancelled' ? 'failed' : n.status) as 'pending' | 'in_progress' | 'completed' | 'failed',
              outputPath: n.outputPath,
              outputPaths: n.outputPaths,
            },
          })
        }
        break
      }

      case 'phase_transition': {
        dispatch({ type: 'SET_PHASE', phase: data.toPhase as string })
        break
      }

      case 'context_usage': {
        dispatch({
          type: 'SET_CONTEXT_USAGE',
          usage: {
            percentage: data.percentage as number,
            promptTokens: data.promptTokens as number,
            maxTokens: data.maxTokens as number,
          },
        })
        break
      }

      case 'notification': {
        // For now, add as a system chat message
        dispatch({
          type: 'ADD_CHAT_MESSAGE',
          message: {
            id: `notif_${Date.now()}`,
            type: 'system',
            content: data.message as string,
            timestamp: Date.now(),
          },
        })
        break
      }

      case 'agent_response': {
        dispatch({ type: 'SET_AGENT_STATUS', status: 'idle' })
        break
      }

      case 'timeline_update': {
        dispatch({ type: 'SET_TIMELINE', timeline: data.timeline as import('../lib/timeline-types').Timeline })
        break
      }

      case 'session_timer': {
        dispatch({
          type: 'SET_TIMER',
          timer: {
            elapsedMs: (data.elapsedMs as number) ?? 0,
            running: (data.running as boolean) ?? false,
            completed: (data.completed as boolean) ?? false,
          },
        })
        break
      }

      case 'media_generated': {
        // Long-running tool surfaced a newly-generated asset. Render as a
        // standalone media chat message — separate from the (collapsed)
        // tool card, so the user sees progress as it happens.
        const project = data.project as string | undefined
        const path = data.path as string | undefined
        const kind = data.kind as 'image' | 'video' | undefined
        const source = data.source as string | undefined
        if (project && path && kind) {
          dispatch({
            type: 'ADD_CHAT_MESSAGE',
            message: {
              id: `media_${Date.now()}_${path}`,
              type: 'media',
              content: path,
              timestamp: Date.now(),
              media: { kind, path, project, ...(source ? { source } : {}) },
            },
          })
        }
        break
      }

      case 'history': {
        // Resume snapshot from a session reconstructed off disk. Hydrate
        // chat + tool-call state so the panel looks like the user never
        // closed the app. Server already filtered out internal plumbing
        // messages ([SYSTEM EVENT], "(Active project: …)" prefixes).
        const messages = (data.messages as Array<{
          id: string
          type: 'agent' | 'user' | 'system' | 'media'
          content: string
          timestamp: number
          agentName?: string
          media?: { kind: 'image' | 'video'; path: string; project: string; source?: string }
        }>) || []
        const toolCalls = (data.toolCalls as Array<{
          id: string
          toolName: string
          args?: Record<string, string>
          status: 'executing' | 'completed' | 'error'
          result?: unknown
          startTime: number
          duration?: number
          agentName?: string
        }>) || []
        const focusedProject = data.focusedProject as string | undefined
        if (focusedProject) {
          dispatch({ type: 'SELECT_PROJECT', name: focusedProject })
        }
        dispatch({
          type: 'SET_HISTORY',
          messages,
          toolCalls,
        })
        break
      }

      case 'history_cleared': {
        // Server purged the persisted JSONL and minted a fresh sessionId.
        // Wipe local chat state so the UI matches.
        dispatch({ type: 'CLEAR_CHAT' })
        break
      }

      case 'assets_refresh': {
        // Server sent a fresh asset list — typically after a reset clears
        // some outputs. Replace the in-memory list entirely so stale
        // storyboard frames/videos disappear.
        const projectName = data.projectName as string | undefined
        const incoming = (data.assets as Array<{ id: string; path: string; type: string; nodeId?: string; frame?: string }>) || []
        const assets = incoming.map(a => ({
          ...a,
          frame: a.frame as 'first_frame' | 'last_frame' | 'mid_frame' | 'single' | undefined,
          url: projectName ? `/api/v1/assets/${projectName}/${a.path}` : a.path,
        }))
        dispatch({ type: 'SET_ASSETS', assets })
        break
      }
    }
  }, [dispatch])
}
