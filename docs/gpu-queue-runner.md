# Shared GPU queue runner

`gpu.queue` runs a selected catalog workflow through the shared MCP gateway. It does not contact ComfyUI directly. Desktop sets `DHEE_GPU_QUEUE_URL` from Settings → Workflows. Standalone hosts can set that variable or an explicit runner `endpoint`.

Declare `"gpu.queue": "^0.1.0"` in `dependencies.runners`. A stage node can use:

```json
{
  "id": "scene_clip",
  "kind": "stage",
  "inputs": [{ "from": "scene_prompt", "usage": "input" }],
  "outputs": { "format": "video", "pattern": "renders/scene.mp4" },
  "runner": {
    "tool": "gpu.queue",
    "config": {
      "workflow": "SELECT_FROM_CATALOG",
      "workflowVersion": "SELECTED_CATALOG_VERSION",
      "attemptKey": "main-scene-001-attempt-001",
      "inputMap": { "prompt": "scene_prompt" },
      "inputs": { "refs": ["references/character.png"] },
      "primaryOutput": 0,
      "timeoutSeconds": 1800
    }
  }
}
```

This is a shape example, not a ready-to-submit production workflow. Input names and types must match the selected catalog entry. The walker supplies `outputPath` from `outputs.pattern`; direct callers must provide it. `inputMap` maps one upstream value to one gateway field without implicit coercion. For file lists, supply an ordered array; scope-all maps must be explicitly converted by the caller.

## Attempt identity and recovery

An attempt key must be stable across retries and new for an intentional regeneration. Callers must include branch identity when creating keys. Core additionally scopes it to node and collection item. Reusing a key with different inputs or workflow version fails closed. A future Desktop generation action will own creating and persisting these keys.

Core validates the catalog schema before upload, materializes a stable seed, snapshots local reference bytes, and records ordered reference hashes separately from uploaded handles. The ledger stores the selected schema/version and wire inputs. Existing attempts retain their original endpoint even if Desktop settings change. A saved job resumes without uploading or submitting again. Unknown dispatch outcomes stop; guided gateway-history reconciliation is still pending.

Version checking is a client-side preflight. The gateway dispatch API accepts a workflow name, not a version constraint; this cannot guarantee server-side version pinning if the catalog changes between preflight and dispatch. Availability marked `unchecked` is not proof of generation quality.

## Files, cancellation and limits

Local references must be inside the project, with supported image/video/audio extensions. Each reference is limited to 64 MiB and the total in-memory snapshot to 128 MiB. HTTP(S) URLs and existing upload handles pass through; unlike local snapshots, their remote content is not hashed. Data URIs must first be saved locally.

All remote outputs are downloaded into the project ledger with checksums before success. The selected primary output is copied to the node output path; other outputs remain available in the result and ledger. The primary extension must match the destination. Retrieval proves byte integrity, not valid media decoding or visual/audio quality. Output downloads use the existing same-origin, no-redirect, 2 GiB/file and 120-second bounds.

A wait timeout leaves the accepted job available to resume. An explicit abort requests gateway cancellation when an accepted id is known; cancellation remains unconfirmed until status is refreshed. An interrupted dispatch with no id is never automatically resubmitted.

## Local verification

Tests use injected gateway fixtures and exercise real input validation, uploads, durable storage, downloads and the DAG walker. No live GPU generation is included. Generation selection UI, guided unknown-job reconciliation and the small actual Brilliant Care acceptance render remain later steps.
