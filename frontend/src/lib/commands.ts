/**
 * Command router — parses /commands from the task input
 * and routes them to the right action.
 *
 * Commands are client-side shortcuts, not sent to the server as tasks.
 * Regular text (no / prefix) is sent as a task via WebSocket.
 */

export interface CommandContext {
  dispatch: React.Dispatch<any>
  send: (msg: Record<string, unknown>) => void
  setShowWorkflows: (v: boolean) => void
  setShowProviders: (v: boolean) => void
  setShowNewProject: (v: boolean) => void
  selectedProject?: string | null
}

interface CommandDef {
  description: string
  usage: string
  handler: (args: string, ctx: CommandContext) => void | Promise<void>
}

/**
 * Canonical stage vocabulary. Mirrors the backend's `VALID_STAGES` in
 * `src/core/planner/stages.ts`. Kept in sync manually — the frontend
 * can't import from the `src/` build root due to separate tsconfigs.
 * Consumed by `/reset` and `/run-to` for validation + autocomplete.
 */
const STAGES: readonly string[] = [
  'plot',
  'story',
  'story_essence',
  'characters',
  'character',
  'setting',
  'scene',
  'world_style',
  'character_image',
  'reference_images',
  'setting_image',
  'scene_shot_plan',
  'shot_breakdown',
  'scene_video_prompt',
  'shot_image_prompt',
  'shot_motion_directive',
  'shot_image',
  'shot_video',
  'final_video',
]

