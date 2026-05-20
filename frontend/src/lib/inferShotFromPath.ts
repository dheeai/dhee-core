/**
 * Pure parser for dhee-style asset filenames. Used by MediaWithOverlay
 * to derive the scene/shot/frame triple needed for the Edit and Redo
 * overlay buttons. Returns null for filenames that don't match the
 * grammar (orphan/legacy entries, character/setting refs, final video).
 *
 * Image grammar:
 *   s<N>shot<M>_(first|last|mid)_frame_<provider>_<id>.png|jpg|jpeg|webp
 * Video grammar:
 *   s<N>shot<M>_<provider>_<id>.mp4|webm|mov
 *
 * Path is treated as a string — only the basename matters.
 */
export interface InferredShot {
  scene: number
  shot: number
  frame: 'first_frame' | 'last_frame' | 'mid_frame' | null
  isVideo: boolean
}

const FRAME_RE = /^s(\d+)shot(\d+)_(first_frame|last_frame|mid_frame)_.+\.(png|jpg|jpeg|webp)$/i
const VIDEO_RE = /^s(\d+)shot(\d+)_.+\.(mp4|webm|mov)$/i

export function inferShotFromPath(path: string): InferredShot | null {
  if (!path) return null
  const file = path.split('/').pop() ?? path
  let m = FRAME_RE.exec(file)
  if (m) {
    return {
      scene: parseInt(m[1], 10),
      shot: parseInt(m[2], 10),
      frame: m[3].toLowerCase() as 'first_frame' | 'last_frame' | 'mid_frame',
      isVideo: false,
    }
  }
  m = VIDEO_RE.exec(file)
  if (m) {
    return {
      scene: parseInt(m[1], 10),
      shot: parseInt(m[2], 10),
      frame: null,
      isVideo: true,
    }
  }
  return null
}
