# Custom ComfyUI workflow integration (desktop + pi-agent)

**Status:** in progress (branch `feat/comfyui-workflow-integration` on both repos)

## Goal

Let users add their own ComfyUI workflows by uploading the JSON in the pi-agent chat. Pi-agent validates, runs LLM analysis to discover configurable variables, presents them, and saves a manifest after the user confirms (or refines via chat). Settings → Workflows tab provides ongoing management (list, edit defaults, delete, set active).

The desktop is a green-field port of an existing dhee-core feature (`frontend/src/components/WorkflowManager.tsx`, REST endpoints in `src/server/routes.ts`, `WorkflowModeRegistry`). We don't reimplement the registry, parser, or LLM analyzer — we expose them as pi-agent tools and IPC handlers.

## Architecture

**The "sub-agent" is a skill + tools, not a separate process.**
Pi-agent wraps `@mariozechner/pi-coding-agent`, which loads markdown skills from `prompts/skills/` into the LLM context at session init. Skills shape behavior; tools do work.

- New skill: `prompts/skills/comfyui-workflow-integration.md` — flow rules, output format, fallbacks.
- New tools: `src/agent/pi/tools/comfyui/{validate,analyze,save,list,update,delete}.ts` — six small `defineTool()` wrappers around `WorkflowParser`, `WorkflowLoader`, `WorkflowModeRegistry`.

**Attachment system is generic from day one.**
Even though v1 only handles `comfy_workflow`, the contract supports text/image/video/audio attachments. Pi-agent dispatches by `kind`. Adding a new kind = new skill + new handler, no architectural changes.

```typescript
type AttachmentKind = 'comfy_workflow' | 'text' | 'image' | 'video' | 'audio';

interface Attachment {
  id: string;                       // client-generated
  kind: AttachmentKind;
  path: string;                     // local file path
  name: string;                     // display name
  mimeType?: string;
  size?: number;
  meta?: Record<string, unknown>;   // kind-specific
}
```

`RunTaskRequest` gains an optional `attachments?: Attachment[]`.

## End-to-end UX

```
[1] User clicks 📎 in chat, picks workflow.json (filter: *.json)
[2] ChatInput shows a chip "📎 my-workflow.json"
[3] User types "add this workflow", sends
[4] Pi-agent (with comfyui skill loaded) detects JSON attachment
       → dhee_validate_comfy_workflow(path)
       → if not ComfyUI shape, replies why and stops
[5] dhee_analyze_comfy_workflow(path)
       → LLM analysis returns suggested name, pipeline, variables, defaults, LoRA keywords
[6] Pi-agent presents in chat as a markdown table:
       | Variable | Node | Default | Required |
       and asks: "Does this look right? Want to expose anything else, or change defaults?"
[7] User chats freely:
       - "make denoise configurable, default 0.85"
       - "rename it to 'My Cinematic'"
       - "looks good, save it"
[8] On confirmation: dhee_save_comfy_workflow(manifest)
       → writes {id}.json + {id}.manifest.json under workflows/user/
       → registry.refresh()
[9] Pi-agent: "Saved as 'My Cinematic'. It's now available."
[10] Settings → Workflows tab shows it.
```

## Phased implementation

| Phase | Repo | Goal |
|---|---|---|
| 0 | both | Branch + plan doc |
| 1 | dhee-core | Export APIs from `manager`, add 6 tools, add skill, tests |
| 2 | dhee-desktop | IPC bridge: `window.dhee.workflows.*` |
| 3 | dhee-desktop | Generic attachment system + chat upload UI |
| 4 | dhee-desktop | Settings → Workflows tab |
| 5 | both | Skill prompt iteration (the conversational quality) |
| 6 | both | E2E tests |

## Design decisions (locked in)

1. **Attachment shape:** structured `attachments[]` on `RunTaskRequest`, generic across kinds.
2. **Staging:** uploaded JSONs land in `userData/workflows/.staging/{tmpId}.json`; promoted to `workflows/user/{finalId}.json` only on save.
3. **Workflow naming:** LLM proposes, user can override in chat.
4. **Active scope:** one override per pipeline, global per install (matches current model).
5. **"Add Workflow" in Settings tab:** opens chat with prefilled message and file picker — one canonical flow.
6. **Edit flow:** defaults editable on a form; structural re-mapping requires a chat re-analysis.
7. **Conflict on save:** pi-agent prompts to confirm overwrite or rename.
8. **Validation:** strict — reject if not ComfyUI LiteGraph or API format. No repair.

## Files

### dhee-core (Add)
- `prompts/skills/comfyui-workflow-integration.md`
- `src/agent/pi/tools/comfyui/{validateWorkflow,analyzeWorkflow,saveWorkflow,listWorkflows,updateWorkflow,deleteWorkflow,index}.ts`
- `src/services/providers/workflowsRoot.ts` — `setWorkflowsRoot()` indirection
- `tests/unit/agent/comfyuiWorkflowTools.test.ts`
- `tests/unit/agent/comfyuiSkillFlow.test.ts`

### dhee-core (Modify)
- `src/agent/pi/tools/index.ts` — register new tools
- `src/server/manager.ts` — re-export `WorkflowModeRegistry`, `parseWorkflow`, `analyzeWorkflowWithLLM`, `setWorkflowsRoot`
- `src/services/providers/WorkflowModeRegistry.ts` — honor `setWorkflowsRoot()`, throw if set after singleton init
- `src/server/routes.ts` — refactor handlers to call shared helper functions (single source of truth with the tools)

### dhee-desktop (Add)
- `src/main/handlers/workflowsBridge.ts` (or fold into `dheeIpcBridge.ts`)
- `src/renderer/components/SettingsPanel/WorkflowsTab.tsx` + test
- `src/renderer/components/chat/ChatInput/AttachmentChip.tsx`
- `src/shared/attachmentTypes.ts` — generic Attachment type

### dhee-desktop (Modify)
- `src/main/main.ts` — `setWorkflowsRoot(...)` early; `project:select-attachment` IPC
- `src/main/preload.ts` — `projectBridge.selectAttachment`, `dheeBridge.workflows`
- `src/main/dheeIpcBridge.ts` — workflows handlers
- `src/main/dheeCoreManager.ts` — call `setWorkflowsRoot` after dhee-core loads
- `src/shared/dheeIpc.ts` — types for workflows IPC + `RunTaskRequest.attachments`
- `src/renderer/components/SettingsPanel/SettingsPanel.tsx` — `'workflows'` tab
- `src/renderer/components/chat/ChatInput/ChatInput.tsx` — 📎 button, attachment state
- `src/renderer/components/chat/ChatPanelEmbedded/ChatPanelEmbedded.tsx` — forward attachments
- `src/renderer/types/chat.ts` — extend message/request types

## Risks

- **Skill prompt quality is UX quality.** First cut will need 1–2 dogfooding iterations.
- **Registry singleton init order.** `setWorkflowsRoot()` must be called before first registry access. Will throw loudly if violated.
- **Two paths to same data** (HTTP routes + pi-agent tools). Single source of truth via shared helpers — `routes.ts` will be refactored to call them.
- **LLM unavailable** (offline / no key). Skill tells pi-agent to fall back to manual mapping — no extra code, just prompt guidance.

## Estimated effort

5–7 dev-days.
