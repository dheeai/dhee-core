# Production control from Codex and Desktop

Every production feature should expose a Core operation that Codex can call, as well as a Desktop interaction. Desktop GPU catalog and saved-job controls now call the same `executeProductionRequest` service as the structured CLI. This is the adapter boundary for a future Dhee MCP server; no new MCP server is installed or claimed here.

Build Core, then invoke `node dist/control/cli.js --request /absolute/path/request.json`. The packaged executable is `dhee-control`. Source development can use `pnpm control --request /absolute/path/request.json`. With no arguments it reads one JSON request from stdin. Use a request file for prompts and paths rather than shell interpolation. Requests are limited to 1 MiB; references remain local file paths. Exactly one JSON response is written to stdout; run progress goes to stderr. Failure returns exit code 1. Ctrl-C/SIGTERM is passed to the running pipeline and GPU cancellation logic.

The JS API is `executeProductionRequest(request, {signal, log})` from `dhee-core/control`. A successful transport response can describe a paused run: inspect `result.gatedAfter`, `result.budgetExceeded` and `result.finalVideoAbs`. Never interpret `ok: true` as a completed video by itself.

Status includes `pauseHints` for durable review/budget pauses. These legacy markers are project-wide, explicitly labelled as such; they are not proof that a particular branch is complete. Packaged Core resolves its bundled defaults from `dist/bundles` after environment, user and source overrides.

## Request examples

```json
{"action":"gpu.catalog","endpoint":"http://YOUR-GATEWAY:9000/mcp"}
```

The endpoint can be omitted if `DHEE_GPU_QUEUE_URL` is set in the CLI environment. A separate Codex process does not inherit a running Desktop process's settings automatically. Use the same explicit endpoint or set the variable; accepted jobs retain their saved endpoint.

```json
{"action":"project.status","projectDir":"/absolute/project","branchId":"main"}
```

```json
{"action":"gpu.jobs","projectDir":"/absolute/project","operation":"list"}
```

For `refresh`, `cancel` or `download`, also supply the saved record's `id` (64-character SHA-256 identifier). These use the same durable ledger as Desktop. Summaries omit prompts, endpoint fields and remote output lists. Detailed operation errors can include gateway diagnostics.

```json
{"action":"review.enable","projectDir":"/absolute/project"}
```

Enable the three creative gates before automated production. The control API deliberately has no disable-gates or raw GPU-submit operation. Use the existing bundle workflow and registered `gpu.queue` runner so generation follows the walker and its review checks.

```json
{"action":"project.run","projectDir":"/absolute/project","branchId":"main","stopAt":"scene_clip"}
```

`stopAt` is optional. Optional `runOnly` scopes the walk using the engine's existing semantics. Running a full project can dispatch generation once the applicable creative approvals exist; catalog/status/review reads do not submit jobs. Resume with the same request after a review decision. A new GPU attempt must be explicitly configured; retrying a saved attempt never creates another job automatically.

```json
{"action":"review.read","projectDir":"/absolute/project","branchId":"main","gate":"storyboard"}
```

The other gates are `references` and `rough-cut`. Read returns authoritative full review scope, frozen preview paths and a content fingerprint. Show those exact previews to the user. Then record the user's explicit decision:

```json
{"action":"review.decide","projectDir":"/absolute/project","branchId":"main","gate":"storyboard","expectedFingerprint":"COPY_FROM_REVIEW_READ","decision":"approved","humanAcknowledged":true,"notes":"User approved these previews."}
```

Use `changes-requested` for requested revisions. `humanAcknowledged` is the caller's explicit assertion, not authentication of a human. Codex must never set it on its own behalf or infer creative approval from “continue.” Fingerprints are rechecked; stale or incomplete artifacts cannot be approved. Server scope resolution prevents approving a partial selection.

## Prepare one scene or reference

Desktop's Production view now includes **Prepare a GPU scene or reference**. Select a target, explicitly load the gateway catalog, choose a workflow and fill its declared inputs. Saving persists a branch-specific runner selection; it does not upload files or submit a job. Desktop and Codex use the same Core validation.

