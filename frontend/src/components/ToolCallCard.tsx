import { useState, useEffect } from 'react'
import { MediaWithOverlay } from './MediaWithOverlay'
import ReactMarkdown from 'react-markdown'
import type { ToolCall } from '../lib/store'
import { useAppState } from '../lib/store'
import { SceneBreakdownCard } from './SceneBreakdownCard'
import { ShotCompositionCard, SceneStateCard } from './ShotCompositionCard'

interface ToolCallCardProps {
  toolCall: ToolCall
  onEditPrompt?: (nodeId: string, frame: string | null) => void
  onRedoNode?: (nodeId: string) => void
}

const TOOL_NAMES: Record<string, string> = {
  generate_content: 'Writing',
  generate_plot: 'Plot',
  generate_story: 'Story',
  generate_character: 'Character',
  generate_setting: 'Setting',
  generate_scene: 'Scene',
  generate_world_style: 'World Style',
  generate_scene_video_prompt: 'Scene Breakdown',
  generate_shot_motion_directive: 'Motion Directive',
  generate_image: 'Image Generation',
  generate_shot_image: 'Shot Image',
  generate_video: 'Video Generation',
  generate_shot_video: 'Shot Video',
  assemble_final_video: 'Final Assembly',
  think: 'Thinking',
  extract_collections: 'Extraction',
  json_repair: 'JSON Repair',
  scene_state: 'Scene State',
}

const CONTENT_COLOR = { border: 'border-cyan/20', statusActive: 'text-cyan', statusDone: 'text-green' }
const IMAGE_COLOR = { border: 'border-violet-400/25', statusActive: 'text-violet-400', statusDone: 'text-green' }
const VIDEO_COLOR = { border: 'border-amber-400/25', statusActive: 'text-amber-400', statusDone: 'text-green' }

const TOOL_COLORS: Record<string, { border: string; statusActive: string; statusDone: string }> = {
  generate_content:              CONTENT_COLOR,
  generate_plot:                 CONTENT_COLOR,
  generate_story:                CONTENT_COLOR,
  generate_character:            CONTENT_COLOR,
  generate_setting:              CONTENT_COLOR,
  generate_scene:                CONTENT_COLOR,
  generate_world_style:          CONTENT_COLOR,
  generate_scene_video_prompt:   CONTENT_COLOR,
  generate_shot_motion_directive: CONTENT_COLOR,
  extract_collections:           CONTENT_COLOR,
  generate_image:                IMAGE_COLOR,
  generate_shot_image:           IMAGE_COLOR,
  generate_shot_video:           VIDEO_COLOR,
  generate_video:                VIDEO_COLOR,
  assemble_final_video:          { border: 'border-green/25', statusActive: 'text-green', statusDone: 'text-green' },
  scene_state:                   { border: 'border-teal-400/25', statusActive: 'text-teal-400', statusDone: 'text-teal-400' },
}

const DEFAULT_COLORS = { border: 'border-line-soft', statusActive: 'text-cyan', statusDone: 'text-green' }

/** Markdown wrapper with prose styling */
function Md({ children, className }: { children: string; className?: string }) {
  return (
    <div className={`prose prose-invert prose-sm max-w-none
      prose-headings:text-foreground prose-headings:font-semibold prose-headings:mt-2 prose-headings:mb-1
      prose-p:text-graphite-050 prose-p:my-1 prose-p:leading-relaxed
      prose-strong:text-foreground prose-em:text-graphite-050
      prose-li:text-graphite-050 prose-li:my-0
      prose-hr:border-line-soft prose-hr:my-2
      ${className ?? ''}`}>
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  )
}

/** Parse progress from streaming text like "Step 2/3 (67%)" */
function parseProgress(text: string): { step: number; total: number; percent: number } | null {
  const match = text.match(/(\d+)\s*\/\s*(\d+)\s*\((\d+)%\)/)
  if (match) return { step: parseInt(match[1]), total: parseInt(match[2]), percent: parseInt(match[3]) }
  const pctMatch = text.match(/(\d+)%/)
  if (pctMatch) return { step: 0, total: 0, percent: parseInt(pctMatch[1]) }
  return null
}

