# React Frontend Migration

## Done
- [x] Vite + React 19 + Tailwind CSS 4 + TypeScript scaffold
- [x] dhee-website design system (dark theme, cyan/green accents, glassmorphic panels, aurora glow)
- [x] State management (context + useReducer)
- [x] WebSocket hook with auto-reconnect + exponential backoff
- [x] Header, Sidebar, ChatTimeline, ToolCallCard, TaskInput components
- [x] WorkflowManager modal with view switching (list/wizard/test)
- [x] ProviderSettings modal
- [x] Custom ProjectSelector dropdown
- [x] ErrorBoundary
- [x] Custom Dropdown component (replaces all native selects)
- [x] /command system with autocomplete (/help, /new, /workflows, /providers, /reset, /select, /auto, /parallel, /serial)
- [x] Inline project creation wizard (template/style/duration with AI-generated preview images)
- [x] Server integration (serves React build from frontend/dist/)
- [x] 59 unit tests passing (Vitest)
- [x] 13 E2E tests (Playwright)

## Pending
- [ ] Markdown rendering in chat messages (currently raw text)
- [ ] Lightbox for asset images (click to enlarge)
- [ ] Drag-drop file upload to chat
- [ ] Settings persistence (provider config, parallel mode)
- [ ] Responsive/mobile layout
- [ ] Remove old inline SPA (webui.ts) once React frontend is stable