```json
{"action":"gpu.targets","projectDir":"/absolute/project","branchId":"main"}
```

Use the returned target's `selectionId` as `expectedSelectionId` (including `null` for an unmodified target). Copy the exact workflow version from `gpu.catalog`:

```json
{"action":"gpu.prepare","projectDir":"/absolute/project","branchId":"main","nodeId":"scene_clip","itemId":"scene_01","requestId":"scene-01-attempt-001","expectedSelectionId":null,"endpoint":"http://YOUR-GATEWAY:9000/mcp","workflow":"COPY_WORKFLOW_NAME","workflowVersion":"COPY_VERSION","inputs":{"prompt":"An approved scene description"},"primaryOutput":0}
```

`inputs` must match the chosen workflow's schema. File inputs may be project-confined local paths, existing upload handles or HTTP URLs. File lists preserve reference order; Desktop accepts one path per line. Required random-default seeds can be left blank and are materialized by Core. Inputs here are literal values, not upstream field mappings. The existing bundle still declares dependencies; preparation does not rewrite it.

Retry the **identical request with the same requestId** after a lost response. A changed request needs a fresh requestId and current selectionId. A superseded retry returns `active:false` and does not restore the older selection. Completed/running targets, adaptive chunk targets, stale selections and unresolved prior queue attempts are rejected. Even an attempt declared directly in the bundle is protected. Files are checked at preparation and their bytes are snapshotted at dispatch.

After saving, **Run saved attempt** runs exactly the selected scene or reference. Unsaved form edits must be saved first. Codex uses the same operation:

```json
{"action":"gpu.run","projectDir":"/absolute/project","branchId":"main","nodeId":"scene_clip","itemId":"scene_01","expectedSelectionId":"COPY_CURRENT_SELECTION_ID"}
```

This operation requires review policy enabled and checks the saved selection again inside the project walk lock. It never creates a new attempt or generates missing prerequisites. All ancestor instances must be complete; previous-shot self chains also require earlier planned shots complete. These checks are deliberately conservative. Completed earlier shots remain available as runner inputs, while dispatch is filtered to one instance. Adaptive chunk targets are still unsupported.

Inspect `result.gatedAfter`, `result.budgetExceeded` and `result.selectedOutput`: a creative pause is not completion, and a selected output is not a finished video. Goal targets still require rough-cut review. Approval always covers the full authoritative review scope. Automated review-loop retries are disabled for exact runs. Existing `project.run`/`runOnly` semantics are unchanged and may execute siblings.

After an interruption, retry the same saved selection to recover the durable attempt. Desktop allows this even if its stale status says `in_progress`; the project lock rejects a genuinely active walk. GPU Jobs provides refresh/cancellation; the CLI forwards Ctrl-C/SIGTERM. Unknown dispatch outcomes still fail closed until an existing job is explicitly reconciled as described below. Existing project-wide pause hints are retained on selected-output success because a single scene does not establish whole-project readiness.

Preparation uses the project walk lock. An empty/unreadable lock is conservatively treated as held because another process may be writing its owner record. If a crash leaves such a lock, investigate whether a walker is active before manual recovery; preparation never deletes that uncertain lock automatically.

## Recover an uncertain submission

If dispatch loses its response, Dhee retains an `unknown` (or interrupted `submitting`) attempt and never retries the submission automatically. Find the original job ID in your own gateway history. Desktop's **GPU queue** panel now offers **Inspect existing job**, followed by **Link existing job**. Inspection uses the original saved gateway, not current settings, and does not mutate the attempt or start a render.

Codex uses the same controls:

```json
{"action":"gpu.recovery.inspect","projectDir":"/absolute/project","id":"COPY_SAVED_RECORD_SHA256_ID","jobId":"COPY_EXISTING_GATEWAY_JOB_ID"}
```

The response includes `result.recovery`, with the saved workflow/version/time/wire inputs, reported remote evidence, and an inspection fingerprint. `evidence: "matched"` means reported workflow and inputs match; identical inputs could still belong to a different render. `evidence: "incomplete"` means the gateway omitted workflow or input evidence, so Dhee cannot prove the association. Compare the actual original submission in gateway history. Any reported mismatch (including reference order) blocks linking.

