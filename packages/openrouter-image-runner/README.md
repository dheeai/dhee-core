# `@dhee/openrouter-image-runner`

Apache-2.0, SDK-only Dhee runner for OpenRouter image generation.

This runner imports only `@dhee/runner-sdk` from Dhee. It does not import
AGPL engine internals.

## Configuration

Set these values in the environment of the Dhee process:

```bash
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_IMAGE_MODEL=google/gemini-2.5-flash-image
OPENROUTER_HTTP_REFERER=
OPENROUTER_APP_TITLE=Dhee
```

The model can also be set per node with `runner.config.model`; that value wins
over `OPENROUTER_IMAGE_MODEL`. Image generation should be treated as a paid API
path unless the selected model clearly documents a free tier.

Example node runner config:

```json
{
  "tool": "openrouter.image",
  "config": {
    "prompt": "A cinematic still of a rain-soaked neon street",
    "model": "google/gemini-2.5-flash-image",
    "aspectRatio": "16:9",
    "size": "1K"
  }
}
```

The Dhee walker injects `outputPath` from the bundle output pattern before the
runner executes.
