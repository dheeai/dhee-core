import { useReducer, useState, useCallback, useRef, useEffect } from 'react'
import { AppStateContext, AppDispatchContext, appReducer, initialState } from './lib/store'
import { useWebSocket } from './hooks/useWebSocket'
import { useMessageHandler } from './hooks/useMessageHandler'
import { Header } from './components/Header'
import { Sidebar } from './components/Sidebar'
import { Storyboard } from './components/Storyboard'
import { ChatTimeline } from './components/ChatTimeline'
import { TimelineView } from './components/TimelineView'
import { TaskInput, type CharacterReferenceAttachment } from './components/TaskInput'
import { WorkflowManager } from './components/WorkflowManager'
import { ProviderSettings } from './components/ProviderSettings'
import { ProjectSelector } from './components/ProjectSelector'
import { ErrorBoundary } from './components/ErrorBoundary'
import { NewProjectInline, type NewProjectState } from './components/NewProjectInline'
import { tryExecuteCommand } from './lib/commands'
import { PromptEditModal } from './components/PromptEditModal'

export function App() {
  const [state, dispatch] = useReducer(appReducer, initialState)
  const [showProviders, setShowProviders] = useState(false)
  const [showWorkflows, setShowWorkflows] = useState(false)
  const [showNewProject, setShowNewProject] = useState(false)
  const [projectListRefreshToken, setProjectListRefreshToken] = useState(0)
  const [queuedNewProjectOpen, setQueuedNewProjectOpen] = useState(false)

  // When wizard completes (template/style/duration selected),
  // store the config and wait for user to type description in chat input
  const [pendingProject, setPendingProject] = useState<NewProjectState | null>(null)
  const [pendingAutoTask, setPendingAutoTask] = useState<string | null>(null)
  // Chat-level edit-prompt modal (opened from MediaWithOverlay on any chat
  // image/video). Mirrors the Storyboard's prompt-edit flow.
  const [chatEditNodeId, setChatEditNodeId] = useState<string | null>(null)
  const [chatEditFrame, setChatEditFrame] = useState<string | null>(null)

  // Stable refs for WebSocket callbacks
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch
  const handleMessage = useMessageHandler(dispatch)
  const handleMessageRef = useRef(handleMessage)
  handleMessageRef.current = handleMessage

  const stableOnMessage = useCallback((msg: any) => handleMessageRef.current(msg), [])
  const stableOnConnect = useCallback((sessionId: string) => {
    dispatchRef.current({ type: 'SET_CONNECTION', status: 'connected', sessionId })
  }, [])
  const stableOnDisconnect = useCallback(() => {
    dispatchRef.current({ type: 'SET_CONNECTION', status: 'disconnected' })
  }, [])

  const { send } = useWebSocket({
    onMessage: stableOnMessage,
    onConnect: stableOnConnect,
    onDisconnect: stableOnDisconnect,
  })

  useEffect(() => {
    if (!queuedNewProjectOpen || state.agentStatus === 'thinking') return
    dispatch({ type: 'ENTER_NEW_PROJECT_FLOW' })
    setShowNewProject(true)
    setQueuedNewProjectOpen(false)
  }, [dispatch, queuedNewProjectOpen, state.agentStatus])

  useEffect(() => {
    if (!pendingAutoTask || !state.selectedProject) return

    setPendingAutoTask(null)
    setProjectListRefreshToken(token => token + 1)
    send({ type: 'start_task', data: { task: pendingAutoTask } })
    dispatch({ type: 'SET_AGENT_STATUS', status: 'thinking' })
  }, [dispatch, pendingAutoTask, send, state.selectedProject])

  const handleNewProjectRequest = useCallback(() => {
    setPendingProject(null)
    setPendingAutoTask(null)
    setShowNewProject(false)

    if (state.agentStatus === 'thinking') {
      send({ type: 'cancel' })
      setQueuedNewProjectOpen(true)
      return
    }

    dispatch({ type: 'ENTER_NEW_PROJECT_FLOW' })
    setShowNewProject(true)
  }, [dispatch, send, state.agentStatus])

  const handleSendTask = useCallback((task: string, characterReferenceImages?: CharacterReferenceAttachment[]) => {
    if (!task.trim()) return

    // If we have a pending project config, this message is the project description
    if (pendingProject) {
      const config = pendingProject
      setPendingProject(null)

      // Show as user message
      dispatch({
        type: 'ADD_CHAT_MESSAGE',
        message: { id: `user_${Date.now()}`, type: 'user', content: task, timestamp: Date.now() },
      })

      // Show config summary
      dispatch({
        type: 'ADD_CHAT_MESSAGE',
        message: {
          id: `proj_${Date.now()}`,
          type: 'system',
          content: `Creating project: **${config.templateId}** · ${config.style} · ${config.duration}s`,
          timestamp: Date.now(),
        },
      })

      // Send create_project to server
      send({
        type: 'create_project',
        data: {
          templateId: config.templateId,
          style: config.style,
          duration: config.duration,
          content: task,
          title: task.substring(0, 60),
          ...(characterReferenceImages?.length ? { characterReferenceImages } : {}),
          resolution: '480p',
          resolutionWidth: 848,
          resolutionHeight: 480,
          autonomousMode: true,
        },
      })

      // Auto-start only after the server reports the new project is ready.
      setPendingAutoTask('Start working on this project. The project has just been created with the user content.')
      return
    }

    // Try command
    const handled = tryExecuteCommand(task, {
      dispatch,
      send,
      setShowWorkflows,
      setShowProviders,
      setShowNewProject,
      selectedProject: state.selectedProject,
    })
    if (handled) return

    // Regular task
    dispatch({
      type: 'ADD_CHAT_MESSAGE',
      message: { id: `user_${Date.now()}`, type: 'user', content: task, timestamp: Date.now() },
    })
    send({ type: 'start_task', data: { task } })
    dispatch({ type: 'SET_AGENT_STATUS', status: 'thinking' })
  }, [send, dispatch, pendingProject, state.selectedProject])

  // Chat input placeholder changes when waiting for project description
  const inputPlaceholder = pendingProject
    ? 'Describe your video project...'
    : undefined

  return (
    <AppStateContext.Provider value={state}>
      <AppDispatchContext.Provider value={dispatch}>
        <ErrorBoundary>
          <div className="app-shell h-screen flex flex-col text-foreground overflow-hidden">
            <div className="aurora aurora--left" />
            <div className="aurora aurora--right" />

            <Header
              onProviderSettings={() => setShowProviders(true)}
              onWorkflows={() => setShowWorkflows(true)}
              onStop={() => send({ type: 'cancel' })}
              onClearChat={() => send({ type: 'clear_chat_history' })}
              projectSelector={<ProjectSelector onSendWs={send} onNewProject={handleNewProjectRequest} refreshToken={projectListRefreshToken} />}
            />

            <div className="flex flex-1 overflow-hidden relative z-10">
              {/* LEFT: Todos only */}
              <Sidebar
                onRedoNode={(nodeId: string) => send({ type: 'redo_node', data: { nodeId } })}
                onRedoNodeWithPrompt={(nodeId: string, editedPrompt: Record<string, unknown>) =>
                  send({ type: 'redo_node', data: { nodeId, editedPrompt } })
                }
              />

              {/* CENTER: Tabs (Chat default, Storyboard, Timeline) + content + task input */}
              <main className="flex-1 flex flex-col overflow-hidden">
                <div className="flex border-b border-line-soft flex-shrink-0">
                  <button
                    onClick={() => dispatch({ type: 'SET_ACTIVE_VIEW', view: 'chat' })}
                    className={`px-4 py-2 text-xs font-medium transition-colors ${
                      state.activeView === 'chat'
                        ? 'text-cyan border-b-2 border-cyan'
                        : 'text-graphite-100 hover:text-foreground'
                    }`}
                  >
                    Chat
                  </button>
                  <button
                    onClick={() => dispatch({ type: 'SET_ACTIVE_VIEW', view: 'storyboard' })}
                    className={`px-4 py-2 text-xs font-medium transition-colors ${
                      state.activeView === 'storyboard'
                        ? 'text-cyan border-b-2 border-cyan'
                        : 'text-graphite-100 hover:text-foreground'
                    }`}
                  >
                    Storyboard
                  </button>
                  <button
                    onClick={() => dispatch({ type: 'SET_ACTIVE_VIEW', view: 'timeline' })}
                    className={`px-4 py-2 text-xs font-medium transition-colors ${
                      state.activeView === 'timeline'
                        ? 'text-cyan border-b-2 border-cyan'
                        : 'text-graphite-100 hover:text-foreground'
                    }`}
                  >
                    Timeline
                    {state.timeline && (
                      <span className="ml-1.5 text-[9px] text-graphite-200">
                        ({state.timeline.segments.filter(s => s.fillStatus === 'filled').length}/{state.timeline.segments.length})
                      </span>
                    )}
                  </button>
                </div>
                {state.activeView === 'chat' && (
                  <ChatTimeline
                    onSendWs={send}
                    onEditPrompt={(nodeId, frame) => {
                      setChatEditNodeId(nodeId)
                      setChatEditFrame(frame)
                    }}
                    onRedoNode={(nodeId) => send({ type: 'redo_node', data: { nodeId } })}
                  />
                )}
                {state.activeView === 'storyboard' && (
                  <Storyboard
                    onRedoNode={(nodeId: string, frame?: string) =>
                      send({ type: 'redo_node', data: frame ? { nodeId, frame } : { nodeId } })
                    }
                    onRedoPrompt={(nodeId: string) =>
                      send({ type: 'redo_node', data: { nodeId, scope: 'prompt' } })
                    }
                    onRedoNodeWithPrompt={(nodeId: string, editedPrompt: Record<string, unknown>) =>
                      send({ type: 'redo_node', data: { nodeId, editedPrompt } })
                    }
                  />
                )}
                {state.activeView === 'timeline' && <TimelineView />}
                {showNewProject && (
                  <NewProjectInline
                    onReady={(config) => {
                      setShowNewProject(false)
                      setPendingProject(config)
                      // Prompt appears in chat input placeholder
                      dispatch({
                        type: 'ADD_CHAT_MESSAGE',
                        message: {
                          id: `wiz_${Date.now()}`,
                          type: 'system',
                          content: 'Now describe your video project in the chat below ↓',
                          timestamp: Date.now(),
                        },
                      })
                    }}
                    onCancel={() => {
                      setShowNewProject(false)
                      dispatch({ type: 'SELECT_PROJECT', name: null })
                    }}
                    onStepChange={(step, value) => {
                      dispatch({
                        type: 'ADD_CHAT_MESSAGE',
                        message: {
                          id: `wiz_${Date.now()}`,
                          type: 'system',
                          content: `Selected ${step}: **${value}**`,
                          timestamp: Date.now(),
                        },
                      })
                    }}
                  />
                )}
                <TaskInput
                  onSend={handleSendTask}
                  placeholder={inputPlaceholder}
                  allowAttachments={!!pendingProject}
                />
              </main>
            </div>

            <WorkflowManager open={showWorkflows} onClose={() => setShowWorkflows(false)} />
            <ProviderSettings open={showProviders} onClose={() => setShowProviders(false)} />
            {chatEditNodeId && state.selectedProject && (
              <PromptEditModal
                nodeId={chatEditNodeId}
                frame={chatEditFrame ?? undefined}
                projectName={state.selectedProject}
                onSubmit={(nid, edited) => {
                  send({ type: 'redo_node', data: { nodeId: nid, editedPrompt: edited } })
                  setChatEditNodeId(null)
                  setChatEditFrame(null)
                }}
                onCancel={() => {
                  setChatEditNodeId(null)
                  setChatEditFrame(null)
                }}
              />
            )}
          </div>
        </ErrorBoundary>
      </AppDispatchContext.Provider>
    </AppStateContext.Provider>
  )
}