Only after the user explicitly verifies the association:

```json
{"action":"gpu.recovery.link","projectDir":"/absolute/project","id":"COPY_SAVED_RECORD_SHA256_ID","jobId":"COPY_EXISTING_GATEWAY_JOB_ID","expectedFingerprint":"COPY_INSPECTION_FINGERPRINT","humanAcknowledged":true}
```

Codex must not infer this acknowledgement from “continue,” matching inputs, or a likely time. The flag is a caller assertion, not authentication of a human. If evidence is insufficient to verify the same submission, leave the attempt unresolved; do not create another render automatically.

Linking re-fetches evidence under the queue lock, rejects stale identity evidence or a job linked to another attempt in this project, and records the acknowledgement durably. Ordinary state progression does not invalidate inspection. The same confirmed request is safe to retry after a lost reply. No submit/cancel/download occurs during linking. The original attempt key, fingerprint, source references, uploaded inputs and catalog snapshot are retained. Afterward use **Run saved attempt** / `gpu.run` to resume normal processing under creative approvals. Recovery alone does not mark a scene complete or approve output.

Current limit: no global cross-project ownership index; duplicate association checks cover this project's ledger. History discovery remains via the gateway's own tools; this UI takes an explicit job ID. The live gateway was unreachable during this implementation's read-only history check, so live reconciliation remains unverified.

## Existing and remaining controls

Project creation, bundles, artifact inspection/edits, invalidation/regeneration and cross-process stop are already available through `pnpm dhee` in the source checkout. Those older commands retain their existing behavior; the new production command does not retroactively enforce review policy on every older entry point. Keep policy enabled for this production workflow. Run `pnpm dhee --help` for that interface.

The new structured interface covers catalog/jobs/targets/preparation/status/reviews/run. Final assembly/quality checks and the bounded live Brilliant Care baseline remain in the implementation plan. They must gain shared operations and command tests as they are built. Do not claim the complete video workflow or actual RTX 5090 rendering is verified from fixture tests.

API declaration files are not emitted by the current Core build (`dts: false`); JavaScript/CLI consumers work, while published TypeScript declarations remain a follow-up.

## Selected scene and voice technical checks

`media.check` inspects the current completed video/audio selection from the authoritative branch plan. Desktop exposes the same operation in Production → Check scene and voice media. Use `gpu.targets` to enumerate targets first.

```json
{"action":"media.check","projectDir":"/absolute/project","branchId":"main","nodeId":"scene_clip","itemId":"scene_1","expectedAudio":true,"expectedDurationSec":5}
```

`expectedAudio` defaults false (audio targets always require audio); duration is optional. The response includes selected version/path, SHA-256/bytes, timestamp, stream information, complete decode result, duration tolerance (0.25 seconds or 3%, whichever is larger), first-audio-track peak/mean and timestamped silence intervals. `technicalStatus` is `passed`, `issues`, `unavailable`, or `review`. Silence below -50 dB for 0.5 seconds and peaks near 0 dBFS are review warnings, not proof of missing speech or clipping. No delivery loudness target is applied.

Checks use a temporary byte snapshot, restrict media formats/protocols, hold the project operation lock, and recheck source hash and selected version before returning. Limit: 2 GiB, 60 seconds per subprocess, not a 60-second overall deadline. Unavailable binaries/timeouts never pass. Results are point-in-time, not persisted approvals; recheck after edits. No generation, export, repair, review decision or RTX queue operation occurs. Semantic scene correctness, words, speaker identity, pronunciation, naturalness and sync remain human checks. Desktop currently shows silence counts; interval timestamps remain available through the structured control response.

## Assemble a completed local stage

`assembly.targets` lists current branch video instances whose effective runner is `ffmpeg.concat`, `ffmpeg.replace_audio` or `ffmpeg.normalize`. `assembly.run` runs exactly one listed instance, preserving configured clip ordering/transitions and requiring all ancestors to be complete. It cannot generate missing prerequisites or dispatch a swapped GPU runner. Pass the listed `selectionId` as `expectedSelectionId`, including `null` for an unswapped bundle default.

