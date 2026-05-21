#!/bin/bash
# Lint guard: forbid "from image N" slot-binding instructions in active
# prompt files (templates + skills). Bug 9 — the canonical-refs / slot-
# manifest architecture lives in code (post-LLM manifest builder); the
# LLM should NEVER be taught to emit `from image N` tokens. When such an
# instruction creeps into a template/guide the LLM picks it up and
# produces prose-level slot tokens that clash with the manifest at the
# top of the image prompt — Klein then has competing slot directives and
# binds non-deterministically.
#
# This script grep-fails on any `from image \d+` in prompts/templates or
# prompts/skills (excluding archival notes / probe scripts). Run from
# pnpm: `pnpm lint:prompts`. Exit code 0 = clean, 1 = violation.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

# Active prompt areas the LLM reads. Excludes:
#   - autoresearch/ (research scratch — never sent to story LLM)
#   - probes/ (one-off audit prompts)
PATTERN='from image [0-9]'
SCAN_DIRS=(prompts/templates prompts/skills)
VIOLATIONS=$(grep -rEn "$PATTERN" "${SCAN_DIRS[@]}" 2>/dev/null || true)

if [ -n "$VIOLATIONS" ]; then
  echo "::error:: 'from image N' slot tokens found in active prompts." >&2
  echo "$VIOLATIONS" >&2
  echo >&2
  echo "Background: slot binding is the executor's job. The post-pass at" >&2
  echo "applyShotImageManifestPostPass prepends a 'Name from image N.' manifest" >&2
  echo "to every shot_image_prompt at render time. Teaching the LLM to emit" >&2
  echo "those tokens in prose creates competing slot directives — Klein binds" >&2
  echo "non-deterministically. Strip the instruction; let the manifest handle it." >&2
  exit 1
fi
echo "prompts/{templates,skills}: no 'from image N' slot tokens found. OK"
exit 0