function ProgressBar({ text }: { text: string }) {
  const progress = parseProgress(text)
  if (!progress) return null
  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between text-[10px] text-graphite-100 mb-1">
        <span>{progress.step && progress.total ? `Step ${progress.step}/${progress.total}` : 'Processing'}</span>
        <span>{progress.percent}%</span>
      </div>
      <div className="h-1.5 bg-graphite-400 rounded-full overflow-hidden">
        <div className="h-full bg-cyan rounded-full transition-all duration-300" style={{ width: `${progress.percent}%` }} />
      </div>
    </div>
  )
}

function WorkflowBadge({ name }: { name: string }) {
  return (
    <span className="inline-block px-1.5 py-0.5 text-[10px] rounded bg-cyan/10 text-cyan border border-cyan/20 font-mono">
      {name}
    </span>
  )
}

/**
 * Short-form label for a model id. OpenRouter-style ids like
 * "x-ai/grok-4.1-fast" → "grok-4.1-fast"; Anthropic ids like
 * "claude-sonnet-4-6" stay as-is. Long model ids get truncated.
 */
function shortenModel(model: string): string {
  const slash = model.lastIndexOf('/')
  const tail = slash >= 0 ? model.slice(slash + 1) : model
  return tail.length > 32 ? tail.slice(0, 30) + '…' : tail
}

/**
 * Compact badge showing which LLM handled a given tool_call. Hover reveals
 * the full model id. Styling is muted so it reads as metadata, not a status.
 */
function ModelBadge({ model }: { model: string }) {
  const short = shortenModel(model)
  return (
    <span
      title={`Model: ${model}`}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-graphite-300/60 text-graphite-100 border border-line-soft font-mono"
    >
      <span className="text-[8px] text-graphite-200">⚙</span>
      <span>{short}</span>
    </span>
  )
}

function ItemTitle({ item }: { item: string }) {
  const parts = item.match(/^(.+?):\s*(.+)$/)
  if (!parts) return <span className="text-sm font-medium text-foreground">{item}</span>
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[10px] text-graphite-100 uppercase tracking-wider">{parts[1]}</span>
      <span className="text-sm font-medium text-foreground">{parts[2]}</span>
    </span>
  )
}

/** Parse markdown sections from structured content (## Heading → body) */
function parseSections(text: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = []
  const lines = text.split('\n')
  let currentHeading = ''
  let currentBody: string[] = []

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/)
    const h3 = line.match(/^###\s+(.+)/)
    if (h2 || h3) {
      if (currentHeading || currentBody.length > 0) {
        sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() })
      }
      currentHeading = (h2 || h3)![1]!
      currentBody = []
    } else {
      currentBody.push(line)
    }
  }
  if (currentHeading || currentBody.length > 0) {
    sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() })
  }
  return sections.filter(s => s.heading || s.body)
}

