import { useState, useEffect, useCallback, useRef } from 'react'
import { useAppState, useAppDispatch } from '../lib/store'

interface ProjectInfo {
  dirName: string
  title: string
  templateId?: string
  currentPhase?: string
}

interface ProjectSelectorProps {
  onSendWs: (msg: Record<string, unknown>) => void
  onNewProject?: () => void
  refreshToken?: number
}

export function ProjectSelector({ onSendWs, onNewProject, refreshToken = 0 }: ProjectSelectorProps) {
  const { selectedProject, agentStatus } = useAppState()
  const dispatch = useAppDispatch()
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [open, setOpen] = useState(false)
  const [queuedSelection, setQueuedSelection] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/projects')
      if (!res.ok) return
      const data = await res.json()
      const projs = (data.projects || []) as ProjectInfo[]
      setProjects(projs)
      dispatch({ type: 'SET_PROJECTS', projects: projs.map(p => ({ name: p.dirName, phase: p.currentPhase })) })
    } catch {
      // Server not reachable
    }
  }, [dispatch])

  useEffect(() => {
    loadProjects()
  }, [loadProjects, refreshToken])

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const handleSelectNow = useCallback(async (dirName: string) => {
    const projectName = dirName.replace('.dhee', '')
    // Use the shared selectProjectByName so dropdown and /project slash
    // command share one hydration path. selectProjectByName prefers
    // project.scenes (pi-era) over executorState (legacy) over manifest.
    const { selectProjectByName } = await import('../lib/selectProjectAction.js')
    await selectProjectByName(projectName, dispatch as never, onSendWs)
    dispatch({
      type: 'ADD_CHAT_MESSAGE',
      message: {
        id: `sel_${Date.now()}`,
        type: 'system',
        content: `Project **${projectName}** loaded. Type a task to start, or use \`/reset <stage>\` to reset to a specific point.`,
        timestamp: Date.now(),
      },
    })
  }, [dispatch, onSendWs])

  useEffect(() => {
    if (!queuedSelection || agentStatus === 'thinking') return
    handleSelectNow(queuedSelection)
    setQueuedSelection(null)
  }, [agentStatus, handleSelectNow, queuedSelection])

  const handleSelect = (dirName: string) => {
    setOpen(false)
    if (agentStatus === 'thinking') {
      onSendWs({ type: 'cancel' })
      setQueuedSelection(dirName)
      return
    }
    handleSelectNow(dirName)
  }

  const selectedTitle = projects.find(p => p.dirName.replace('.dhee', '') === selectedProject)?.title

  return (
    <>
      <div ref={dropdownRef} className="relative">
        {/* Trigger button */}
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-line-soft bg-graphite-400/50 hover:border-line-strong transition-colors cursor-pointer min-w-40 max-w-56"
        >
          <span className="text-sm truncate text-foreground">
            {selectedTitle || selectedProject || 'Select Project...'}
          </span>
          <svg
            className={`w-3.5 h-3.5 text-graphite-100 transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M3 4.5L6 7.5L9 4.5" />
          </svg>
        </button>

        {/* Dropdown menu */}
        {open && (
          <div className="absolute top-full left-0 mt-1.5 w-72 glass-panel-strong py-1 z-50 max-h-80 overflow-y-auto">
            {/* Project list */}
            {projects.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-graphite-200">
                No projects found
              </div>
            ) : (
              projects.map((p) => {
                const isSelected = p.dirName.replace('.dhee', '') === selectedProject
                return (
                  <button
                    key={p.dirName}
                    onClick={() => handleSelect(p.dirName)}
                    className={`w-full text-left px-3 py-2.5 flex items-center justify-between hover:bg-surface transition-colors cursor-pointer ${
                      isSelected ? 'bg-cyan/5' : ''
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {isSelected && <span className="text-cyan text-xs">●</span>}
                        <span className={`text-sm truncate ${isSelected ? 'text-cyan' : 'text-foreground'}`}>
                          {p.title || p.dirName.replace('.dhee', '')}
                        </span>
                      </div>
                      {p.currentPhase && p.currentPhase !== 'unknown' && (
                        <span className="font-mono text-[10px] text-graphite-100 ml-4">
                          {p.currentPhase.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[10px] text-graphite-200 flex-shrink-0 ml-2">
                      {p.templateId || ''}
                    </span>
                  </button>
                )
              })
            )}

            {/* Divider + New Project */}
            <div className="border-t border-line-soft mt-1 pt-1">
              <button
                onClick={() => {
                  setOpen(false)
                  if (onNewProject) {
                    onNewProject()
                  }
                }}
                className="w-full text-left px-3 py-2.5 flex items-center gap-2 hover:bg-surface transition-colors cursor-pointer text-cyan"
              >
                <span className="text-sm">+</span>
                <span className="text-sm">New Project</span>
              </button>
            </div>
          </div>
        )}
      </div>

    </>
  )
}
