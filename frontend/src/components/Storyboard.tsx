import { useMemo, useState } from 'react'
import { useAppState } from '../lib/store'
import { PromptEditModal } from './PromptEditModal'

interface StoryboardProps {
  onRedoNode?: (nodeId: string, frame?: string) => void
  onRedoPrompt?: (nodeId: string) => void
  onRedoNodeWithPrompt?: (nodeId: string, editedPrompt: Record<string, unknown>) => void
}

interface ShotEntry {
  shotNumber: number
  nodeId: string   // shot_image:scene_1_shot_1
  firstFrameUrl: string | null
  midFrameUrl: string | null
  lastFrameUrl: string | null
  firstFramePath: string | null
  midFramePath: string | null
  lastFramePath: string | null
  videoUrl: string | null
  videoPath: string | null
  videoNodeId: string | null   // shot_video:scene_1_shot_1
}

interface SceneEntry {
  sceneNumber: number
  shots: ShotEntry[]
}

/**
 * Pull scene + shot numbers from a node's itemId. The executor gives
 * every per-shot collection node an itemId of the form
 * `scene_<N>_shot_<M>` — this is the canonical identifier and never
 * depends on filesystem layout or asset filenames.
 */
function itemIdToSceneShot(itemId: string | undefined): [number, number] | null {
  if (!itemId) return null
  const m = itemId.match(/^scene_(\d+)_shot_(\d+)$/)
  if (!m) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10)]
}

