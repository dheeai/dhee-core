/**
 * Render-style anchor for shot-image-prompt LLM calls.
 *
 * Why this exists: `shot_composition_guide.md` (the SCALIST-era guide
 * that drives every shot_image_prompt) does NOT enforce the project's
 * Visual style as a prompt-leading anchor. Result (2026-05-19):
 * Soft Seinen's `project.json.style = "anime"`, world_style bible
 * said "cel-shaded edges", character refs came out anime via
 * character_image_guide's anchor — but shot prompts opened with
 * style-neutral clauses like "A wide overhead establishing shot of
 * Tokyo's night skyline, deep focus…" and Flux Klein then produced
 * photorealistic Tokyo skylines. The auto-appended styleConfig
 * suffix (', anime style, anime art…') is a weak signal against a
 * realism-leading opener.
 *
 * The fix is symmetric to character_image_guide's anchor: an
 * explicit instruction telling the LLM to OPEN every positive
 * prompt with the render-style anchor matching `project.style`,
 * plus the anti-modality negative tokens.
 *
 * This module is the pure source of truth for that mapping. The
 * executor injects the block into the shot_image_prompt user
 * message alongside the other context blocks; the guide
 * (shot_composition_guide.md) tells the LLM the rule.
 *
 * Pure — no I/O. Fully unit-testable.
 */

/** Coarse render-style buckets that share a vocabulary. */
export type RenderStyleKey =
  | 'live_action'      // cinematic_realism, photorealistic, cinematic, documentary
  | 'anime'            // anime, cel_shaded, japanese_animation
  | '3d_animation'     // pixar_style, stylized_3d, cgi_animation
  | 'stop_motion'      // claymation, puppet_animation
  | 'oil_painting'     // painterly, classical_painting
  | 'watercolor'       // watercolour, illustration
  | 'comic'            // comic_book, graphic_novel
  | 'fallback';        // unknown / missing — default to live-action

export interface RenderStyleAnchor {
  styleKey: RenderStyleKey;
  /** First-clause prose the LLM must place at the START of the positive prompt. */
  positiveAnchor: string;
  /** Tokens the LLM must include in the negative prompt. Joined with ", ". */
  negativeTokens: string[];
}

/**
 * Map a free-form `Visual style` value (read from project.json or the
 * project_constraints block) to its render-style bucket. Tolerant of
 * casing and underscore/space variants so user-typed values land in
 * the right bucket without surprises.
 */
export function classifyVisualStyle(visualStyle: string | null | undefined): RenderStyleKey {
  const v = (visualStyle ?? '').toLowerCase().trim().replace(/[-_\s]+/g, '_');
  if (!v) return 'fallback';

  if (
    v === 'anime' ||
    v === 'cel_shaded' ||
    v === 'celshaded' ||
    v === 'japanese_animation' ||
    v.includes('anime')
  ) return 'anime';

  if (
    v === '3d_animation' ||
    v === '3d' ||
    v === 'pixar' ||
    v === 'pixar_style' ||
    v === 'stylized_3d' ||
    v === 'cgi' ||
    v === 'cgi_animation'
  ) return '3d_animation';

  if (
    v === 'stop_motion' ||
    v === 'claymation' ||
    v === 'puppet_animation'
  ) return 'stop_motion';

  if (
    v === 'oil_painting' ||
    v === 'oilpainting' ||
    v === 'painterly' ||
    v === 'classical_painting'
  ) return 'oil_painting';

  if (
    v === 'watercolor' ||
    v === 'watercolour' ||
    v === 'illustration'
  ) return 'watercolor';

  if (
    v === 'comic' ||
    v === 'comic_book' ||
    v === 'graphic_novel'
  ) return 'comic';

  if (
    v === 'cinematic_realism' ||
    v === 'cinematic' ||
    v === 'photorealistic' ||
    v === 'realistic' ||
    v === 'documentary' ||
    v === 'live_action' ||
    v === 'photo'
  ) return 'live_action';

  return 'fallback';
}

