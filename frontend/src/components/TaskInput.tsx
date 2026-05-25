import { useState, useRef, useCallback, useEffect } from 'react'
import { useAppState } from '../lib/store'

export interface CharacterReferenceAttachment {
  name: string
  path: string
  url?: string
  mimeType?: string
  size?: number
}

type AttachmentStatus = 'uploading' | 'uploaded' | 'error'

interface AttachmentItem {
  id: string
  name: string
  mimeType?: string
  size: number
  status: AttachmentStatus
  path?: string
  url?: string
  error?: string
}

interface TaskInputProps {
  onSend: (task: string, attachments?: CharacterReferenceAttachment[]) => void
  placeholder?: string
  allowAttachments?: boolean
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

const ACCEPTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const ACCEPTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

function isAcceptedImageFile(file: File): boolean {
  const dotIndex = file.name.lastIndexOf('.')
  const extension = dotIndex >= 0 ? file.name.slice(dotIndex).toLowerCase() : ''
  const extensionAllowed = ACCEPTED_IMAGE_EXTENSIONS.has(extension)
  const mimeAllowed = !file.type || ACCEPTED_IMAGE_MIME_TYPES.has(file.type)
  return extensionAllowed && mimeAllowed
}

function createAttachmentId(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`
}

export function TaskInput({ onSend, placeholder: customPlaceholder, allowAttachments = false }: TaskInputProps) {
  const { agentStatus, connectionStatus } = useAppState()
  const [value, setValue] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const suggestionsRef = useRef<HTMLDivElement>(null)

  const isDisabled = connectionStatus !== 'connected' || agentStatus === 'thinking'
  const isUploading = attachments.some(a => a.status === 'uploading')

  const uploadFile = useCallback(async (file: File) => {
    if (!isAcceptedImageFile(file)) {
      setUploadError(`${file.name} is not a supported image type.`)
      return
    }

    setUploadError(null)
    const id = createAttachmentId(file)
    const pending: AttachmentItem = {
      id,
      name: file.name,
      mimeType: file.type || undefined,
      size: file.size,
      status: 'uploading',
    }
    setAttachments(prev => [...prev, pending])

    try {
      const res = await fetch(`/api/v1/upload?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `Upload failed (${res.status})`)
      }
      const data = await res.json() as { name?: string; path?: string; url?: string }
      if (!data.path) throw new Error('Upload response missing path')
      setAttachments(prev => prev.map(item => (
        item.id === id
          ? {
              ...item,
              name: data.name || item.name,
              path: data.path,
              url: data.url,
              status: 'uploaded',
            }
          : item
      )))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed'
      setUploadError(`Upload failed: ${file.name}`)
      setAttachments(prev => prev.map(item => (
        item.id === id
          ? { ...item, status: 'error', error: message }
          : item
      )))
    }
  }, [])

  const handleFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files)
    if (list.length === 0) return
    void Promise.all(list.map(uploadFile))
  }, [uploadFile])

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(e.target.files)
    e.target.value = ''
  }, [handleFiles])

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(item => item.id !== id))
  }, [])

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
    if (!value.trim() || isDisabled || isUploading) return
    const uploaded = attachments
      .filter((item): item is AttachmentItem & { path: string } => item.status === 'uploaded' && !!item.path)
      .map((item) => ({
        name: item.name,
        path: item.path,
        ...(item.url ? { url: item.url } : {}),
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
        size: item.size,
      }))
    if (uploaded.length > 0) onSend(value, uploaded)
    else onSend(value)
    setValue('')
    setAttachments([])
    setUploadError(null)
    setShowSuggestions(false)
    inputRef.current?.focus()
  }, [value, isDisabled, isUploading, attachments, onSend])

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

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    if (!allowAttachments) return
    const files = Array.from(e.clipboardData.files)
    if (files.length === 0) return
    e.preventDefault()
    handleFiles(files)
  }, [allowAttachments, handleFiles])

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!allowAttachments) return
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault()
      setIsDragOver(true)
    }
  }, [allowAttachments])

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!allowAttachments) return
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDragOver(false)
    }
  }, [allowAttachments])

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!allowAttachments) return
    e.preventDefault()
    setIsDragOver(false)
    handleFiles(e.dataTransfer.files)
  }, [allowAttachments, handleFiles])

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
    <div
      className={`border-t border-line-soft px-4 py-3 bg-graphite-400/30 relative ${
        isDragOver ? 'ring-1 ring-cyan/50 bg-cyan/5' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
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

      {allowAttachments && (attachments.length > 0 || uploadError) && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className={`flex h-10 items-center gap-2 rounded-md border px-2 text-xs ${
                attachment.status === 'error'
                  ? 'border-red/40 bg-red/10 text-red'
                  : 'border-line-soft bg-graphite-300 text-foreground'
              }`}
            >
              {attachment.url && attachment.status === 'uploaded' && (
                <img
                  src={attachment.url}
                  alt={attachment.name}
                  className="h-7 w-7 rounded object-cover bg-graphite-400"
                />
              )}
              <span className="max-w-40 truncate">{attachment.name}</span>
              {attachment.status === 'uploading' && (
                <span className="text-graphite-100">Uploading...</span>
              )}
              {attachment.status === 'error' && (
                <span className="max-w-36 truncate text-red/80">{attachment.error}</span>
              )}
              <button
                type="button"
                onClick={() => removeAttachment(attachment.id)}
                title={`Remove ${attachment.name}`}
                aria-label={`Remove ${attachment.name}`}
                className="ml-1 h-6 w-6 rounded text-graphite-100 hover:bg-surface hover:text-foreground"
              >
                x
              </button>
            </div>
          ))}
          {uploadError && (
            <span role="status" className="text-xs text-red">{uploadError}</span>
          )}
        </div>
      )}

      <div className="flex gap-2">
        {allowAttachments && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              aria-label="Character reference image files"
              onChange={handleFileInputChange}
              className="hidden"
            />
            <button
              type="button"
              title="Attach character images"
              aria-label="Attach character images"
              onClick={() => fileInputRef.current?.click()}
              disabled={isDisabled || isUploading}
              className="h-10 w-10 flex-shrink-0 rounded-lg border border-line-soft bg-graphite-300 text-lg leading-none text-graphite-100 hover:border-cyan/40 hover:text-cyan transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              +
            </button>
          </>
        )}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={isDisabled ? 'Waiting...' : (customPlaceholder || 'Type a task or / for commands...')}
          disabled={isDisabled}
          className="flex-1 bg-graphite-300 border border-line-soft rounded-lg px-4 py-2.5 text-sm text-foreground placeholder:text-graphite-200 focus:outline-none focus:border-cyan/40 transition-colors disabled:opacity-50"
        />
        <button
          onClick={handleSubmit}
          disabled={isDisabled || isUploading || !value.trim()}
          className="px-5 py-2.5 rounded-lg bg-cyan text-background font-mono text-sm font-semibold hover:bg-cyan/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          Send
        </button>
      </div>
    </div>
  )
}
