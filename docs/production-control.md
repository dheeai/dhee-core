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

## Existing and remaining controls

Project creation, bundles, artifact inspection/edits, invalidation/regeneration and cross-process stop are already available through `pnpm dhee` in the source checkout. Those older commands retain their existing behavior; the new production command does not retroactively enforce review policy on every older entry point. Keep policy enabled for this production workflow. Run `pnpm dhee --help` for that interface.

The new structured interface covers catalog/jobs/status/reviews/run. Desktop scene workflow/input selection and branch-specific attempt creation, guided unknown-job reconciliation, and final assembly/quality checks remain in the implementation plan. They must gain shared operations and command tests as they are built. Do not claim the complete video workflow or actual RTX 5090 rendering is verified from fixture tests.

API declaration files are not emitted by the current Core build (`dts: false`); JavaScript/CLI consumers work, while published TypeScript declarations remain a follow-up.