export function Storyboard({ onRedoNode, onRedoPrompt, onRedoNodeWithPrompt }: StoryboardProps) {
  const { nodes, selectedProject } = useAppState()
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [confirmRedo, setConfirmRedo] = useState<string | null>(null)
  // Node ID to edit — for shot-level prompt editing we target the shot_image_prompt node
  const [editNodeId, setEditNodeId] = useState<string | null>(null)
  const [editFrame, setEditFrame] = useState<string | null>(null)

  function handleEditPromptClick(shotNodeId: string, frame: string) {
    // shotNodeId like 'shot_image:scene_1_shot_1' → edit the prompt node
    const promptNodeId = shotNodeId.replace('shot_image:', 'shot_image_prompt:')
    setEditNodeId(promptNodeId)
    setEditFrame(frame)
  }

  /**
   * Build storyboard structure from executor node state. Flow:
   *   1. Pull every `shot_image:scene_N_shot_M` node → its outputPaths
   *      gives first/last/mid-frame file paths directly. Scene + shot
   *      come from the nodeId, NOT from any filename.
   *   2. Pull matching `shot_video:scene_N_shot_M` nodes for the video
   *      URL the same way.
   *   3. Assemble into `{ scene → shots → frames+video }`.
   *
   * The on-disk filename shape is irrelevant to the UI — a shot with
   * no generated images yet shows empty placeholders; a shot with
   * complete outputPaths shows fully-populated frames.
   */
  const scenes = useMemo<SceneEntry[]>(() => {
    const buildUrl = (relPath: string | undefined): string | null => {
      if (!relPath) return null
      if (!selectedProject) return relPath
      return `/api/v1/assets/${selectedProject}/${relPath}`
    }

    const sceneMap = new Map<number, Map<number, ShotEntry>>()
    const getOrCreateShot = (sceneNum: number, shotNum: number): ShotEntry => {
      if (!sceneMap.has(sceneNum)) sceneMap.set(sceneNum, new Map())
      const scene = sceneMap.get(sceneNum)!
      if (!scene.has(shotNum)) {
        scene.set(shotNum, {
          shotNumber: shotNum,
          nodeId: `shot_image:scene_${sceneNum}_shot_${shotNum}`,
          firstFrameUrl: null,
          midFrameUrl: null,
          lastFrameUrl: null,
          firstFramePath: null,
          midFramePath: null,
          lastFramePath: null,
          videoUrl: null,
          videoPath: null,
          videoNodeId: null,
        })
      }
      return scene.get(shotNum)!
    }

    for (const node of Object.values(nodes)) {
      if (node.typeId === 'shot_image') {
        const sceneShot = itemIdToSceneShot(node.itemId)
        if (!sceneShot) continue
        const [sceneNum, shotNum] = sceneShot
        const shot = getOrCreateShot(sceneNum, shotNum)
        shot.nodeId = node.id

        const paths = node.outputPaths ?? {}
        if (paths['first_frame']) {
          shot.firstFramePath = paths['first_frame']
          shot.firstFrameUrl = buildUrl(paths['first_frame'])
        }
        if (paths['last_frame']) {
          shot.lastFramePath = paths['last_frame']
          shot.lastFrameUrl = buildUrl(paths['last_frame'])
        }
        if (paths['mid_frame']) {
          shot.midFramePath = paths['mid_frame']
          shot.midFrameUrl = buildUrl(paths['mid_frame'])
        }
        // Legacy single-output shot_image nodes stored the frame at
        // outputPath rather than outputPaths.first_frame. Honor that
        // as the first frame when multi-frame paths are absent.
        if (!shot.firstFramePath && node.outputPath) {
          shot.firstFramePath = node.outputPath
          shot.firstFrameUrl = buildUrl(node.outputPath)
        }
      } else if (node.typeId === 'shot_video') {
        const sceneShot = itemIdToSceneShot(node.itemId)
        if (!sceneShot) continue
        const [sceneNum, shotNum] = sceneShot
        const shot = getOrCreateShot(sceneNum, shotNum)
        shot.videoNodeId = node.id
        if (node.outputPath) {
          shot.videoPath = node.outputPath
          shot.videoUrl = buildUrl(node.outputPath)
        }
      }
    }

    const sceneEntries: SceneEntry[] = []
    for (const sceneNum of [...sceneMap.keys()].sort((a, b) => a - b)) {
      const shots = [...sceneMap.get(sceneNum)!.values()].sort(
        (a, b) => a.shotNumber - b.shotNumber,
      )
      sceneEntries.push({ sceneNumber: sceneNum, shots })
    }
    return sceneEntries
  }, [nodes, selectedProject])

  // Pending frame-specific redo confirmation (nodeId + frame)
  const [confirmFrameRedo, setConfirmFrameRedo] = useState<{ nodeId: string; frame: string } | null>(null)
  // Pending "redo prompt" confirmation — regenerates the shot's prompt + image, stops
  const [confirmPromptRedo, setConfirmPromptRedo] = useState<string | null>(null)
  // Pending shot-video redo confirmation
  const [confirmVideoRedo, setConfirmVideoRedo] = useState<string | null>(null)

  function handleRedoClick(nodeId: string) {
    setConfirmRedo(nodeId)
  }

  function handleConfirmRedo() {
    if (confirmRedo && onRedoNode) {
      onRedoNode(confirmRedo)
    }
    setConfirmRedo(null)
  }

  function handleFrameRedoClick(nodeId: string, frame: string) {
    setConfirmFrameRedo({ nodeId, frame })
  }

  function handleConfirmFrameRedo() {
    if (confirmFrameRedo && onRedoNode) {
      onRedoNode(confirmFrameRedo.nodeId, confirmFrameRedo.frame)
    }
    setConfirmFrameRedo(null)
  }

  function handlePromptRedoClick(nodeId: string) {
    setConfirmPromptRedo(nodeId)
  }

  function handleConfirmPromptRedo() {
    if (confirmPromptRedo && onRedoPrompt) {
      onRedoPrompt(confirmPromptRedo)
    }
    setConfirmPromptRedo(null)
  }

  function handleVideoRedoClick(videoNodeId: string) {
    setConfirmVideoRedo(videoNodeId)
  }

  function handleConfirmVideoRedo() {
    if (confirmVideoRedo && onRedoNode) {
      onRedoNode(confirmVideoRedo)
    }
    setConfirmVideoRedo(null)
  }

  function handleEditMotionClick(videoNodeId: string) {
    // Edit modal targets the shot_video node directly; backend resolves the
    // motion directive file via resolveNodePromptPath (shot_video → motion).
    setEditNodeId(videoNodeId)
    setEditFrame(null)
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-6 bg-background">
        {scenes.length === 0 && (
          <div className="flex-1 flex items-center justify-center text-graphite-200 text-sm">
            No shots yet — the storyboard will appear as images are generated.
          </div>
        )}

        {scenes.map(scene => (
          <section key={scene.sceneNumber} className="flex flex-col gap-2">
            <h2 className="font-mono text-base font-bold uppercase tracking-wider text-cyan border-b-2 border-cyan/40 pb-1.5">
              Scene {scene.sceneNumber}
              <span className="ml-2 text-graphite-100 text-xs font-normal tracking-normal normal-case">
                · {scene.shots.length} {scene.shots.length === 1 ? 'shot' : 'shots'}
              </span>
            </h2>

            <div className="flex flex-col gap-3">
              {scene.shots.map(shot => {
                const hasMid = shot.midFrameUrl != null
                return (
                  <div
                    key={shot.shotNumber}
                    className="rounded-md border border-line-soft bg-surface p-2"
                  >
                    <div className="text-sm font-mono font-semibold uppercase tracking-wider text-foreground mb-2 flex items-center justify-between">
                      <span>
                        <span className="text-cyan/80">Scene {scene.sceneNumber}</span>
                        <span className="text-graphite-100 mx-1.5">·</span>
                        <span className="text-foreground">Shot {shot.shotNumber}</span>
                      </span>
                      {onRedoNode && (
                        <button
                          onClick={() => handleRedoClick(shot.nodeId)}
                          className="text-graphite-100 hover:text-cyan text-[10px]"
                          title={`Redo entire shot ${shot.nodeId}`}
                        >
                          ↻ redo all
                        </button>
                      )}
                    </div>

                    <div className={`grid ${hasMid ? 'grid-cols-3' : 'grid-cols-2'} gap-2`}>
                      <ShotFrame
                        label="FIRST FRAME"
                        url={shot.firstFrameUrl}
                        onOpen={(u) => setLightboxUrl(u)}
                        onRedo={onRedoNode ? () => handleFrameRedoClick(shot.nodeId, 'first_frame') : undefined}
                        onRedoPrompt={onRedoPrompt ? () => handlePromptRedoClick(shot.nodeId) : undefined}
                        onEditPrompt={onRedoNodeWithPrompt ? () => handleEditPromptClick(shot.nodeId, 'first_frame') : undefined}
                      />
                      {hasMid && (
                        <ShotFrame
                          label="MID FRAME"
                          url={shot.midFrameUrl}
                          onOpen={(u) => setLightboxUrl(u)}
                          onRedo={onRedoNode ? () => handleFrameRedoClick(shot.nodeId, 'mid_frame') : undefined}
                          onRedoPrompt={onRedoPrompt ? () => handlePromptRedoClick(shot.nodeId) : undefined}
                          onEditPrompt={onRedoNodeWithPrompt ? () => handleEditPromptClick(shot.nodeId, 'mid_frame') : undefined}
                        />
                      )}
                      <ShotFrame
                        label="LAST FRAME"
                        url={shot.lastFrameUrl}
                        onOpen={(u) => setLightboxUrl(u)}
                        onRedo={onRedoNode ? () => handleFrameRedoClick(shot.nodeId, 'last_frame') : undefined}
                        onRedoPrompt={onRedoPrompt ? () => handlePromptRedoClick(shot.nodeId) : undefined}
                        onEditPrompt={onRedoNodeWithPrompt ? () => handleEditPromptClick(shot.nodeId, 'last_frame') : undefined}
                      />
                    </div>

                    {/* Shot video (shown when generated) */}
                    <ShotVideo
                      videoUrl={shot.videoUrl}
                      videoNodeId={shot.videoNodeId}
                      onRedoVideo={onRedoNode && shot.videoNodeId
                        ? () => handleVideoRedoClick(shot.videoNodeId!)
                        : undefined}
                      onEditMotion={onRedoNodeWithPrompt && shot.videoNodeId
                        ? () => handleEditMotionClick(shot.videoNodeId!)
                        : undefined}
                    />
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      {/* Lightbox modal */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-pointer"
          onClick={() => setLightboxUrl(null)}
        >
          <img
            src={lightboxUrl}
            alt="Full size preview"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            className="absolute top-4 right-4 text-white text-2xl hover:text-graphite-100"
            onClick={() => setLightboxUrl(null)}
          >
            ✕
          </button>
        </div>
      )}

      {/* Prompt Edit modal */}
      {editNodeId && selectedProject && onRedoNodeWithPrompt && (
        <PromptEditModal
          nodeId={editNodeId}
          frame={editFrame ?? undefined}
          projectName={selectedProject}
          onSubmit={(nid, edited) => {
            onRedoNodeWithPrompt(nid, edited)
            setEditNodeId(null)
            setEditFrame(null)
          }}
          onCancel={() => {
            setEditNodeId(null)
            setEditFrame(null)
          }}
        />
      )}

      {/* Full-shot redo confirmation */}
      {confirmRedo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setConfirmRedo(null)}
        >
          <div
            className="bg-surface border border-line-soft rounded-lg p-5 max-w-sm shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-foreground mb-2">Redo entire shot?</h3>
            <p className="text-xs text-graphite-100 mb-4">
              This will regenerate ALL frames of <span className="text-cyan">{confirmRedo}</span> and any downstream video that depends on it.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmRedo(null)}
                className="px-3 py-1.5 text-xs rounded border border-line-soft text-graphite-100 hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmRedo}
                className="px-3 py-1.5 text-xs rounded bg-error text-white hover:bg-error/80"
              >
                Redo All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Prompt redo confirmation */}
      {confirmPromptRedo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setConfirmPromptRedo(null)}
        >
          <div
            className="bg-surface border border-line-soft rounded-lg p-5 max-w-sm shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-foreground mb-2">Regenerate prompt?</h3>
            <p className="text-xs text-graphite-100 mb-4">
              The LLM rewrites the composition prompt for{' '}
              <span className="text-cyan">{confirmPromptRedo}</span>, then regenerates the image.
              Downstream video is NOT regenerated.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmPromptRedo(null)}
                className="px-3 py-1.5 text-xs rounded border border-line-soft text-graphite-100 hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmPromptRedo}
                className="px-3 py-1.5 text-xs rounded bg-cyan text-background hover:bg-cyan/80"
              >
                Redo Prompt
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Frame-level redo confirmation */}
      {confirmFrameRedo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setConfirmFrameRedo(null)}
        >
          <div
            className="bg-surface border border-line-soft rounded-lg p-5 max-w-sm shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-foreground mb-2">
              Redo {confirmFrameRedo.frame.replace('_', ' ')}?
            </h3>
            <p className="text-xs text-graphite-100 mb-4">
              Regenerates only <span className="text-cyan">{confirmFrameRedo.frame}</span> of{' '}
              <span className="text-cyan">{confirmFrameRedo.nodeId}</span>. Other frames and
              downstream videos stay as-is.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmFrameRedo(null)}
                className="px-3 py-1.5 text-xs rounded border border-line-soft text-graphite-100 hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmFrameRedo}
                className="px-3 py-1.5 text-xs rounded bg-cyan text-background hover:bg-cyan/80"
              >
                Redo Frame
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Shot video redo confirmation */}
      {confirmVideoRedo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setConfirmVideoRedo(null)}
        >
          <div
            className="bg-surface border border-line-soft rounded-lg p-5 max-w-sm shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-foreground mb-2">Redo video?</h3>
            <p className="text-xs text-graphite-100 mb-4">
              Regenerates the video for{' '}
              <span className="text-cyan">{confirmVideoRedo.replace(/^shot_video:/, '')}</span>
              {' '}using the existing motion directive and frames.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmVideoRedo(null)}
                className="px-3 py-1.5 text-xs rounded border border-line-soft text-graphite-100 hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmVideoRedo}
                className="px-3 py-1.5 text-xs rounded bg-cyan text-background hover:bg-cyan/80"
              >
                Redo Video
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function ShotFrame({
  label,
  url,
  onOpen,
  onRedo,
  onRedoPrompt,
  onEditPrompt,
}: {
  label: string
  url: string | null
  onOpen: (url: string) => void
  onRedo?: () => void
  onRedoPrompt?: () => void
  onEditPrompt?: () => void
}) {
  return (
    <div className="flex flex-col gap-1 group">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-graphite-100">
          {label}
        </span>
      </div>
      {url ? (
        <div
          onClick={() => onOpen(url)}
          className="relative aspect-video rounded border border-line-soft bg-graphite-400 overflow-hidden cursor-pointer hover:border-cyan transition-colors"
        >
          <img
            src={url}
            alt={label}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => {
              const parent = (e.target as HTMLImageElement).parentElement
              if (parent) parent.style.display = 'none'
            }}
          />
          {/* Hover overlay with action buttons — high-contrast, readable */}
          {(onRedo || onRedoPrompt || onEditPrompt) && (
            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1.5 p-2">
              {onEditPrompt && (
                <button
                  onClick={(e) => { e.stopPropagation(); onEditPrompt() }}
                  className="px-2.5 py-1.5 rounded bg-cyan text-background hover:bg-cyan/90 text-xs font-medium shadow-lg"
                  title="Edit the shot's prompt manually"
                >
                  ✎ Edit
                </button>
              )}
              {onRedoPrompt && (
                <button
                  onClick={(e) => { e.stopPropagation(); onRedoPrompt() }}
                  className="px-2.5 py-1.5 rounded bg-graphite-300 text-foreground hover:bg-graphite-200 text-xs font-medium shadow-lg border border-line-strong"
                  title="Regenerate the prompt (LLM rewrites composition, image regenerates)"
                >
                  ↻ Prompt
                </button>
              )}
              {onRedo && (
                <button
                  onClick={(e) => { e.stopPropagation(); onRedo() }}
                  className="px-2.5 py-1.5 rounded bg-graphite-300 text-foreground hover:bg-graphite-200 text-xs font-medium shadow-lg border border-line-strong"
                  title={`Regenerate just this ${label.toLowerCase()}`}
                >
                  ↻ Image
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="aspect-video rounded border border-dashed border-line-soft bg-graphite-400/40 flex items-center justify-center text-[10px] text-graphite-200">
          (pending)
        </div>
      )}
    </div>
  )
}

function ShotVideo({
  videoUrl,
  videoNodeId,
  onRedoVideo,
  onEditMotion,
}: {
  videoUrl: string | null
  videoNodeId: string | null
  onRedoVideo?: () => void
  onEditMotion?: () => void
}) {
  if (!videoUrl) {
    return (
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-graphite-100">
          VIDEO
        </span>
        <span className="text-[10px] text-graphite-200">(not yet generated)</span>
      </div>
    )
  }

  return (
    <div className="mt-2 flex flex-col gap-1 group">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-cyan">
          VIDEO
        </span>
        {videoNodeId && (
          <span className="text-[9px] font-mono text-graphite-200 truncate">
            {videoNodeId.replace(/^shot_video:/, '')}
          </span>
        )}
      </div>
      <div className="relative aspect-video rounded border border-line-soft bg-graphite-400 overflow-hidden">
        <video
          src={videoUrl}
          controls
          preload="metadata"
          className="w-full h-full object-contain bg-black"
        />
        {(onRedoVideo || onEditMotion) && (
          <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {onEditMotion && (
              <button
                onClick={(e) => { e.stopPropagation(); onEditMotion() }}
                className="px-2 py-1 rounded bg-cyan text-background hover:bg-cyan/90 text-[10px] font-medium shadow-lg"
                title="Edit the motion directive and regenerate the video"
              >
                ✎ Motion
              </button>
            )}
            {onRedoVideo && (
              <button
                onClick={(e) => { e.stopPropagation(); onRedoVideo() }}
                className="px-2 py-1 rounded bg-graphite-300 text-foreground hover:bg-graphite-200 text-[10px] font-medium shadow-lg border border-line-strong"
                title="Regenerate the video with the same motion directive"
              >
                ↻ Video
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