```json
{"action":"assembly.targets","projectDir":"/absolute/project","branchId":"main"}
{"action":"assembly.run","projectDir":"/absolute/project","branchId":"main","nodeId":"final_video","expectedSelectionId":null}
```

Required creative reviews remain enabled and enforced. Runner tool and selection are checked under the walker lock and again before dispatch. The result may pause at `gatedAfter` or budget, or return `selectedOutput`; completed output is reused, not regenerated. Desktop exposes the same operations in Production → Assemble completed clips. Afterwards reload media and run `media.check` on the assembled file. Neither successful assembly nor technical checks constitute final-delivery approval. Other assembly runners, persisted delivery QC, production-scale concat timeouts/cancellation and full brief-to-video live acceptance remain follow-up work. Existing project-wide pause hints can remain stale after successful exact runs; the explicit operation response is authoritative for that operation.


### Preserve selected narration

A bundle can declare a local `ffmpeg.replace_audio` stage with picture and approved narration as explicit upstream dependencies:

```json
{
  "id": "narrated_clip",
  "kind": "stage",
  "inputs": [{"from":"scene_clip","usage":"input"},{"from":"voice_reference","usage":"input"}],
  "outputs": {"format":"video","pattern":"narrated_clip.mp4"},
  "runner": {"tool":"ffmpeg.replace_audio","config":{
    "videoInput":"scene_clip","audioInput":"voice_reference",
    "outputPath":"narrated_clip.mp4","offsetSec":0
  }}
}
```

Include this stage in the final video's dependency chain and declare the runner in the bundle's dependencies. `videoInput` and `audioInput` are resolved upstream keys, not arbitrary file paths. Run with `assembly.run` and the current listed selection ID. The standard walker records dependencies and a versioned completion with input SHA-256 hashes, placement, sample rate and output encoding.

This first implementation accepts a single video stream and a single PCM 16-bit narration stream. It removes **all** generated video audio, including background effects. No mixing, gain changes, narration generation or silent narration truncation occurs. An explicit nonnegative offset is rounded to the nearest sample. Silence pads the rest of the video; narration that does not fit is rejected. MOV uses PCM 16-bit audio, preserving samples; MP4 encodes AAC at 192 kbps and is not byte/sample-identical. Video packets are copied. Nonzero or unavailable video start timestamps are rejected; normalize them explicitly first. The output parent must already exist within the project; inputs must be regular project files no larger than 512 MiB each. Commands have a 120-second timeout and accept cancellation.

Audio similarity verification is currently regression/live acceptance evidence, not a persisted automatic delivery gate. Check exported media and listen before approving. The runner does not establish that the selected recording was creatively approved; production review gates remain authoritative. Native Desktop end-to-end acceptance and a narration/timing editor remain follow-up work.

### Scene intent checks before GPU submission

`scene.check` compares explicit requirements against **recorded observations**. It does not inspect an image or interpret free-form motion text itself. Codex or a reviewer supplies the observations and supporting evidence. Missing facts and mismatches return `status: blocked`; consistent facts never grant creative approval.

```json
{"action":"scene.check","sceneIntent":{
  "requirements":[{"id":"doctor-posture","description":"Doctor stays seated","expected":"seated","sources":["motion"]}],
  "sources":[{"id":"motion","inputKey":"prompt","sha256":"<sha256-of-JSON-stringified-prompt>","evidence":"Read the exact motion prompt","facts":{"doctor-posture":"seated"}}]
}}
```

Supply the same optional `sceneIntent` in `gpu.prepare`. It is saved in the selected runner configuration, included in its preparation fingerprint, and checked against inputs at preparation and immediately before upload/submission. A changed prompt/reference requires fresh observations. Local media use byte SHA-256; file-list inputs use SHA-256 of their JSON array of `{localPath,sha256,bytes}` identities in order. Other values use SHA-256 of their JSON representation. Use exported `sceneInputDigest` internally to avoid divergent serialization. Checked attempts reject remote URLs/upload handles, whose current bytes cannot be verified locally.