const ANCHORS: Record<RenderStyleKey, { positiveAnchor: string; negativeTokens: string[] }> = {
  live_action: {
    positiveAnchor:
      'Photorealistic cinematic still, 85mm lens, sharp focus, natural skin texture and pores, film-grade color grade — ',
    negativeTokens: [
      'cartoon', 'anime', 'illustration', 'mascot', 'anthropomorphic animal',
      'cel-shaded', 'sticker art', '3D render', 'video game', 'cgi',
      'plastic skin', 'doll-like', 'chibi', 'painterly', 'watercolor',
    ],
  },
  anime: {
    positiveAnchor:
      'Hand-drawn anime cel, flat color planes, crisp ink line work, painted background, cel-edge rim light, anime hair highlights — ',
    negativeTokens: [
      'photorealistic', 'photograph', 'film grain', '35mm', '85mm lens',
      'lens flare', 'real human', 'live-action', '3D render', 'cgi',
      'plastic skin',
    ],
  },
  '3d_animation': {
    positiveAnchor:
      'Stylized 3D animated character render, smooth subsurface shading, soft rim light, Pixar-grade fidelity, painterly textures on background — ',
    negativeTokens: [
      'photorealistic', 'photograph', 'film grain', '35mm', 'lens flare',
      'real human', 'live-action', 'cartoon', 'cel-shaded', 'flat color planes',
    ],
  },
  stop_motion: {
    positiveAnchor:
      'Stop-motion animation frame, hand-sculpted clay character, visible thumbprint texture, set-built miniature environment with practical lighting — ',
    negativeTokens: [
      'photorealistic', 'live-action', 'cel-shaded', 'flat color planes',
      'CGI', '3D render',
    ],
  },
  oil_painting: {
    positiveAnchor:
      'Oil painting on canvas, visible brushwork, layered glazes, painterly skin tones, atmospheric perspective — ',
    negativeTokens: [
      'photorealistic photograph', '3D render', 'anime cel', 'flat color planes',
      'film grain', 'lens flare',
    ],
  },
  watercolor: {
    positiveAnchor:
      'Watercolor illustration on cold-press paper, soft pigment bleed, granulating washes, line work with bleed accents — ',
    negativeTokens: [
      'photorealistic photograph', '3D render', 'film grain', 'lens flare',
      'cel-shaded',
    ],
  },
  comic: {
    positiveAnchor:
      'Comic book panel, bold ink line work, halftone shading, flat saturated color fills, dynamic poses — ',
    negativeTokens: [
      'photorealistic photograph', 'film grain', '35mm', 'lens flare',
      'real human', '3D render',
    ],
  },
  fallback: {
    positiveAnchor:
      'Photorealistic cinematic still, 85mm lens, sharp focus, natural skin texture, film-grade color grade — ',
    negativeTokens: [
      'cartoon', 'anime', 'illustration', 'mascot', 'cel-shaded',
      '3D render', 'plastic skin', 'chibi',
    ],
  },
};

export function buildRenderStyleAnchor(visualStyle: string | null | undefined): RenderStyleAnchor {
  const styleKey = classifyVisualStyle(visualStyle);
  const a = ANCHORS[styleKey];
  return {
    styleKey,
    positiveAnchor: a.positiveAnchor,
    negativeTokens: a.negativeTokens,
  };
}

/**
 * Build the `<render_style_anchor>` block the executor injects into
 * the shot_image_prompt user message. The block carries the EXACT
 * anchor text the LLM is expected to lead its positive prompt with,
 * plus the negative tokens it must include — turning a vague
 * "match the project style" instruction into a copy-paste contract.
 *
 * Returns empty string when there is no project.style at all and we
 * want to fall through to the guide's general SCALIST guidance.
 * Otherwise always produces a block (fallback anchor for unknown
 * styles, since photorealistic-default is safer than no guidance).
 */
export function buildRenderStyleAnchorBlock(visualStyle: string | null | undefined): string {
  const trimmed = (visualStyle ?? '').trim();
  if (!trimmed) return '';
  const anchor = buildRenderStyleAnchor(trimmed);
  return (
    `\n\n<render_style_anchor>\n` +
    `Project Visual style: ${trimmed} (resolved bucket: ${anchor.styleKey})\n\n` +
    `MANDATORY positive-prompt opening clause (paste verbatim, then continue the prose):\n` +
    `  "${anchor.positiveAnchor}"\n\n` +
    `MANDATORY tokens to include in the negative prompt (comma-separated, in addition to your own avoid-list):\n` +
    `  ${anchor.negativeTokens.join(', ')}\n\n` +
    `Why this is mandatory: Flux Klein and Z-Image anchor most strongly on the prompt's leading tokens. ` +
    `A style-neutral opener (e.g. "A wide overhead shot of Tokyo's night skyline, deep focus…") will produce ` +
    `a photorealistic render even when the world style says "cel-shaded edges" — the anchor forces the model ` +
    `to commit to the project's rendering aesthetic from the first token.\n` +
    `</render_style_anchor>`
  );
}