const COMMANDS: Record<string, CommandDef> = {
  help: {
    description: 'Show available commands',
    usage: '/help',
    handler: (_args, ctx) => {
      const lines = Object.entries(COMMANDS)
        .map(([name, cmd]) => `**/${name}** — ${cmd.description}\n  Usage: \`${cmd.usage}\``)
        .join('\n\n')
      ctx.dispatch({
        type: 'ADD_CHAT_MESSAGE',
        message: {
          id: `cmd_${Date.now()}`,
          type: 'system',
          content: `## Available Commands\n\n${lines}`,
          timestamp: Date.now(),
        },
      })
    },
  },

  new: {
    description: 'Create a new project',
    usage: '/new',
    handler: (_args, ctx) => {
      ctx.setShowNewProject(true)
    },
  },

  workflows: {
    description: 'Open workflow manager',
    usage: '/workflows',
    handler: (_args, ctx) => {
      ctx.setShowWorkflows(true)
    },
  },

  providers: {
    description: 'Open provider settings',
    usage: '/providers',
    handler: (_args, ctx) => {
      ctx.setShowProviders(true)
    },
  },

  reset: {
    description: 'Reset a project to a specific stage',
    usage: '/reset [project] <stage>',
    handler: (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const stages = STAGES

      if (parts.length === 0) {
        ctx.dispatch({
          type: 'ADD_CHAT_MESSAGE',
          message: {
            id: `cmd_${Date.now()}`,
            type: 'system',
            content: `Usage: \`/reset [project] <stage>\`\n\nStages: ${stages.join(', ')}${ctx.selectedProject ? `\n\nCurrent project: **${ctx.selectedProject}** (will be used if project name omitted)` : ''}`,
            timestamp: Date.now(),
          },
        })
        return
      }

      // If only one arg and it looks like a stage, use the selected project
      let projectName: string
      let stage: string
      if (parts.length === 1 && stages.includes(parts[0])) {
        if (!ctx.selectedProject) {
          ctx.dispatch({
            type: 'ADD_CHAT_MESSAGE',
            message: {
              id: `cmd_${Date.now()}`,
              type: 'system',
              content: 'No project selected. Use `/reset <project> <stage>` or select a project first.',
              timestamp: Date.now(),
            },
          })
          return
        }
        projectName = ctx.selectedProject
        stage = parts[0]!
      } else if (parts.length >= 2) {
        projectName = parts[0]!
        stage = parts[1]!
      } else {
        ctx.dispatch({
          type: 'ADD_CHAT_MESSAGE',
          message: {
            id: `cmd_${Date.now()}`,
            type: 'system',
            content: `Unknown stage: **${parts[0]}**\n\nValid stages: ${stages.join(', ')}`,
            timestamp: Date.now(),
          },
        })
        return
      }

      ctx.dispatch({
        type: 'ADD_CHAT_MESSAGE',
        message: {
          id: `cmd_${Date.now()}`,
          type: 'system',
          content: `Resetting **${projectName}** to stage **${stage}**...`,
          timestamp: Date.now(),
        },
      })
      // Send as dedicated reset message — runs the reset script server-side
      ctx.send({ type: 'reset_project', data: { projectName, stage } })
    },
  },

  'run-to': {
    description: 'Run the pipeline up to a stage and pause for inspection',
    usage: '/run-to <stage>',
    handler: (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean)

      // Empty — show usage. Helps users who typed `/run-to` alone.
      if (parts.length === 0) {
        ctx.dispatch({
          type: 'ADD_CHAT_MESSAGE',
          message: {
            id: `cmd_${Date.now()}`,
            type: 'system',
            content: `Usage: \`/run-to <stage>\`\n\nValid stages: ${STAGES.join(', ')}`,
            timestamp: Date.now(),
          },
        })
        return
      }

      const stage = parts[0]
      if (!STAGES.includes(stage)) {
        ctx.dispatch({
          type: 'ADD_CHAT_MESSAGE',
          message: {
            id: `cmd_${Date.now()}`,
            type: 'system',
            content: `Unknown stage: **${stage}**\n\nValid stages: ${STAGES.join(', ')}`,
            timestamp: Date.now(),
          },
        })
        return
      }

      ctx.dispatch({
        type: 'ADD_CHAT_MESSAGE',
        message: {
          id: `cmd_${Date.now()}`,
          type: 'system',
          content: `Running pipeline up to **${stage}**, then pausing...`,
          timestamp: Date.now(),
        },
      })
      // Reuse `start_task` surface — server-side WebSocketHandler
      // threads `stopAtStage` through to the executor's stage gate.
      ctx.send({
        type: 'start_task',
        data: { task: `Run pipeline up to ${stage}`, stopAtStage: stage },
      })
    },
  },

  project: {
    description: 'Select a project (with picker)',
    usage: '/project [project-name]',
    handler: async (args, ctx) => {
      const name = args.trim()
      if (!name) {
        ctx.dispatch({
          type: 'ADD_CHAT_MESSAGE',
          message: {
            id: `cmd_${Date.now()}`,
            type: 'system',
            content: 'Type `/project ` and start typing a name — a picker will appear. Or use the dropdown in the header.',
            timestamp: Date.now(),
          },
        })
        return
      }
      const { selectProjectByName } = await import('./selectProjectAction.js')
      const r = await selectProjectByName(name, ctx.dispatch, ctx.send)
      ctx.dispatch({
        type: 'ADD_CHAT_MESSAGE',
        message: {
          id: `cmd_${Date.now()}`,
          type: 'system',
          content: r.ok
            ? `Project **${name.replace(/\.dhee$/, '')}** loaded.`
            : (r.reason || 'Failed to select project'),
          timestamp: Date.now(),
        },
      })
    },
  },

  select: {
    description: 'Alias for /project',
    usage: '/select [project-name]',
    handler: async (args, ctx) => {
      await COMMANDS.project.handler(args, ctx)
    },
  },

  auto: {
    description: 'Toggle autonomous mode',
    usage: '/auto',
    handler: (_args, ctx) => {
      ctx.send({ type: 'set_autonomous', data: { enabled: true } })
      ctx.dispatch({ type: 'SET_AUTONOMOUS', enabled: true })
      ctx.dispatch({
        type: 'ADD_CHAT_MESSAGE',
        message: {
          id: `cmd_${Date.now()}`,
          type: 'system',
          content: 'Autonomous mode **enabled** — will run without confirmations.',
          timestamp: Date.now(),
        },
      })
    },
  },

  parallel: {
    description: 'Toggle parallel media generation',
    usage: '/parallel',
    handler: (_args, ctx) => {
      ctx.send({ type: 'set_parallel_media', data: { enabled: true } })
      ctx.dispatch({ type: 'SET_PARALLEL_MEDIA', enabled: true })
      ctx.dispatch({
        type: 'ADD_CHAT_MESSAGE',
        message: {
          id: `cmd_${Date.now()}`,
          type: 'system',
          content: 'Parallel media generation **enabled** — for remote ComfyUI servers.',
          timestamp: Date.now(),
        },
      })
    },
  },

  serial: {
    description: 'Switch to serial media generation',
    usage: '/serial',
    handler: (_args, ctx) => {
      ctx.send({ type: 'set_parallel_media', data: { enabled: false } })
      ctx.dispatch({ type: 'SET_PARALLEL_MEDIA', enabled: false })
      ctx.dispatch({
        type: 'ADD_CHAT_MESSAGE',
        message: {
          id: `cmd_${Date.now()}`,
          type: 'system',
          content: 'Serial media generation **enabled** — for local ComfyUI.',
          timestamp: Date.now(),
        },
      })
    },
  },
}

/**
 * Try to parse and execute a command from the input text.
 * Returns true if it was a command (handled), false if regular text.
 */
export function tryExecuteCommand(input: string, ctx: CommandContext): boolean {
  if (!input.startsWith('/')) return false

  // Allow hyphens in command names (e.g. `/run-to`). `\w` alone doesn't.
  const match = input.match(/^\/([\w-]+)\s*(.*)$/)
  if (!match) return false

  const [, name, args] = match
  const cmd = COMMANDS[name]

  if (!cmd) {
    ctx.dispatch({
      type: 'ADD_CHAT_MESSAGE',
      message: {
        id: `cmd_${Date.now()}`,
        type: 'system',
        content: `Unknown command: \`/${name}\`. Type \`/help\` for available commands.`,
        timestamp: Date.now(),
      },
    })
    return true
  }

  cmd.handler(args || '', ctx)
  return true
}