This is currently opt-in per attempt. Legacy attempts remain unchecked and Desktop says so. Desktop displays saved requirements and observation evidence; saving workflow edits retains the contract, so changed inputs are rejected as stale. Contract authoring currently uses the shared control request; an editor, automatic visual/transcript assessment, and a project-wide mandatory policy remain follow-up work. Only requirements and sources actually listed are covered; do not describe a sparse contract as a full scene review.

### Explicit clip normalization

`ffmpeg.normalize` is available through `assembly.targets` and the pinned `assembly.run` operation. Declare it as a video stage with an upstream video input and include `ffmpeg.normalize` in bundle runner dependencies. Its required configuration is:

```json
{"videoInput":"scene_clip","outputPath":"normalized_clip.mp4","durationSec":4,"width":1280,"height":720,"fps":24,"durationPolicy":"trim","framing":"crop","audio":"drop"}
```

`trim` permits removing the tail, `pad` permits extending with a frozen final frame, and `reject` refuses a duration mismatch. The requested duration must be a whole number of frames. `crop` scales to cover then crops centrally; `fit` adds black bars. These are explicit choices, not automatic judgments about story-critical pixels or timing. `drop` removes all source audio, appropriate before narration replacement; `preserve` requires one audio stream aligned to the video start, re-encodes AAC and trims/pads it to the chosen duration. Video timestamps are reset to zero and output is H.264/yuv420p MP4.

The runner records the source SHA-256, source duration and exact configuration with completion metadata. Input is copied to a temporary snapshot; changed source bytes abort publication. Output stays inside the project, cannot replace its source, and its parent directory must exist. Limits: 512 MiB source, 300 seconds, even dimensions up to4096, integer frame rate up to60, 120-second cancellable subprocesses. Native policy-editing/preview controls remain follow-up work; Desktop currently executes the configured stage and explains its policies. A normalized output still needs media checks and creative review.

Normalization currently rejects declared non-square pixel aspect ratios rather than risking distortion. Both normalization and narration composition publish with atomic no-clobber semantics: an existing destination is never overwritten (including case-only source aliases). Use a new path or normal version/invalidation flow. Known deferred edge: padding a single-frame high-fps source while downsampling extremely far may fail explicitly; ordinary generated clip paths are covered.

## Desktop ownership update — 2 November 2026

The Desktop repository now owns `dhee-runner-production`: normalization and narration replacement are npm-discovered extensions, not Core built-ins. Desktop IPC and its headless CLI call the extension's production adapter, which delegates shared execution/review/queue operations to this Core service. Core does not import Desktop source. Standalone Core consumers must install/configure the extension to execute its two tools. Desktop supplies runner roots as a JSON array in `DHEE_NODE_MODULES_DIRS`; Core also retains legacy delimited inputs.

Required Core execution/review safeguards remain here by explicit user direction; this is not a claim of compatibility with unchanged upstream75ec0b0. The Desktop adapter is not yet an installed MCP server.

## Core-owned MCP

Core owns the MCP protocol adapter and shared controller. Build Core and launch `dhee-core-mcp`, or `node /absolute/dhee-core/dist/mcp/cli.js`. Public library exports are `dhee-core/mcp` and `dhee-core/mcp/stdio`; the latter is a dedicated-process stdio entry that redirects console output and terminates the process on shutdown. Tool: `dhee_production_control`, arguments `{ "request": { "action": "project.status", "projectDir": "/absolute/project" } }`. Discover action schemas with `tools/list`.

Desktop supplies the UI and optional production runner extension. Set `DHEE_NODE_MODULES_DIRS` to a JSON array of installation roots (for a checkout, the Desktop `packages` directory) and `DHEE_USER_BUNDLES_DIR` to your bundles directory. Core does not import Desktop. Desktop's old MCP binary only configures runner discovery and forwards to this server. All Desktop control actions delegate to Core.

Requests are bounded to 1 MiB and transport buffering to 2 MiB. Cancellation/disconnect aborts active controller signals and drains cleanup for a bounded period. Use adequate client timeouts for media/GPU operations; inspect durable jobs before retrying interrupted work. A successful tool call can pause at a review gate and never implies creative approval. The three human approval points remain script/storyboard, character/voice references, and rough cut.
