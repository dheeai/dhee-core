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

This panel intentionally has no Generate button yet. Exact single-instance execution is the next step: do not use a bare collection node id to claim that only one scene will run. The existing run interface can include sibling instances according to walker semantics. Creative approvals remain required before execution.

Preparation uses the project walk lock. An empty/unreadable lock is conservatively treated as held because another process may be writing its owner record. If a crash leaves such a lock, investigate whether a walker is active before manual recovery; preparation never deletes that uncertain lock automatically.

## Existing and remaining controls

Project creation, bundles, artifact inspection/edits, invalidation/regeneration and cross-process stop are already available through `pnpm dhee` in the source checkout. Those older commands retain their existing behavior; the new production command does not retroactively enforce review policy on every older entry point. Keep policy enabled for this production workflow. Run `pnpm dhee --help` for that interface.

The new structured interface covers catalog/jobs/targets/preparation/status/reviews/run. Exact single-instance execution, guided unknown-job reconciliation, and final assembly/quality checks remain in the implementation plan. They must gain shared operations and command tests as they are built. Do not claim the complete video workflow or actual RTX 5090 rendering is verified from fixture tests.

API declaration files are not emitted by the current Core build (`dts: false`); JavaScript/CLI consumers work, while published TypeScript declarations remain a follow-up.