/** Structured character/setting card with collapsible sections */
function StructuredContentCard({ content }: { content: string }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0]))
  const sections = parseSections(content)

  // Extract key fields from the first section (Name, Age, etc.)
  const firstSection = sections[0]
  const keyFields: Array<{ label: string; value: string }> = []
  if (firstSection?.body) {
    const fieldRegex = /\*\*(.+?):\*\*\s*(.+)/g
    let match
    while ((match = fieldRegex.exec(firstSection.body)) !== null) {
      keyFields.push({ label: match[1], value: match[2] })
    }
  }

  const toggle = (i: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  return (
    <div className="space-y-0">
      {/* Key fields as a compact header row */}
      {keyFields.length > 0 && (
        <div className="px-3 py-2 flex flex-wrap gap-x-4 gap-y-0.5 border-b border-line-soft">
          {keyFields.slice(0, 5).map(f => (
            <span key={f.label} className="text-[11px]">
              <span className="text-graphite-200">{f.label}:</span>{' '}
              <span className="text-foreground">{f.value}</span>
            </span>
          ))}
        </div>
      )}

      {/* Collapsible sections */}
      {sections.map((section, i) => {
        // Skip the first section if we already showed key fields from it
        if (i === 0 && keyFields.length > 0 && !section.heading.match(/description|personality|motivation|background/i)) return null
        const isOpen = expanded.has(i)
        return (
          <div key={i} className="border-b border-line-soft last:border-0">
            {section.heading && (
              <button
                onClick={() => toggle(i)}
                className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-surface/50 transition-colors cursor-pointer"
              >
                <span className="text-[10px] text-graphite-200 transition-transform" style={{ transform: isOpen ? 'rotate(90deg)' : 'none' }}>
                  ▸
                </span>
                <span className="text-[11px] font-semibold text-foreground uppercase tracking-wider">{section.heading}</span>
              </button>
            )}
            {(isOpen || !section.heading) && section.body && (
              <div className="px-3 pb-2">
                <Md className="text-[11px]">{section.body}</Md>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Separate thinking content from main content in streaming text */
function separateThinking(text: string): { thinking: string; content: string } {
  let thinking = ''
  let content = text

  // Extract all <thinking>...</thinking> blocks
  const thinkRegex = /<thinking>([\s\S]*?)<\/thinking>/g
  let match
  while ((match = thinkRegex.exec(text)) !== null) {
    thinking += match[1]
  }

  // Remove thinking blocks from content
  content = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim()

  return { thinking: thinking.trim(), content }
}

/** Collapsible thinking block */
/** Thinking block — shows LLM reasoning with visual distinction from main content */
function ThinkingBlock({ text, isActive }: { text: string; isActive: boolean }) {
  const [expanded, setExpanded] = useState(false)
  if (!text) return null

  return (
    <div className="mx-3 my-1.5 rounded-md border border-violet-500/15 bg-violet-500/5 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[10px] text-violet-300 hover:text-violet-200 cursor-pointer"
      >
        <span style={{ transform: expanded ? 'rotate(90deg)' : 'none' }} className="transition-transform text-[8px]">▸</span>
        {isActive ? (
          <span className="flex items-center gap-1.5">
            <span className="flex gap-0.5">
              <span className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1 h-1 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
            <span className="italic">Thinking ({text.length} chars)</span>
          </span>
        ) : (
          <span className="italic">Thought for {text.length} chars</span>
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-2 text-[10px] text-violet-300/70 max-h-40 overflow-y-auto whitespace-pre-wrap italic leading-relaxed">
          {text}
        </div>
      )}
    </div>
  )
}

/** Try to extract a shot count from streaming JSON array content */
function countJsonShots(text: string): number {
  const matches = text.match(/"shotNumber"\s*:/g)
  return matches?.length ?? 0
}

/** Content generation body — LLM writing (story, character, scene, etc.) */
function ContentBody({ args, streamingContent, toolName }: { args: Record<string, string>; streamingContent?: string; toolName: string }) {
  const [showPrompt, setShowPrompt] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const item = args['item']
  const prompt = args['prompt']
  const skills = args['skills']

  // Detect character/setting content by item name or content structure
  const isStructured = item && (
    item.toLowerCase().includes('character') ||
    item.toLowerCase().includes('setting') ||
    item.toLowerCase().includes('world style')
  )
  const hasContent = streamingContent && streamingContent.length > 50

  // Detect JSON content (shot_image_prompt, scene_video_prompt output)
  const trimmedContent = streamingContent?.trim() ?? ''
  const isJsonContent = trimmedContent.startsWith('[') || trimmedContent.startsWith('{')
  const isJsonTool = toolName.includes('shot_image_prompt') || toolName.includes('scene_video_prompt')

  return (
    <div className="space-y-1.5">
      <div className="px-3 pt-2 flex items-center gap-2 flex-wrap">
        {item && <ItemTitle item={item} />}
        {skills && (
          <div className="flex flex-wrap gap-1">
            {skills.split(',').map(s => (
              <span key={s.trim()} className="px-1 py-0.5 text-[9px] rounded bg-graphite-300 text-graphite-100">{s.trim()}</span>
            ))}
          </div>
        )}
        {prompt && (
          <button onClick={() => setShowPrompt(!showPrompt)} className="text-[10px] text-graphite-200 hover:text-graphite-100 cursor-pointer">
            {showPrompt ? 'Hide prompt' : 'Show prompt'}
          </button>
        )}
      </div>
      {showPrompt && prompt && (
        <div className="mx-3 p-2 rounded bg-graphite-300/50 border border-line-soft text-[11px] text-graphite-050 max-h-40 overflow-y-auto whitespace-pre-wrap">
          {prompt}
        </div>
      )}
      {hasContent && isJsonContent && isJsonTool ? (
        <div className="pb-1 space-y-0">
          {toolName.includes('scene_video_prompt') ? (
            <SceneBreakdownCard content={trimmedContent} />
          ) : toolName.includes('shot_image_prompt') ? (
            <ShotCompositionCard content={trimmedContent} />
          ) : (
            <div className="px-3 pb-2">
              <pre className="p-2 rounded bg-graphite-300/50 border border-line-soft text-[10px] text-graphite-050 max-h-48 overflow-auto font-mono">
                {trimmedContent}
              </pre>
            </div>
          )}
          <div className="px-3 pb-1">
            <button onClick={() => setShowRaw(!showRaw)} className="text-[10px] text-graphite-200 hover:text-graphite-100 cursor-pointer">
              {showRaw ? 'Hide JSON' : 'Show JSON'}
            </button>
          </div>
          {showRaw && (
            <div className="px-3 pb-2">
              <pre className="p-2 rounded bg-graphite-300/50 border border-line-soft text-[10px] text-graphite-050 max-h-48 overflow-auto font-mono">
                {trimmedContent}
              </pre>
            </div>
          )}
        </div>
      ) : hasContent && isStructured ? (
        <StructuredContentCard content={streamingContent} />
      ) : streamingContent ? (
        <div className="px-3 pb-2 max-h-72 overflow-y-auto">
          <Md className="text-xs">{streamingContent}</Md>
        </div>
      ) : null}
    </div>
  )
}

/** Image generation body — character/setting images */
function ImageGenBody({ args }: { args: Record<string, string> }) {
  const item = args['item']
  const workflow = args['workflow']
  const prompt = args['prompt']

  return (
    <div className="px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        {item && <ItemTitle item={item} />}
        {workflow && <WorkflowBadge name={workflow} />}
      </div>
      {prompt && (
        <div className="p-2 rounded bg-graphite-300/50 border border-line-soft text-xs text-foreground leading-relaxed">
          {prompt}
        </div>
      )}
    </div>
  )
}

/** Shot image body — with reference thumbnails and mode */
function ShotImageBody({ args, selectedProject }: { args: Record<string, string>; selectedProject: string | null }) {
  const item = args['item']
  const workflow = args['workflow']
  const mode = args['mode']
  const prompt = args['prompt']
  const refs = Object.entries(args).filter(([k]) => k.startsWith('ref_'))

  return (
    <div className="px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        {item && <ItemTitle item={item} />}
        {workflow && <WorkflowBadge name={workflow} />}
        {mode && (
          <span className="px-1.5 py-0.5 text-[10px] rounded bg-graphite-300 text-graphite-100 font-mono">
            {mode.replace('_', ' ')}
          </span>
        )}
      </div>
      {refs.length > 0 && selectedProject && (
        <div className="flex gap-2 flex-wrap">
          {refs.map(([key, val]) => (
            <div key={key} className="flex flex-col items-center gap-0.5">
              <img
                src={`/api/v1/assets/${selectedProject}/${val}`}
                alt={key}
                className="w-14 h-14 rounded object-cover border border-line-soft"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
              <span className="text-[9px] text-graphite-200">{key.replace(/^ref_\d+_/, '')}</span>
            </div>
          ))}
        </div>
      )}
      {prompt && (
        <div className="p-2 rounded bg-graphite-300/50 border border-line-soft text-xs text-foreground leading-relaxed">
          {prompt}
        </div>
      )}
    </div>
  )
}

/** Shot video body — workflow, source image, duration, prompt */
function ShotVideoBody({ args, selectedProject }: { args: Record<string, string>; selectedProject: string | null }) {
  const item = args['item']
  const workflow = args['workflow']
  const sourceImage = args['source_image']
  const duration = args['duration']
  const prompt = args['prompt']
  const isT2V = sourceImage === '(text-to-video)'

  return (
    <div className="px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        {item && <ItemTitle item={item} />}
        {workflow && <WorkflowBadge name={workflow} />}
        {duration && (
          <span className="px-1.5 py-0.5 text-[10px] rounded bg-graphite-300 text-graphite-100 font-mono">{duration}s</span>
        )}
        {isT2V && (
          <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-500/10 text-amber-400 font-mono">t2v</span>
        )}
      </div>
      {!isT2V && sourceImage && selectedProject && (
        <div className="flex items-start gap-2">
          <img
            src={`/api/v1/assets/${selectedProject}/${sourceImage}`}
            alt="Source"
            className="w-20 h-20 rounded object-cover border border-line-soft flex-shrink-0"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
          {prompt && (
            <div className="flex-1 p-2 rounded bg-graphite-300/50 border border-line-soft text-xs text-foreground leading-relaxed">
              {prompt}
            </div>
          )}
        </div>
      )}
      {(isT2V || !sourceImage) && prompt && (
        <div className="p-2 rounded bg-graphite-300/50 border border-line-soft text-xs text-foreground leading-relaxed">
          {prompt}
        </div>
      )}
    </div>
  )
}

/** Assembly body — just streaming text */
function AssemblyBody({ streamingContent }: { streamingContent?: string }) {
  return streamingContent ? (
    <div className="px-3 py-2 text-xs text-graphite-050 whitespace-pre-wrap font-mono">
      {streamingContent}
    </div>
  ) : null
}

/** Extraction body — show extracted items as badges */
function ExtractionBody({ args, result, status }: { args: Record<string, string>; result: unknown; status: string }) {
  const source = args['source']
  const resultObj = typeof result === 'object' && result !== null ? result as Record<string, unknown> : null

  return (
    <div className="px-3 py-2 space-y-1.5">
      {source && <span className="text-[11px] text-graphite-100">from {source}</span>}
      {status === 'completed' && resultObj && (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(resultObj).filter(([, v]) => Array.isArray(v)).map(([key, values]) => (
            <div key={key} className="flex flex-wrap gap-1">
              <span className="text-[10px] text-graphite-200 uppercase mr-1">{key}:</span>
              {(values as unknown[]).map((v, i) => (
                <span key={i} className="px-1.5 py-0.5 text-[10px] rounded bg-cyan/10 text-cyan border border-cyan/20">
                  {String(v)}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Default args for unknown tool types */
function DefaultBody({ args, selectedProject }: { args: Record<string, string>; selectedProject: string | null }) {
  if (!args || Object.keys(args).length === 0) return null
  const workflow = args['workflow']
  const prompt = args['prompt']
  // 'model' is shown as a badge in the header, so skip it in the body to avoid duplication.
  const otherArgs = Object.entries(args).filter(([k]) => k !== 'prompt' && k !== 'workflow' && k !== 'model')

  return (
    <div className="px-3 py-2 space-y-1.5">
      {workflow && <WorkflowBadge name={workflow} />}
      {prompt && (
        <div className="p-2 rounded bg-graphite-300/50 border border-line-soft text-xs text-foreground leading-relaxed">{prompt}</div>
      )}
      {otherArgs.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {otherArgs.map(([key, value]) => {
            const val = String(value)
            if (val.match(/\.(png|jpg|jpeg|webp)$/i) && selectedProject) {
              return (
                <div key={key} className="flex flex-col items-center gap-0.5">
                  <img src={`/api/v1/assets/${selectedProject}/${val}`} alt={key}
                    className="w-14 h-14 rounded object-cover border border-line-soft"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                  <span className="text-graphite-100 text-[9px]">{key.replace(/^ref_\d+_/, '')}</span>
                </div>
              )
            }
            return (
              <span key={key} className="text-graphite-100">
                <span className="font-semibold">{key}:</span> {val.substring(0, 60)}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function ToolCallCard({ toolCall, onEditPrompt, onRedoNode }: ToolCallCardProps) {
  const { selectedProject } = useAppState()
  const { toolName, status, streamingContent, result, args, startTime } = toolCall
  const displayName = TOOL_NAMES[toolName] || toolName.replace(/_/g, ' ')
  // Force re-render every second while executing to update elapsed timer
  const [, setTick] = useState(0)
  useEffect(() => {
    if (status !== 'executing') return
    const interval = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(interval)
  }, [status])

  // dhee_* tools collapse by default — the agent narrates results in chat,
  // so the JSON dump is duplication. Click the header to expand for details.
  // Other tools keep their legacy behavior (always expanded).
  const isdheeTool = toolName.startsWith('dhee_')
  const [expanded, setExpanded] = useState<boolean>(!isdheeTool)

  const elapsed = status === 'executing' ? Math.round((Date.now() - startTime) / 1000) : undefined
  const duration = toolCall.duration ? Math.round((toolCall.duration - startTime) / 1000) : undefined

  const colors = TOOL_COLORS[toolName] || DEFAULT_COLORS
  const statusColor = status === 'completed' ? colors.statusDone : status === 'error' ? 'text-error' : colors.statusActive
  const borderColor = status === 'error' ? 'border-error/20' : colors.border

  const resultObj = typeof result === 'object' && result !== null ? result as Record<string, unknown> : null
  const filePath = resultObj?.['file_path'] as string | undefined
  const isVideo = filePath?.match(/\.(mp4|webm|mov)$/i)
  const isImage = filePath?.match(/\.(png|jpg|jpeg|webp)$/i)

  // Progress detection
  const lastLine = streamingContent?.trim().split('\n').pop()?.trim() ?? ''
  const hasProgress = !!parseProgress(lastLine)

  // Separate thinking from content, then filter redundant lines
  const { thinking: thinkingText, content: rawContent } = separateThinking(streamingContent ?? '')
  const meaningfulContent = rawContent
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      if (!trimmed) return false
      if (status === 'completed') {
        if (trimmed.startsWith('Complete!')) return false
        if (trimmed.startsWith('Video saved to')) return false
        if (trimmed.startsWith('Image saved to')) return false
        if (trimmed.startsWith('Output:')) return false
        if (trimmed.match(/^\d+\/\d+\s*\(\d+%\)/)) return false
      }
      if (parseProgress(trimmed)) return false
      return true
    })
    .join('\n')
    .trim()

  // Classify tool type for rendering
  const isContentGen = toolName.startsWith('generate_') &&
    !['generate_image', 'generate_shot_image', 'generate_shot_video', 'generate_video'].includes(toolName)

  // Per-type body renderer
  const renderBody = () => {
    if (isContentGen) {
      return <ContentBody args={args ?? {}} streamingContent={meaningfulContent} toolName={toolName} />
    }
    switch (toolName) {
      case 'generate_image':
        return <ImageGenBody args={args ?? {}} />
      case 'generate_shot_image':
        return <ShotImageBody args={args ?? {}} selectedProject={selectedProject} />
      case 'generate_shot_video':
      case 'generate_video':
        return <ShotVideoBody args={args ?? {}} selectedProject={selectedProject} />
      case 'assemble_final_video':
        return <AssemblyBody streamingContent={meaningfulContent} />
      case 'extract_collections':
        return <ExtractionBody args={args ?? {}} result={result} status={status} />
      case 'scene_state':
        return meaningfulContent ? <SceneStateCard content={meaningfulContent} /> : <DefaultBody args={args ?? {}} selectedProject={selectedProject} />
      default:
        return <DefaultBody args={args ?? {}} selectedProject={selectedProject} />
    }
  }

  // For content gen and assembly, streaming is handled in the body
  const showSeparateStreaming = !isContentGen && toolName !== 'assemble_final_video' && toolName !== 'extract_collections' && toolName !== 'scene_state'

  // Header controls — when collapsed (dhee_* default), the whole header
  // is a button that expands the body. Always render the header + media so
  // image/video previews remain visible without clicking through.
  const isCollapsible = isdheeTool
  const headerClass = `flex items-center justify-between px-3 py-2 ${expanded ? 'border-b border-line-soft' : ''} ${isCollapsible ? 'cursor-pointer select-none hover:bg-graphite-300/40' : ''}`

  return (
    <div className={`rounded-lg border ${borderColor} bg-graphite-400/50 overflow-hidden`}>
      {/* Header */}
      <div
        className={headerClass}
        onClick={isCollapsible ? () => setExpanded(e => !e) : undefined}
        role={isCollapsible ? 'button' : undefined}
        tabIndex={isCollapsible ? 0 : undefined}
        onKeyDown={isCollapsible ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setExpanded(v => !v)
          }
        } : undefined}
      >
        <div className="flex items-center gap-2 min-w-0">
          {isCollapsible && (
            <span
              className="text-graphite-100 text-[8px] transition-transform"
              style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}
              aria-hidden="true"
            >▸</span>
          )}
          <span className={`text-sm ${statusColor}`}>
            {status === 'executing' ? '◉' : status === 'completed' ? '✓' : '✗'}
          </span>
          <span className="font-mono text-xs text-foreground truncate">{displayName}</span>
          {args?.['model'] && <ModelBadge model={String(args['model'])} />}
        </div>
        <span className="font-mono text-[10px] text-graphite-100 flex-shrink-0">
          {elapsed !== undefined ? `${elapsed}s...` : duration !== undefined ? `${duration}s` : ''}
        </span>
      </div>

      {expanded && (
        <>
          {/* Thinking block — collapsible, shown when LLM has <think> output */}
          {thinkingText && <ThinkingBlock text={thinkingText} isActive={status === 'executing' && !meaningfulContent} />}

          {/* Per-type body */}
          {renderBody()}

          {/* Progress bar */}
          {status === 'executing' && hasProgress && (
            <ProgressBar text={lastLine} />
          )}

          {/* Streaming content (only for types not handled in body) */}
          {showSeparateStreaming && meaningfulContent && status !== 'completed' && (
            <div className="px-3 py-2 text-xs text-graphite-050 whitespace-pre-wrap max-h-32 overflow-y-auto">
              {meaningfulContent}
            </div>
          )}

          {/* Result */}
          {result && status !== 'executing' && (
            <div className="px-3 py-1.5 text-xs">
              {typeof result === 'string' ? (
                <div className="text-graphite-050 whitespace-pre-wrap">{result}</div>
              ) : resultObj?.['status'] === 'completed' && filePath ? (
                <div className="text-green/70 text-[10px] font-mono">{filePath}</div>
              ) : resultObj?.['status'] === 'completed' ? (
                <div className="text-green text-[11px]">Completed</div>
              ) : resultObj?.['error'] ? (
                <div className="text-error">{String(resultObj['error'])}</div>
              ) : toolName === 'extract_collections' || toolName === 'scene_state' ? null : (
                <div className="text-graphite-100 max-h-48 overflow-y-auto">
                  <pre className="text-[10px] whitespace-pre-wrap">{JSON.stringify(result, null, 2)}</pre>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Media preview — always visible, even when collapsed, so show-* tools
          deliver value at a glance without clicking through to expand. */}
      {filePath && selectedProject && status === 'completed' && (isVideo || isImage) && (
        <div className={`px-3 py-2 ${expanded ? 'border-t border-line-soft' : ''}`}>
          <MediaWithOverlay
            path={filePath}
            project={selectedProject}
            kind={isVideo ? 'video' : 'image'}
            maxHeight="max-h-64"
            onEditPrompt={onEditPrompt}
            onRedoNode={onRedoNode}
          />
        </div>
      )}
    </div>
  )
}
