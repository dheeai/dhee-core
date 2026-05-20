import { useState, useRef, useCallback, useEffect } from 'react'
import { useAppState } from '../lib/store'

interface TaskInputProps {
  onSend: (task: string) => void
  placeholder?: string
}

const COMMANDS = [
  { name: '/help', description: 'Show available commands' },
  { name: '/project', description: 'Pick a project from a list' },
  { name: '/new', description: 'Create a new project' },
  { name: '/workflows', description: 'Open workflow manager' },
  { name: '/providers', description: 'Open provider settings' },
  { name: '/reset', description: 'Reset project to a stage' },
  { name: '/run-to', description: 'Run pipeline up to a stage, then pause' },
  { name: '/auto', description: 'Enable autonomous mode' },
  { name: '/parallel', description: 'Enable parallel media gen' },
  { name: '/serial', description: 'Switch to serial media gen' },
]

interface ProjectPickerEntry {
  name: string
  description: string
}

const RESET_STAGES = [
  { name: 'plot', description: 'Reset everything, start from scratch' },
  { name: 'story', description: 'Keep plot, redo story onwards' },
  { name: 'characters', description: 'Keep plot+story, redo characters/settings/scenes onwards' },
  { name: 'scene', description: 'Keep characters/settings, redo scenes onwards' },
  { name: 'world_style', description: 'Redo visual style guide and all images onwards' },
  { name: 'character_image', description: 'Keep writing, redo all image generation onwards' },
  { name: 'scene_video_prompt', description: 'Redo shot planning, images, and videos' },
  { name: 'shot_image_prompt', description: 'Redo shot image prompts, images, and videos' },
  { name: 'shot_motion_directive', description: 'Redo motion directives and videos' },
  { name: 'shot_image', description: 'Redo shot images and videos' },
  { name: 'shot_video', description: 'Keep images, redo video generation + assembly' },
  { name: 'final_video', description: 'Redo final assembly only' },
]

export function TaskInput({ onSend, placeholder: customPlaceholder }: TaskInputProps) {
  const { agentStatus, connectionStatus } = useAppState()
  const [value, setValue] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const suggestionsRef = useRef<HTMLDivElement>(null)

  const isDisabled = connectionStatus !== 'connected' || agentStatus === 'thinking'

  // Filter commands or stage suggestions based on input.
  // Both /reset and /run-to share the same stage vocabulary, so we drive
  // their autocomplete from the same RESET_STAGES list.
  const resetMatch = value.match(/^\/reset\s+(\S*)$/i)
  const runToMatch = value.match(/^\/run-to\s+(\S*)$/i)
  const projectMatch = value.match(/^\/project(?:\s+(.*))?$/i) ||
    value.match(/^\/select(?:\s+(.*))?$/i)
  const isStagePickerMode = !!resetMatch || !!runToMatch
  const isProjectPickerMode = !!projectMatch && value.includes(' ')
  const stagePickerCommand: '/reset' | '/run-to' | null = resetMatch
    ? '/reset'
    : runToMatch
      ? '/run-to'
      : null
  const projectPickerCommand: '/project' | '/select' | null = isProjectPickerMode
    ? (value.startsWith('/project') ? '/project' : '/select')
    : null
  const stageFilter = (resetMatch?.[1] ?? runToMatch?.[1] ?? '').toLowerCase()
  const projectFilter = (projectMatch?.[1] ?? '').toLowerCase()

  // Lazy-fetch project list when entering /project picker mode.
  const [projects, setProjects] = useState<ProjectPickerEntry[]>([])
  useEffect(() => {
    if (!isProjectPickerMode || projects.length > 0) return
    let cancelled = false
    void fetch('/api/v1/projects')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.projects) return
        type ApiProject = { dirName: string; title?: string; currentPhase?: string }
        setProjects(
          (data.projects as ApiProject[]).map((p) => ({
            name: p.dirName.replace(/\.dhee$/, ''),
            description: [p.title, p.currentPhase].filter(Boolean).join(' · '),
          })),
        )
      })
      .catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [isProjectPickerMode, projects.length])

  const suggestions = isStagePickerMode
    ? RESET_STAGES
        .filter(s => s.name.startsWith(stageFilter))
        .map(s => ({ name: s.name, description: s.description }))
    : isProjectPickerMode
      ? projects.filter(p => p.name.toLowerCase().includes(projectFilter))
      : value.startsWith('/')
        ? COMMANDS.filter(c => c.name.startsWith(value.toLowerCase()))
        : []

  // Show/hide suggestions
  useEffect(() => {
    if (isStagePickerMode || isProjectPickerMode) {
      setShowSuggestions(suggestions.length > 0)
    } else {
      setShowSuggestions(value.startsWith('/') && suggestions.length > 0 && value !== suggestions[0]?.name)
    }
    setSelectedIndex(0)
  }, [value, suggestions.length, isStagePickerMode, isProjectPickerMode])

  const handleSubmit = useCallback(() => {
    if (!value.trim() || isDisabled) return
    onSend(value)
    setValue('')
    setShowSuggestions(false)
    inputRef.current?.focus()
  }, [value, isDisabled, onSend])

  const applySuggestion = useCallback((cmd: string) => {
    if (isStagePickerMode && stagePickerCommand) {
      setValue(`${stagePickerCommand} ${cmd}`)
      setShowSuggestions(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    } else if (isProjectPickerMode && projectPickerCommand) {
      // Auto-submit on project pick: send the command immediately.
      const filled = `${projectPickerCommand} ${cmd}`
      setShowSuggestions(false)
      onSend(filled)
      setValue('')
      inputRef.current?.focus()
    } else {
      setValue(cmd + ' ')
      setShowSuggestions(false)
      inputRef.current?.focus()
    }
  }, [isStagePickerMode, stagePickerCommand, isProjectPickerMode, projectPickerCommand, onSend])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (showSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(i => Math.min(i + 1, suggestions.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(i => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && suggestions.length > 0)) {
        e.preventDefault()
        const selected = suggestions[selectedIndex]
        if (selected) applySuggestion(selected.name)
        return
      }
      if (e.key === 'Escape') {
        setShowSuggestions(false)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }, [handleSubmit, showSuggestions, suggestions, selectedIndex, applySuggestion])

  return (
    <div className="border-t border-line-soft px-4 py-3 bg-graphite-400/30 relative">
      {/* Command autocomplete */}
      {showSuggestions && (
        <div
          ref={suggestionsRef}
          className="absolute bottom-full left-4 right-4 mb-1 glass-panel-strong py-1 z-50"
        >
          {suggestions.map((cmd, i) => (
            <button
              key={cmd.name}
              onClick={() => applySuggestion(cmd.name)}
              className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-colors cursor-pointer ${
                i === selectedIndex ? 'bg-cyan/10' : 'hover:bg-surface'
              }`}
            >
              <span className="font-mono text-sm text-cyan min-w-20">{cmd.name}</span>
              <span className="text-xs text-graphite-100">{cmd.description}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isDisabled ? 'Waiting...' : (customPlaceholder || 'Type a task or / for commands...')}
          disabled={isDisabled}
          className="flex-1 bg-graphite-300 border border-line-soft rounded-lg px-4 py-2.5 text-sm text-foreground placeholder:text-graphite-200 focus:outline-none focus:border-cyan/40 transition-colors disabled:opacity-50"
        />
        <button
          onClick={handleSubmit}
          disabled={isDisabled || !value.trim()}
          className="px-5 py-2.5 rounded-lg bg-cyan text-background font-mono text-sm font-semibold hover:bg-cyan/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          Send
        </button>
      </div>
    </div>
  )
}
