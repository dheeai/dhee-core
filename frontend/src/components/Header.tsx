import { useState, useEffect } from 'react'
import { useAppState } from '../lib/store'

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

interface HeaderProps {
  onProviderSettings: () => void
  onWorkflows: () => void
  onStop?: () => void
  onClearChat?: () => void
  projectSelector?: React.ReactNode
}

export function Header({ onProviderSettings, onWorkflows, onStop, onClearChat, projectSelector }: HeaderProps) {
  const { connectionStatus, selectedProject, phase, contextUsage, autonomousMode, parallelMedia, agentStatus, timer } = useAppState()

  // Live tick when timer is running — re-render every second
  const [runStartedAt] = useState(() => Date.now())
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!timer.running) return
    const interval = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(interval)
  }, [timer.running])

  // When running, add live delta to the server-reported elapsedMs
  const displayMs = timer.running
    ? timer.elapsedMs + (Date.now() - runStartedAt)
    : timer.elapsedMs

  const statusColor = connectionStatus === 'connected'
    ? 'bg-green' : connectionStatus === 'connecting'
    ? 'bg-warning' : 'bg-error'

  return (
    <header className="sticky top-0 z-50 mx-2.5 mt-2.5 mb-3">
      <div className="glass-panel flex items-center justify-between px-4 py-2.5">
        {/* Left: Brand + Project */}
        <div className="flex items-center gap-3">
          <span className="font-[family-name:var(--font-display)] text-xl font-bold text-cyan">
            dhee
          </span>
          {projectSelector || (
            <span className="text-graphite-100 text-sm">
              {selectedProject || 'No project selected'}
            </span>
          )}
        </div>

        {/* Center: Phase */}
        {phase && (
          <div className="hidden md:block">
            <span className="font-mono text-xs uppercase tracking-widest text-graphite-100">
              {phase.replace(/_/g, ' ')}
            </span>
          </div>
        )}

        {/* Right: Status + Actions */}
        <div className="flex items-center gap-2">
          {/* Timer */}
          {(timer.elapsedMs > 0 || timer.running) && (
            <div className="flex items-center gap-1.5">
              {timer.running && (
                <span className="w-2 h-2 rounded-full bg-green animate-pulse" />
              )}
              <span className={`font-mono text-xs ${timer.running ? 'text-cyan' : 'text-graphite-100'}`}>
                {formatElapsed(displayMs)}
              </span>
            </div>
          )}

          {/* Context usage */}
          {contextUsage && (
            <div className="hidden sm:flex items-center gap-1.5">
              <div className="w-16 h-1.5 rounded-full bg-graphite-300 overflow-hidden">
                <div
                  className="h-full rounded-full bg-cyan transition-all duration-300"
                  style={{ width: `${contextUsage.percentage}%` }}
                />
              </div>
              <span className="font-mono text-[10px] text-graphite-100">
                CTX {Math.round(contextUsage.percentage)}%
              </span>
            </div>
          )}

          {/* Mode badges */}
          {autonomousMode && (
            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full border border-cyan/30 text-cyan">
              AUTO
            </span>
          )}
          <span className="font-mono text-[10px] px-2 py-0.5 rounded-full border border-line-soft text-graphite-100">
            {parallelMedia ? '⇉ Parallel' : '▷ Serial'}
          </span>

          {/* Stop button — visible when agent is running */}
          {agentStatus === 'thinking' && onStop && (
            <button
              onClick={onStop}
              className="font-mono text-xs px-3 py-1.5 rounded-md border border-error/50 text-error hover:bg-error/10 hover:border-error transition-colors cursor-pointer"
            >
              Stop
            </button>
          )}

          {/* Action buttons */}
          {onClearChat && (
            <button
              onClick={() => {
                if (typeof window !== 'undefined') {
                  const ok = window.confirm(
                    'Clear chat history? This deletes the saved transcript on disk and starts a new session.',
                  )
                  if (!ok) return
                }
                onClearChat()
              }}
              className="font-mono text-xs px-3 py-1.5 rounded-md border border-line-soft text-graphite-100 hover:text-foreground hover:border-line-strong transition-colors cursor-pointer"
              title="Wipe persisted chat history and start a fresh session"
            >
              New chat
            </button>
          )}
          <button
            onClick={onProviderSettings}
            className="font-mono text-xs px-3 py-1.5 rounded-md border border-line-soft text-graphite-100 hover:text-foreground hover:border-line-strong transition-colors cursor-pointer"
          >
            Providers
          </button>
          <button
            onClick={onWorkflows}
            className="font-mono text-xs px-3 py-1.5 rounded-md border border-line-soft text-graphite-100 hover:text-foreground hover:border-line-strong transition-colors cursor-pointer"
          >
            Workflows
          </button>

          {/* Connection dot */}
          <div className={`w-2.5 h-2.5 rounded-full ${statusColor}`} title={connectionStatus} />
        </div>
      </div>
    </header>
  )
}
