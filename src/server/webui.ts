/**
 * Web UI - Inline SPA served by Fastify.
 * Dark theme matching analytics dashboard, no external dependencies.
 */

export function getWebUIHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>dhee</title>
<style>
${getStyles()}
</style>
</head>
<body>
<div id="app">
  <header id="header">
    <div class="header-left">
      <span class="logo">dhee</span>
      <select id="project-select">
        <option value="">Select Project...</option>
        <option value="__new__">+ New Project</option>
      </select>
    </div>
    <div class="header-right">
      <button id="autonomous-btn" title="Toggle Autonomous Mode" style="background:none;border:1px solid #444;color:#aaa;cursor:pointer;padding:4px 8px;border-radius:4px;font-size:12px;font-weight:600;letter-spacing:0.5px;">AUTO</button>
      <span id="session-timer" style="display:none;font-size:13px;font-variant-numeric:tabular-nums;color:var(--text-muted);font-family:monospace;">00:00:00</span>
      <div id="context-bar-wrap">
        <div id="context-bar"><div id="context-fill"></div></div>
        <span id="context-label">CTX 0%</span>
      </div>
      <button id="parallel-media-btn" title="Toggle parallel media generation (for remote ComfyUI)" style="background:none;border:1px solid #444;color:#aaa;cursor:pointer;padding:4px 8px;border-radius:4px;font-size:13px;">&#9655; Serial</button>
      <button id="provider-settings-btn" title="Provider Settings" style="background:none;border:1px solid #444;color:#aaa;cursor:pointer;padding:4px 8px;border-radius:4px;font-size:13px;">&#9881; Providers</button>
      <button id="workflows-btn" title="Manage Workflows" style="background:none;border:1px solid #444;color:#aaa;cursor:pointer;padding:4px 8px;border-radius:4px;font-size:13px;">&#9881; Workflows</button>
      <span id="conn-status" class="conn-dot disconnected" title="Disconnected"></span>
    </div>
  </header>
  <!-- Provider Settings Modal -->
  <div id="provider-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;display:none;align-items:center;justify-content:center;">
    <div style="background:#1e1e2e;border:1px solid #444;border-radius:8px;padding:24px;min-width:380px;max-width:480px;">
      <h3 style="margin:0 0 16px;color:#e0e0e0;">Provider Settings</h3>
      <div style="margin-bottom:12px;">
        <label style="display:block;color:#aaa;font-size:13px;margin-bottom:4px;">Image Generation</label>
        <select id="prov-image-gen" style="width:100%;padding:6px 8px;background:#2a2a3e;color:#e0e0e0;border:1px solid #555;border-radius:4px;">
          <option value="comfyui">Loading...</option>
        </select>
      </div>
      <div style="margin-bottom:12px;">
        <label style="display:block;color:#aaa;font-size:13px;margin-bottom:4px;">Image Editing</label>
        <select id="prov-image-edit" style="width:100%;padding:6px 8px;background:#2a2a3e;color:#e0e0e0;border:1px solid #555;border-radius:4px;">
          <option value="comfyui">Loading...</option>
        </select>
      </div>
      <div style="margin-bottom:16px;">
        <label style="display:block;color:#aaa;font-size:13px;margin-bottom:4px;">Video Generation</label>
        <select id="prov-video-gen" style="width:100%;padding:6px 8px;background:#2a2a3e;color:#e0e0e0;border:1px solid #555;border-radius:4px;">
          <option value="comfyui">Loading...</option>
        </select>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="prov-cancel" style="padding:6px 16px;background:#333;color:#ccc;border:1px solid #555;border-radius:4px;cursor:pointer;">Cancel</button>
        <button id="prov-save" style="padding:6px 16px;background:#3b82f6;color:white;border:none;border-radius:4px;cursor:pointer;">Save</button>
      </div>
    </div>
  </div>
  <!-- Workflow Management Modal -->
  <div id="workflow-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;align-items:center;justify-content:center;overflow-y:auto;">
    <div style="background:#1e1e2e;border:1px solid #444;border-radius:8px;padding:24px;min-width:500px;max-width:700px;margin:40px auto;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="margin:0;color:#e0e0e0;">Workflow Management</h3>
        <div style="display:flex;gap:8px;">
          <label id="wf-upload-label" style="padding:6px 16px;background:#3b82f6;color:white;border:none;border-radius:4px;cursor:pointer;font-size:13px;">
            Upload Workflow
            <input type="file" id="wf-upload-input" accept=".json" style="display:none;">
          </label>
          <button id="wf-close" style="padding:6px 16px;background:#333;color:#ccc;border:1px solid #555;border-radius:4px;cursor:pointer;">Close</button>
        </div>
      </div>
      <div id="wf-list" style="color:#ccc;font-size:13px;"></div>
      <!-- Integration wizard (hidden until upload) -->
      <div id="wf-wizard" style="display:none;margin-top:16px;border-top:1px solid #444;padding-top:16px;">
        <h4 style="margin:0 0 12px;color:#e0e0e0;" id="wf-wizard-title">Configure Workflow</h4>
        <div id="wf-wizard-content"></div>
      </div>
    </div>
  </div>
  <div id="main">
    <aside id="sidebar">
      <div class="sidebar-section">
        <h3>Phase</h3>
        <div id="phase-display" class="phase-badge">-</div>
      </div>
      <div class="sidebar-section">
        <h3>Todos</h3>
        <div id="todo-list" class="todo-list"></div>
      </div>
      <div class="sidebar-section">
        <h3>Assets</h3>
        <div id="asset-browser" class="asset-grid"></div>
      </div>
      <div class="sidebar-section" id="tools-section" style="display:none">
        <h3>Tools <span id="tools-count" class="tools-count"></span></h3>
        <div id="tools-list" class="tools-list"></div>
      </div>
    </aside>
    <div id="chat-container">
      <div id="chat-messages"></div>
      <button id="scroll-btn" class="scroll-btn hidden" onclick="scrollToBottom()">&#x2193; New messages</button>
      <div id="attached-files" class="hidden"></div>
      <div id="input-area">
        <textarea id="input-box" placeholder="Type a task..." rows="1"></textarea>
        <button id="send-btn" onclick="sendMessage()">Send</button>
      </div>
    </div>
  </div>
</div>
<div id="lightbox" class="lightbox hidden" onclick="closeLightbox()">
  <img id="lightbox-img" src="">
  <video id="lightbox-video" src="" controls style="display:none"></video>
</div>
<div id="toast-container"></div>

<script>
${getScript()}
</script>
</body>
</html>`;
}

function getStyles(): string {
  return `
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #0d1117; --bg-secondary: #161b22; --bg-tertiary: #21262d;
  --border: #30363d; --text: #c9d1d9; --text-muted: #8b949e;
  --accent: #58a6ff; --green: #238636; --green-bright: #3fb950;
  --red: #da3633; --orange: #f0883e; --purple: #d2a8ff; --code-green: #7ee787;
}
html, body { height: 100%; overflow: hidden; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); font-size: 14px; }
#app { display: flex; flex-direction: column; height: 100vh; }

/* Header */
header { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px; background: var(--bg-secondary); border-bottom: 1px solid var(--border); flex-shrink: 0; }
.header-left { display: flex; align-items: center; gap: 16px; }
.header-right { display: flex; align-items: center; gap: 16px; }
.logo { font-size: 18px; font-weight: 700; color: var(--accent); }
#project-select { background: var(--bg-tertiary); border: 1px solid var(--border); color: var(--text); padding: 4px 8px; border-radius: 6px; font-size: 13px; }
#context-bar-wrap { display: flex; align-items: center; gap: 8px; }
#context-bar { width: 80px; height: 8px; background: var(--bg-tertiary); border-radius: 4px; overflow: hidden; }
#context-fill { height: 100%; width: 0%; background: var(--accent); border-radius: 4px; transition: width 0.3s, background 0.3s; }
#context-label { font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums; min-width: 50px; }
.conn-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.conn-dot.connected { background: var(--green-bright); }
.conn-dot.disconnected { background: var(--red); }
.conn-dot.connecting { background: var(--orange); }

/* Main layout */
#main { display: flex; flex: 1; overflow: hidden; min-height: 0; }

/* Sidebar */
#sidebar { width: 260px; min-width: 260px; background: var(--bg-secondary); border-right: 1px solid var(--border); overflow-y: auto; padding: 12px; flex-shrink: 0; }
.sidebar-section { margin-bottom: 16px; }
.sidebar-section h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin-bottom: 8px; }
.phase-badge { background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; color: var(--accent); }
.todo-list { display: flex; flex-direction: column; gap: 2px; }
.todo-item { display: flex; align-items: flex-start; gap: 6px; padding: 4px 6px; border-radius: 4px; font-size: 12px; line-height: 1.4; }
.todo-item:hover { background: var(--bg-tertiary); }
.todo-icon { flex-shrink: 0; width: 14px; text-align: center; }
.todo-icon.pending { color: var(--text-muted); }
.todo-icon.in_progress { color: var(--orange); }
.todo-icon.completed { color: var(--green-bright); }
.todo-text { flex: 1; }
.asset-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
.tools-list { display: flex; flex-wrap: wrap; gap: 4px; max-height: 280px; overflow-y: auto; }
.tools-list .tool-badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-family: var(--mono); line-height: 1.4; cursor: default; }
.tools-count { font-size: 11px; color: var(--text-muted); font-weight: normal; }
.tool-badge.cat-read { background: rgba(96,165,250,0.15); color: #93bbfc; }
.tool-badge.cat-write { background: rgba(52,211,153,0.15); color: #6ee7b7; }
.tool-badge.cat-generate { background: rgba(251,191,36,0.15); color: #fbbf24; }
.tool-badge.cat-plan { background: rgba(167,139,250,0.15); color: #a78bfa; }
.tool-badge.cat-system { background: rgba(148,163,184,0.15); color: #94a3b8; }
.tool-badge.cat-default { background: rgba(148,163,184,0.10); color: #94a3b8; }
.asset-thumb { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); cursor: pointer; transition: border-color 0.2s; }
.asset-thumb:hover { border-color: var(--accent); }

/* Chat */
#chat-container { flex: 1; display: flex; flex-direction: column; position: relative; overflow: hidden; min-height: 0; }
#chat-messages { flex: 1 1 0; min-height: 0; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 6px; }
.scroll-btn { position: absolute; bottom: 80px; right: 24px; background: var(--accent); color: #fff; border: none; border-radius: 20px; padding: 6px 14px; font-size: 12px; cursor: pointer; z-index: 10; box-shadow: 0 2px 8px rgba(0,0,0,0.4); }

/* Messages */
.msg { padding: 10px 14px; border-radius: 8px; max-width: 100%; word-wrap: break-word; }
.msg.agent { background: var(--bg-secondary); border: 1px solid var(--border); position: relative; }
.msg .msg-copy-btn { position: absolute; top: 6px; right: 8px; font-size: 11px; color: var(--text-muted); background: var(--bg-tertiary); border: 1px solid transparent; border-radius: 3px; cursor: pointer; padding: 1px 6px; opacity: 0; transition: opacity 0.15s; }
.msg:hover .msg-copy-btn { opacity: 0.6; }
.msg .msg-copy-btn:hover { opacity: 1 !important; color: var(--text); border-color: var(--border); }
.msg .msg-copy-btn.copied { color: var(--green-bright); opacity: 1 !important; }
.msg.user { background: #1c3a5c; border: 1px solid #264d73; align-self: flex-end; max-width: 70%; }
.msg.system { background: transparent; color: var(--text-muted); font-size: 12px; text-align: center; padding: 4px; }
.msg.error { background: #3d1518; border: 1px solid var(--red); color: #f8d7da; }
.msg-content { font-size: 14px; line-height: 1.6; }
.msg-content p { margin-bottom: 8px; }
.msg-content p:last-child { margin-bottom: 0; }
.msg-content code { background: var(--bg-tertiary); padding: 2px 5px; border-radius: 3px; font-family: 'SF Mono', Consolas, monospace; font-size: 13px; }
.msg-content pre { background: #0d1117; border: 1px solid var(--border); border-radius: 6px; padding: 12px; overflow-x: auto; margin: 8px 0; max-height: 400px; overflow-y: auto; }
.msg-content pre code { background: none; padding: 0; font-size: 12px; line-height: 1.5; }
.msg-content h1, .msg-content h2, .msg-content h3 { color: var(--accent); margin: 12px 0 6px; }
.msg-content h1 { font-size: 18px; } .msg-content h2 { font-size: 16px; } .msg-content h3 { font-size: 14px; }
.msg-content ul, .msg-content ol { padding-left: 20px; margin: 6px 0; }
.msg-content li { margin: 2px 0; }
.msg-content strong { color: #e6edf3; }
.msg-content em { color: var(--text-muted); }
.msg-content a { color: var(--accent); }
.msg-content blockquote { border-left: 3px solid var(--border); padding-left: 12px; color: var(--text-muted); margin: 8px 0; }
.msg-content img { max-width: 100%; max-height: 400px; border-radius: 6px; margin: 8px 0; cursor: pointer; }

/* Streaming cursor */
.streaming-cursor::after, .streaming-cursor-inline::after { content: '\\25CF'; animation: blink 1s infinite; color: var(--accent); margin-left: 2px; }
.streaming-cursor-inline { display: inline; }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

/* Agent group block */
.agent-label { font-size: 11px; font-weight: 600; color: var(--purple); padding: 6px 0 2px; text-transform: uppercase; letter-spacing: 0.5px; }

/* Tool call cards */
.tool-card { border-bottom: 1px solid rgba(255,255,255,0.04); }
.tool-card:last-child { border-bottom: none; }
.tool-header { display: flex; align-items: center; gap: 6px; padding: 4px 12px; cursor: pointer; user-select: none; font-size: 12px; min-height: 28px; }
.tool-header:hover { background: rgba(255,255,255,0.03); }
.tool-chevron { font-size: 8px; color: var(--text-muted); transition: transform 0.2s; width: 10px; flex-shrink: 0; }
.tool-chevron.open { transform: rotate(90deg); }
.tool-name { font-family: 'SF Mono', Consolas, monospace; font-size: 11px; font-weight: 600; padding: 1px 5px; border-radius: 3px; flex-shrink: 0; }
/* Tool color coding */
.tool-name.cat-read { color: #79c0ff; background: rgba(121,192,255,0.1); }
.tool-name.cat-write { color: var(--orange); background: rgba(240,136,62,0.1); }
.tool-name.cat-generate { color: var(--purple); background: rgba(210,168,255,0.1); }
.tool-name.cat-plan { color: var(--code-green); background: rgba(126,231,135,0.1); }
.tool-name.cat-system { color: var(--text-muted); background: rgba(139,148,158,0.08); }
.tool-name.cat-default { color: var(--code-green); background: rgba(126,231,135,0.08); }
.tool-params-summary { font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; opacity: 0.7; }
.tool-args-clean { font-size: 12px; color: var(--text-muted); padding: 4px 8px; margin-bottom: 4px; opacity: 0.8; }
.tool-args-clean b { color: var(--text-secondary); }
.tool-arg-images { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.tool-arg-img-wrap { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.tool-arg-thumb { max-height: 140px; border-radius: 6px; cursor: pointer; border: 1px solid var(--border); }
.tool-arg-thumb:hover { border-color: var(--accent); }
.tool-arg-img-label { font-size: 10px; color: var(--text-muted); text-transform: capitalize; }
.tool-args-text { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
.tool-arg-prompt { font-size: 12px; color: var(--text-secondary); line-height: 1.5; padding: 6px 8px; background: var(--bg-tertiary); border-radius: 4px; border-left: 2px solid var(--accent); }
.tool-status { font-size: 10px; padding: 1px 5px; border-radius: 3px; flex-shrink: 0; }
.tool-status.started { color: var(--accent); }
.tool-status.completed { color: var(--green-bright); opacity: 0.6; }
.tool-status.error { color: var(--red); }
.tool-duration { font-size: 10px; color: var(--text-muted); flex-shrink: 0; opacity: 0.6; }
.tool-copy-btn { font-size: 11px; color: var(--text-muted); background: none; border: 1px solid transparent; border-radius: 3px; cursor: pointer; padding: 1px 5px; opacity: 0; transition: opacity 0.15s; flex-shrink: 0; margin-left: auto; }
.tool-header:hover .tool-copy-btn { opacity: 0.6; }
.tool-copy-btn:hover { opacity: 1 !important; color: var(--text); border-color: var(--border); }
.tool-copy-btn.copied { color: var(--green-bright); opacity: 1 !important; }
/* Faded style for routine tools */
.tool-card.faded .tool-header { opacity: 0.55; }
.tool-card.faded:hover .tool-header { opacity: 0.85; }
.tool-body { display: none; padding: 8px 12px; border-top: 1px solid rgba(255,255,255,0.05); font-size: 12px; }
.tool-body.open { display: block; }
.tool-section-label { font-size: 10px; text-transform: uppercase; color: var(--text-muted); margin-top: 8px; margin-bottom: 4px; letter-spacing: 0.5px; }
.tool-section-label:first-child { margin-top: 0; }
.tool-body pre { background: #0d1117; border-radius: 4px; padding: 8px; overflow-x: auto; font-size: 11px; max-height: 200px; overflow-y: auto; margin: 4px 0; line-height: 1.5; font-family: 'SF Mono', Consolas, monospace; color: var(--text); border: 1px solid rgba(255,255,255,0.05); }
.tool-result-content { position: relative; }
.tool-result-truncated { max-height: 150px; overflow: hidden; }
.tool-result-truncated::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 40px; background: linear-gradient(transparent, var(--bg-secondary)); pointer-events: none; }
.tool-expand-btn { display: inline-block; font-size: 11px; color: var(--accent); cursor: pointer; margin-top: 4px; padding: 2px 0; }
.tool-expand-btn:hover { text-decoration: underline; }
.tool-streaming-content { font-family: 'SF Mono', Consolas, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; color: var(--text); padding: 4px 0; }
.think-card .tool-body { display: block; }
.think-card .tool-header { cursor: default; }

/* Generate tool rich cards */
.gen-card { border: 1px solid var(--purple); border-radius: 8px; background: rgba(210,168,255,0.05); }
.gen-card .tool-body { display: block; padding: 12px; }
.gen-card .gen-section { margin-bottom: 10px; }
.gen-card .gen-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin-bottom: 4px; }
.gen-card .gen-prompt { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; }
.gen-card .gen-images { display: flex; gap: 8px; flex-wrap: wrap; }
.gen-card .gen-images .gen-img-wrap { position: relative; }
.gen-card .gen-images img { width: 80px; height: 80px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); cursor: pointer; }
.gen-card .gen-images img:hover { border-color: var(--accent); }
.gen-card .gen-images .gen-img-label { font-size: 9px; color: var(--text-muted); text-align: center; margin-top: 2px; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gen-card .gen-meta { font-size: 12px; color: var(--text-muted); display: flex; gap: 12px; flex-wrap: wrap; }
.gen-card .gen-meta span { background: var(--bg-tertiary); padding: 2px 8px; border-radius: 4px; }
/* ComfyUI progress bar inside gen cards */
.gen-progress { margin-top: 8px; }
.gen-progress-bar { width: 100%; height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden; }
.gen-progress-fill { height: 100%; width: 0%; background: var(--purple); border-radius: 3px; transition: width 0.3s ease; }
.gen-progress-text { font-size: 11px; color: var(--text-muted); margin-top: 4px; font-variant-numeric: tabular-nums; }
.tool-md-result { font-size: 13px; line-height: 1.5; }
.tool-md-result h1, .tool-md-result h2, .tool-md-result h3 { color: var(--accent); margin: 8px 0 4px; font-size: 14px; }
.tool-md-result p { margin: 4px 0; }
.tool-md-result ul, .tool-md-result ol { padding-left: 16px; }
.tool-md-result code { background: var(--bg-tertiary); padding: 1px 3px; border-radius: 2px; font-size: 12px; }
.tool-md-result pre { background: #0d1117; padding: 8px; border-radius: 4px; margin: 4px 0; font-size: 11px; }

/* Phase transition */
.reconnect-separator { text-align: center; padding: 8px 0; margin: 12px 0; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 11px; }
.reconnect-separator span { background: var(--bg); padding: 0 12px; position: relative; top: -1px; }
.phase-transition { display: flex; align-items: center; gap: 8px; padding: 8px 16px; margin: 4px 0; background: linear-gradient(90deg, rgba(88,166,255,0.1) 0%, transparent 100%); border-left: 3px solid var(--accent); border-radius: 0 6px 6px 0; }
.phase-transition .phase-icon { font-size: 14px; }
.phase-transition .phase-text { font-size: 13px; color: var(--accent); font-weight: 600; }
.phase-transition .phase-desc { font-size: 12px; color: var(--text-muted); }

/* Question area */
/* Question card — inline in chat */
.question-card { background: var(--bg-secondary); border: 1px solid var(--accent); border-radius: 8px; padding: 16px; margin: 4px 0; }
.question-card.answered { opacity: 0.6; border-color: var(--border); pointer-events: none; }
.question-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.question-icon { width: 20px; height: 20px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 12px; color: #fff; flex-shrink: 0; }
.question-text { font-size: 14px; line-height: 1.5; color: var(--text); }
.question-text p:first-child { margin-top: 0; }
.question-text p:last-child { margin-bottom: 0; }
.question-options { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.question-option { display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; transition: all 0.15s; text-align: left; width: 100%; }
.question-option:hover { border-color: var(--accent); background: #1c3a5c; }
.question-option.selected { border-color: var(--accent); background: #1c3a5c; }
.question-option-radio { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--text-muted); flex-shrink: 0; margin-top: 2px; transition: all 0.15s; }
.question-option:hover .question-option-radio { border-color: var(--accent); }
.question-option.selected .question-option-radio { border-color: var(--accent); background: var(--accent); box-shadow: inset 0 0 0 3px var(--bg); }
.question-option-content { flex: 1; min-width: 0; }
.question-option-label { font-size: 13px; font-weight: 500; color: var(--text); }
.question-option-desc { font-size: 12px; color: var(--text-muted); margin-top: 2px; line-height: 1.4; }
.question-timer-bar { height: 3px; background: var(--bg-tertiary); border-radius: 2px; margin-top: 12px; overflow: hidden; }
.question-timer-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.1s linear; }
.question-timer-text { font-size: 11px; color: var(--text-muted); margin-top: 4px; text-align: right; }
.question-actions { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
.question-submit-btn { background: #1c3a5c; border: 1px solid var(--accent); color: var(--accent); padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; }
.question-submit-btn:hover { background: #234b73; }
.question-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.question-custom-input { flex: 1; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 8px 10px; border-radius: 6px; font-size: 13px; }
.question-custom-wrap { display: flex; gap: 6px; margin-top: 8px; }
.question-answered-label { font-size: 12px; color: var(--text-muted); margin-top: 8px; font-style: italic; }

/* Input area */
#input-area { display: flex; gap: 8px; padding: 12px 16px; background: var(--bg-secondary); border-top: 1px solid var(--border); flex-shrink: 0; }
#input-box { flex: 1; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 8px; font-size: 14px; font-family: inherit; resize: none; outline: none; max-height: 120px; }
#input-box:focus { border-color: var(--accent); }
#send-btn { background: var(--accent); color: #fff; border: none; padding: 8px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; flex-shrink: 0; }
#send-btn:hover { opacity: 0.9; }
#send-btn:disabled { opacity: 0.4; cursor: default; }

/* File attachments */
#attached-files { display: flex; gap: 8px; padding: 8px 16px 0; flex-wrap: wrap; }
.attached-file { display: flex; align-items: center; gap: 6px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; font-size: 12px; }
.attached-file img { width: 32px; height: 32px; object-fit: cover; border-radius: 4px; }
.attached-file .file-name { color: var(--text); max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attached-file .file-remove { color: var(--text-muted); cursor: pointer; font-size: 14px; line-height: 1; }
.attached-file .file-remove:hover { color: var(--red); }
.drop-overlay { position: absolute; inset: 0; background: rgba(88,166,255,0.1); border: 2px dashed var(--accent); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 16px; color: var(--accent); font-weight: 600; z-index: 20; pointer-events: none; }

/* Lightbox */
.lightbox { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; z-index: 1000; cursor: pointer; }
.lightbox img, .lightbox video { max-width: 90%; max-height: 90%; border-radius: 8px; }

/* Result media preview (inside tool card) */
.result-media-preview { margin-top: 8px; }
.result-media-preview img { max-width: 100%; max-height: 400px; border-radius: 8px; cursor: pointer; }
.result-media-preview video { max-width: 100%; max-height: 400px; border-radius: 8px; }
.result-media-label { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

/* Chat timeline media preview (after tool card) */
.chat-media-preview { padding: 8px 0; }
.chat-media-preview img { max-width: 512px; max-height: 400px; border-radius: 8px; cursor: pointer; box-shadow: 0 2px 12px rgba(0,0,0,0.3); }
.chat-media-preview video { max-width: 512px; max-height: 400px; border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.3); }
.chat-media-preview .result-media-label { font-size: 11px; color: var(--text-muted); margin-top: 4px; }

/* Toasts */
#toast-container { position: fixed; top: 16px; right: 16px; z-index: 999; display: flex; flex-direction: column; gap: 8px; }
.toast { padding: 10px 16px; border-radius: 8px; font-size: 13px; max-width: 360px; animation: slideIn 0.3s ease; }
.toast.info { background: #1c3a5c; border: 1px solid var(--accent); color: var(--accent); }
.toast.warning { background: #3d2e08; border: 1px solid var(--orange); color: var(--orange); }
.toast.error { background: #3d1518; border: 1px solid var(--red); color: #f8d7da; }
@keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

/* Wizard */
.wizard-step { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin: 4px 0; }
.wizard-step-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin-bottom: 4px; }
.wizard-step-title { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 12px; }
.wizard-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
.wizard-card { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px; cursor: pointer; transition: all 0.15s; }
.wizard-card:hover { border-color: var(--accent); background: #1c3a5c; }
.wizard-card-name { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
.wizard-card-desc { font-size: 12px; color: var(--text-muted); line-height: 1.4; }
.wizard-card.selected { border-color: var(--accent); background: #1c3a5c; }
.wizard-duration-cards { display: flex; flex-wrap: wrap; gap: 8px; }
.wizard-duration-btn { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 16px; cursor: pointer; font-size: 13px; color: var(--text); transition: all 0.15s; }
.wizard-duration-btn:hover { border-color: var(--accent); background: #1c3a5c; }
.wizard-duration-btn.selected { border-color: var(--accent); background: #1c3a5c; }
.wizard-summary { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.wizard-summary-tag { background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; font-size: 11px; color: var(--accent); }

.hidden { display: none !important; }

/* Scrollbar */
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: var(--bg); }
::-webkit-scrollbar-thumb { background: var(--bg-tertiary); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--border); }
`;
}

function getScript(): string {
  return `
// ===== Regex patterns (injected from TypeScript to avoid template literal escaping) =====
var _comfyProgressRe = ${'/^(?:Step\\s+(\\d+)\\/(\\d+)\\s+)?\\(?(\\d+)%\\)?$/'};
var _pctStatusRe = ${'/(\\d+)%/'};
var _mediaPatternRe = ${'/([\\w\\/\\-_.]+\\.(png|jpg|jpeg|webp|gif|mp4|webm|mov))/gi'};
var _looksLikeMdRe = ${'/^#{1,3} |\\n#{1,3} |\\*\\*[^*]+\\*\\*|^- /'};
var _resultPrefixRe = ${'/^Result\\s*/'};
var _codeBlockRe = ${'/```(\\w*?)\\n([\\s\\S]*?)```/g'};
var _olListRe = ${'/^\\d+\\. (.+)$/gm'};
var _ulWrapRe = ${'/((?:<li>.*?<\\/li>\\s*)+)/g'};
var _doubleNewlineRe = ${'/\\n\\n/g'};
var _singleNewlineRe = ${'/\\n/g'};

// ===== State =====
let ws = null;
let sessionId = null;
let selectedProject = null;
let autoScroll = true;
let reconnectDelay = 1000;
let reconnectTimer = null;
let streamingEl = null;
let streamRenderTimer = null;
let currentAgentGroup = null; // { name, el, bodyEl, count }
let toolCounter = 0;
let pendingTools = {}; // generatedId -> { card element, startTime, toolName }
let attachedFiles = []; // { name, path, url }
let artifactCache = {}; // artifact_id -> { path, url, type }

const chatMessages = document.getElementById('chat-messages');
const inputBox = document.getElementById('input-box');
const sendBtn = document.getElementById('send-btn');
const projectSelect = document.getElementById('project-select');
const scrollBtn = document.getElementById('scroll-btn');
let activeQuestionCard = null; // currently active question card element
let questionTimerInterval = null; // auto-approve countdown interval
var newProjectState = null; // { step, templateId, templateName, style, styleName, duration, durationLabel, templates, durationPresets }
var pendingAutoTask = null; // task string to send once select_project completes
var autonomousModeActive = false; // autonomous mode flag
var parallelMediaActive = false; // parallel media generation flag
var sessionTimerInterval = null; // session timer update interval
var sessionElapsedMs = 0; // accumulated elapsed ms from server
var sessionTimerLocalStart = null; // Date.now() when local ticking started

// ===== Connection Manager =====
function connect() {
  setConnStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl = proto + '//' + location.host + '/api/v1/ws/chat';
  // On reconnect, pass the previous sessionId so the server can reattach
  if (sessionId) wsUrl += '?sessionId=' + encodeURIComponent(sessionId);
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setConnStatus('connected');
    reconnectDelay = 1000;

    // Auto-resume: if we had an active project before disconnect,
    // re-select it to restore UI state. Don't send a new task —
    // the executor is already running from the previous connection.
    // Suppress noisy "Connected/Resuming" messages on reconnect.
    if (selectedProject) {
      // Add visual separator in chat
      closeAgentGroup();
      var sep = document.createElement('div');
      sep.className = 'reconnect-separator';
      sep.innerHTML = '<span>Reconnected</span>';
      chatMessages.appendChild(sep);
      maybeScroll();

      wsSend({ type: 'select_project', sessionId, data: { projectName: selectedProject } });
      // Resume execution if server restarted. If executor is already running
      // (WebSocket-only reconnect), the server will reject the duplicate task.
      pendingAutoTask = 'Continue working on the existing project.';
      // Refresh sidebar state on reconnect
      loadProjectAssets(selectedProject);
      loadProjectDetails(selectedProject);
      loadArtifactCache(selectedProject);
    }
  };

  ws.onmessage = (e) => {
    try { handleServerMessage(JSON.parse(e.data)); }
    catch (err) { console.error('Parse error:', err); }
  };

  ws.onclose = () => {
    setConnStatus('disconnected');
    // Keep sessionId so we can reconnect to the same session
    scheduleReconnect();
  };

  ws.onerror = () => setConnStatus('disconnected');
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

function setConnStatus(s) {
  const dot = document.getElementById('conn-status');
  dot.className = 'conn-dot ' + s;
  dot.title = s.charAt(0).toUpperCase() + s.slice(1);
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ===== Message Router =====
function handleServerMessage(msg) {
  if (msg.sessionId) sessionId = msg.sessionId;
  switch (msg.type) {
    case 'status': handleStatus(msg.data); break;
    case 'stream_chunk': handleStreamChunk(msg.data); break;
    case 'tool_call': handleToolCall(msg.data); break;
    case 'agent_question': handleQuestion(msg.data); break;
    case 'agent_response': handleAgentResponse(msg.data); break;
    case 'todo_update': handleTodoUpdate(msg.data); break;
    case 'context_usage': handleContextUsage(msg.data); break;
    case 'phase_transition': handlePhaseTransition(msg.data); break;
    case 'notification': handleNotification(msg.data); break;
    case 'session_timer': handleSessionTimer(msg.data); break;
    case 'error': handleError(msg.data); break;
  }
}

// ===== Status =====
function handleStatus(data) {
  if (data.status === 'connected') sendBtn.disabled = false;
  else if (data.status === 'busy') sendBtn.disabled = true;
  else if (data.status === 'completed') { sendBtn.disabled = false; finalizeStream(); closeAgentGroup(); }
  // When select_project or create_project completes, handle pending actions
  if (data.status === 'ready') {
    if (data.message && data.message.startsWith('Project "') && data.message.endsWith('" created')) {
      addSystemMessage(data.message);
      // Auto-select the newly created project in the dropdown
      if (data.projectName) {
        selectedProject = data.projectName;
        loadProjects().then(function() {
          projectSelect.value = data.projectName;
        });
        loadProjectDetails(data.projectName);
        loadProjectAssets(data.projectName);
        loadArtifactCache(data.projectName);
      } else {
        loadProjects();
      }
      sendBtn.disabled = false;
    }
    // Fire any pending auto-task queued by select_project
    if (pendingAutoTask) {
      var task = pendingAutoTask;
      pendingAutoTask = null;
      wsSend({ type: 'start_task', sessionId: sessionId, data: { task: task } });
    }
  }
  // Show tool list when agent is ready
  if (data.tools && data.tools.length > 0) {
    renderToolsList(data.tools);
  }
}

function getToolCategory(name) {
  if (/read|list|get|search_files/.test(name)) return 'cat-read';
  if (/write|create|update|save|import|set/.test(name)) return 'cat-write';
  if (/generat|image|render|video/.test(name)) return 'cat-generate';
  if (/plan|review|approve|verify/.test(name)) return 'cat-plan';
  if (/todo|phase|context|project/.test(name)) return 'cat-system';
  return 'cat-default';
}

function renderToolsList(tools) {
  var section = document.getElementById('tools-section');
  var list = document.getElementById('tools-list');
  var count = document.getElementById('tools-count');
  section.style.display = '';
  count.textContent = '(' + tools.length + ')';
  list.innerHTML = '';
  tools.slice().sort().forEach(function(name) {
    var badge = document.createElement('span');
    badge.className = 'tool-badge ' + getToolCategory(name);
    badge.textContent = name;
    badge.title = name;
    list.appendChild(badge);
  });
}

// ===== Agent Grouping =====
function getOrCreateAgentGroup(agentName) {
  var name = agentName || 'Agent';
  if (currentAgentGroup && currentAgentGroup.name === name) {
    return currentAgentGroup;
  }
  // Close previous group
  closeAgentGroup();
  // Add a label for the new agent
  var label = document.createElement('div');
  label.className = 'agent-label';
  label.textContent = name;
  chatMessages.appendChild(label);
  currentAgentGroup = { name, bodyEl: chatMessages };
  return currentAgentGroup;
}

function closeAgentGroup() {
  currentAgentGroup = null;
}

// ===== Streaming Text =====
function handleStreamChunk(data) {
  // Tool streaming goes into the tool card
  if (data.toolCallId) {
    const entry = findToolEntry(data.toolCallId);
    if (entry) { handleToolStreaming(entry, data); return; }
  }

  // If there's an active agent group, put streaming text inside it
  // If agent name changed, close and reopen
  if (data.agentName && currentAgentGroup && currentAgentGroup.name !== data.agentName) {
    finalizeStream();
    closeAgentGroup();
  }

  if (data.reset) {
    if (streamingEl) streamingEl.remove();
    streamingEl = null;
  }

  if (!streamingEl) {
    streamingEl = createStreamingMessage(data.agentName);
  }

  var contentEl = streamingEl.querySelector('.msg-content');
  if (data.content) {
    var raw = (streamingEl._rawText || '') + data.content;
    streamingEl._rawText = raw;
    // Throttled markdown rendering during streaming
    if (!streamRenderTimer) {
      streamRenderTimer = setTimeout(function() {
        streamRenderTimer = null;
        if (streamingEl) {
          var el = streamingEl.querySelector('.msg-content');
          if (el) el.innerHTML = renderMarkdown(streamingEl._rawText || '') + '<span class="streaming-cursor-inline"></span>';
          maybeScroll();
        }
      }, 150);
    }
  }

  if (data.done) {
    if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
    finalizeStream();
  }
  maybeScroll();
}

function finalizeStream() {
  if (!streamingEl) return;
  var raw = streamingEl._rawText || '';
  if (!raw.trim()) {
    streamingEl.remove();
    streamingEl = null;
    return;
  }
  // Convert streaming element into a tool-card style "think" card (no toolId — streaming origin)
  var card = document.createElement('div');
  card.className = 'tool-card think-card';
  card.innerHTML =
    '<div class="tool-header">' +
      '<span class="tool-name cat-system">think</span>' +
      '<button class="tool-copy-btn" onclick="copyCardText(this, event)">Copy</button>' +
    '</div>' +
    '<div class="tool-body" style="display:block">' +
      '<div class="tool-md-result">' + renderMarkdown(raw.trim()) + '</div>' +
    '</div>';
  // Replace streaming el with the card
  streamingEl.parentNode.replaceChild(card, streamingEl);
  streamingEl = null;
}

function createStreamingMessage(agentName) {
  var el = document.createElement('div');
  el.className = 'msg agent agent-thinking';
  el.innerHTML = '<div class="msg-content"></div>';
  // If there's an active agent group, append inside it
  if (currentAgentGroup) {
    currentAgentGroup.bodyEl.appendChild(el);
  } else if (agentName) {
    var group = getOrCreateAgentGroup(agentName);
    group.bodyEl.appendChild(el);
  } else {
    chatMessages.appendChild(el);
  }
  return el;
}

function createAgentMessage(agentName) {
  const el = document.createElement('div');
  el.className = 'msg agent';
  el.innerHTML = '<button class="msg-copy-btn" onclick="copyCardText(this, event)">Copy</button><div class="msg-content"></div>';
  chatMessages.appendChild(el);
  return el;
}

// ===== Tool Calls =====
function getToolCategory(toolName) {
  const t = (toolName || '').toLowerCase();
  if (t.includes('read') || t.includes('list') || t.includes('get') || t === 'search_files') return 'read';
  if (t.includes('write') || t.includes('create') || t.includes('update') || t.includes('save') || t.includes('import') || t.includes('set')) return 'write';
  if (t.includes('generat') || t.includes('image') || t.includes('render') || t.includes('video')) return 'generate';
  if (t.includes('plan') || t.includes('review') || t.includes('approve') || t.includes('verify')) return 'plan';
  if (t.includes('todo') || t.includes('phase') || t.includes('context') || t.includes('project')) return 'system';
  return 'default';
}

function isRoutineTool(toolName) {
  const t = (toolName || '').toLowerCase();
  return t.includes('read') || t.includes('list') || t === 'search_files' || t.includes('get_project') || t.includes('todo');
}

function getToolParamsSummary(toolName, args) {
  if (!args || typeof args !== 'object') return '';
  // Show the most relevant param for common tools
  if (args.path) return escHtml(String(args.path));
  if (args.file_path) return escHtml(String(args.file_path));
  if (args.query) return escHtml(truncStr(String(args.query), 80));
  if (args.content) return escHtml(truncStr(String(args.content), 60));
  if (args.task) return escHtml(truncStr(String(args.task), 80));
  if (args.name) return escHtml(String(args.name));
  // Fallback: show first few keys
  const keys = Object.keys(args).slice(0, 3);
  return keys.map(k => {
    const v = args[k];
    const vs = typeof v === 'string' ? truncStr(v, 40) : JSON.stringify(v);
    return escHtml(k) + '=' + escHtml(truncStr(String(vs), 40));
  }).join(', ');
}

function isGenerateTool(name) {
  var t = (name || '').toLowerCase();
  return t.includes('generate_image') || t.includes('generate_video') || t.includes('generate_content');
}

function buildArtifactImg(artifactId, label) {
  var url = resolveArtifactUrl(artifactId);
  var displayLabel = label || artifactId;
  if (!url) return '<div class="gen-img-wrap"><div class="gen-img-label">' + escHtml(displayLabel) + '</div></div>';
  return '<div class="gen-img-wrap"><img src="' + escHtml(url) + '" onclick="openLightbox(this.src)"><div class="gen-img-label">' + escHtml(displayLabel) + '</div></div>';
}

function getArtifactTypeLabel(artifactId) {
  var entry = artifactCache[artifactId];
  if (!entry) return artifactId;
  var t = entry.type || '';
  if (t === 'character_ref') return 'Character Ref';
  if (t === 'setting_ref') return 'Setting Ref';
  if (t === 'scene_image') return 'Scene Image';
  if (t === 'scene_video') return 'Scene Video';
  return t.replace(/_/g, ' ') || artifactId;
}

function buildGenerateCard(genId, toolName, args) {
  var card = document.createElement('div');
  card.className = 'tool-card gen-card';
  card.dataset.toolId = genId;
  card.dataset.toolName = toolName;

  // Header
  var headerHtml = '<div class="tool-header">' +
    '<span class="tool-name cat-generate">' + escHtml(toolName) + '</span>' +
    '<span class="tool-duration"></span>' +
    '<button class="tool-copy-btn" onclick="copyCardText(this, event)">Copy</button>' +
    '<span class="tool-status started">&#9679;</span>' +
  '</div>';

  // Body sections
  var bodyHtml = '';

  // Scene info
  var metaParts = [];
  if (args.scene_number) metaParts.push('<span>Scene ' + args.scene_number + '</span>');
  if (args.image_type) metaParts.push('<span>' + escHtml(args.image_type) + '</span>');
  if (args.generation_mode) metaParts.push('<span>' + escHtml(args.generation_mode) + '</span>');
  if (args.character_name) metaParts.push('<span>Character: ' + escHtml(args.character_name) + '</span>');
  if (args.setting_name) metaParts.push('<span>Setting: ' + escHtml(args.setting_name) + '</span>');
  if (args.aspect_ratio) metaParts.push('<span>' + escHtml(args.aspect_ratio) + '</span>');
  if (metaParts.length > 0) {
    bodyHtml += '<div class="gen-section"><div class="gen-meta">' + metaParts.join('') + '</div></div>';
  }

  // Prompt
  var prompt = args.prompt || args.motion_prompt || '';
  var promptFile = args.prompt_file || args.motion_prompt_file || '';
  if (prompt) {
    bodyHtml += '<div class="gen-section"><div class="gen-label">Prompt</div><div class="gen-prompt">' + escHtml(prompt) + '</div></div>';
  }
  if (promptFile) {
    bodyHtml += '<div class="gen-section"><div class="gen-label">Prompt File</div><div class="gen-prompt" style="font-size:12px;color:var(--accent);">' + escHtml(promptFile) + '</div></div>';
  }
  if (args.negative_prompt) {
    bodyHtml += '<div class="gen-section"><div class="gen-label">Negative Prompt</div><div class="gen-prompt" style="color:var(--red);font-size:12px;">' + escHtml(args.negative_prompt) + '</div></div>';
  }

  // Images — separated by purpose with labels

  // For generate_video_from_image: show the single shot image being animated
  if (args.shot_image_artifact_id) {
    var shotLabel = 'Shot' + (args.shot_number ? ' ' + args.shot_number : '') + ' Image';
    bodyHtml += '<div class="gen-section"><div class="gen-label">' + shotLabel + '</div><div class="gen-images">' +
      buildArtifactImg(args.shot_image_artifact_id, shotLabel) + '</div></div>';
  }
  // Legacy fallback for older scene_image_artifact_id
  if (!args.shot_image_artifact_id && args.scene_image_artifact_id) {
    bodyHtml += '<div class="gen-section"><div class="gen-label">Scene Image</div><div class="gen-images">' +
      buildArtifactImg(args.scene_image_artifact_id, 'Scene') + '</div></div>';
  }

  // For generate_image: show reference images grouped by type
  if (args.reference_images && Array.isArray(args.reference_images)) {
    var charRefs = '';
    var settingRefs = '';
    args.reference_images.forEach(function(ref) {
      if (!ref.image_id) return;
      var aType = (artifactCache[ref.image_id] || {}).type || ref.type || '';
      var refLabel = ref.name || getArtifactTypeLabel(ref.image_id);
      if (aType === 'setting_ref') {
        settingRefs += buildArtifactImg(ref.image_id, refLabel);
      } else {
        charRefs += buildArtifactImg(ref.image_id, refLabel);
      }
    });
    if (charRefs) {
      bodyHtml += '<div class="gen-section"><div class="gen-label">Character References</div><div class="gen-images">' + charRefs + '</div></div>';
    }
    if (settingRefs) {
      bodyHtml += '<div class="gen-section"><div class="gen-label">Setting References</div><div class="gen-images">' + settingRefs + '</div></div>';
    }
  }

  card.innerHTML = headerHtml + '<div class="tool-body">' + bodyHtml + '<div class="tool-streaming-content"></div><div class="tool-result-section" style="display:none"></div></div>';
  return card;
}

function handleToolCall(data) {
  // Finalize any streaming text before showing tool
  finalizeStream();

  const toolName = data.toolName || 'unknown';
  const agentName = data.agentName;

  if (data.status === 'started') {
    toolCounter++;
    const genId = 'tool_' + toolCounter;

    // Get or create agent group
    const group = getOrCreateAgentGroup(agentName);
    const container = group.bodyEl;

    // Special handling for think tool — render as think card, always expanded
    if (toolName === 'think' || toolName === 'Think') {
      var thought = (data.arguments && (data.arguments.thought || data.arguments.content)) || '';

      // Remove preceding streaming-think card if it has the same content (avoids duplicate)
      var lastChild = container.lastElementChild;
      if (lastChild && lastChild.classList.contains('tool-card')) {
        var prevName = lastChild.querySelector('.tool-name');
        if (prevName && prevName.textContent === 'think' && !lastChild.dataset.toolId) {
          lastChild.remove();
        }
      }

      var thinkCard = document.createElement('div');
      thinkCard.className = 'tool-card think-card';
      thinkCard.dataset.toolId = genId;
      thinkCard.dataset.toolName = toolName;
      thinkCard.innerHTML =
        '<div class="tool-header">' +
          '<span class="tool-name cat-system">think</span>' +
          '<button class="tool-copy-btn" onclick="copyCardText(this, event)">Copy</button>' +
        '</div>' +
        '<div class="tool-body" style="display:block">' +
          '<div class="tool-md-result">' + renderMarkdown(thought) + '</div>' +
        '</div>';
      container.appendChild(thinkCard);
      pendingTools[genId] = { card: thinkCard, startTime: Date.now(), toolName, isThink: true };
      maybeScroll();
      return;
    }

    // Special rich rendering for generate tools
    if (isGenerateTool(toolName)) {
      var genCard = buildGenerateCard(genId, toolName, data.arguments || {});
      container.appendChild(genCard);
      pendingTools[genId] = { card: genCard, startTime: Date.now(), toolName };
      maybeScroll();
      return;
    }

    const paramSummary = getToolParamsSummary(toolName, data.arguments);
    const cat = getToolCategory(toolName);
    const faded = isRoutineTool(toolName);
    const card = document.createElement('div');
    card.className = 'tool-card' + (faded ? ' faded' : '');
    card.dataset.toolId = genId;
    card.dataset.toolName = toolName;

    // Executor tool cards (generate_*, gen_*, extract_*) start expanded with clean arg display
    const isExecutorTool = /^(generate_|gen_|extract_)/.test(toolName);
    const chevronClass = isExecutorTool ? 'tool-chevron open' : 'tool-chevron';
    const bodyClass = isExecutorTool ? 'tool-body open' : 'tool-body';

    // Format arguments: executor tools get clean display, others get JSON
    let argsHtml;
    if (isExecutorTool) {
      const args = data.arguments || {};
      var images = [];
      var textParts = [];
      var promptText = '';
      Object.entries(args).forEach(function(kv) {
        var key = kv[0], val = String(kv[1]);
        if (/\.(png|jpg|jpeg|webp)$/i.test(val) && selectedProject) {
          var imgUrl = '/api/v1/assets/' + selectedProject + '/' + val;
          var label = key.replace(/^ref_\d+_/, '').replace(/_/g, ' ');
          images.push('<div class="tool-arg-img-wrap"><img src="' + imgUrl + '" class="tool-arg-thumb" onclick="openLightbox(this.src)" onerror="this.remove()"><div class="tool-arg-img-label">' + escHtml(label) + '</div></div>');
        } else if (key === 'prompt') {
          promptText = val;
        } else {
          textParts.push('<b>' + escHtml(key) + ':</b> ' + escHtml(val));
        }
      });
      var sections = [];
      if (images.length > 0) sections.push('<div class="tool-arg-images">' + images.join('') + '</div>');
      if (textParts.length > 0) sections.push('<div class="tool-args-text">' + textParts.join(' &middot; ') + '</div>');
      if (promptText) sections.push('<div class="tool-arg-prompt">' + escHtml(promptText) + '</div>');
      argsHtml = sections.length > 0 ? '<div class="tool-args-clean">' + sections.join('') + '</div>' : '';
    } else {
      argsHtml = '<div class="tool-section-label">Arguments</div><pre>' + escHtml(JSON.stringify(data.arguments || {}, null, 2)) + '</pre>';
    }

    card.innerHTML =
      '<div class="tool-header" onclick="toggleToolBody(this)">' +
        '<span class="' + chevronClass + '">&#9654;</span>' +
        '<span class="tool-name cat-' + cat + '">' + escHtml(toolName) + '</span>' +
        (paramSummary ? '<span class="tool-params-summary">' + paramSummary + '</span>' : '') +
        '<span class="tool-duration"></span>' +
        '<button class="tool-copy-btn" onclick="copyCardText(this, event)">Copy</button>' +
        '<span class="tool-status started">&#9679;</span>' +
      '</div>' +
      '<div class="' + bodyClass + '">' +
        argsHtml +
        '<div class="tool-streaming-content"></div>' +
        '<div class="tool-result-section" style="display:none"></div>' +
      '</div>';

    container.appendChild(card);
    var toolEntry = { card, startTime: Date.now(), toolName, elapsedTimer: null };
    pendingTools[genId] = toolEntry;

    // For long-running generation tools, show a live elapsed timer
    if (isGenerateTool(toolName) || toolName === 'generate_video_from_image') {
      var durEl = card.querySelector('.tool-duration');
      if (durEl) {
        toolEntry.elapsedTimer = setInterval(function() {
          durEl.textContent = formatDuration(Date.now() - toolEntry.startTime) + '...';
        }, 1000);
      }
    }

    maybeScroll();

  } else if (data.status === 'completed' || data.status === 'error') {
    // Find the matching pending tool card (most recent with same toolName)
    let entry = null;
    let entryId = null;
    for (const [id, t] of Object.entries(pendingTools)) {
      if (t.toolName === toolName) {
        entry = t;
        entryId = id;
      }
    }
    if (!entry) return;
    if (entry.elapsedTimer) clearInterval(entry.elapsedTimer);
    delete pendingTools[entryId];

    // Skip result rendering for think tool — already shown in the card body
    if (entry.isThink) return;

    const card = entry.card;
    const statusEl = card.querySelector('.tool-status');
    statusEl.className = 'tool-status ' + data.status;
    statusEl.innerHTML = data.status === 'completed' ? '&#10003;' : data.status === 'error' ? '&#10007;' : data.status;

    const durEl = card.querySelector('.tool-duration');
    durEl.textContent = formatDuration(Date.now() - entry.startTime);

    if (data.result !== undefined) {
      // Check if this is a confirmation-required result — show a clean message
      var isConfirmationResult = typeof data.result === 'object' && data.result !== null && data.result.status === 'needs_confirmation';
      if (isConfirmationResult) {
        // For generate tools, just update status indicator to "pending" style
        statusEl.className = 'tool-status started';
        statusEl.innerHTML = '&#9679;';
        var confLabel = document.createElement('div');
        confLabel.style.cssText = 'font-size:12px;color:var(--text-muted);padding:8px 0 4px;';
        confLabel.textContent = 'Awaiting user confirmation...';
        var body = card.querySelector('.tool-body') || card;
        body.appendChild(confLabel);
      } else {
        const resultSection = card.querySelector('.tool-result-section');
        resultSection.style.display = 'block';
        renderToolResult(resultSection, toolName, data.result);
      }
    }

    // For completed jobs with media output, show preview in the chat timeline (after the tool card)
    if (data.status === 'completed' && typeof data.result === 'object' && data.result !== null &&
        data.result.status === 'completed' && (data.result.artifact_id || data.result.file_path)) {
      var previewEl = document.createElement('div');
      previewEl.className = 'chat-media-preview';
      renderMediaPreview(previewEl, data.result.artifact_id, data.result.file_path, data.result.type);
      card.parentNode.insertBefore(previewEl, card.nextSibling);
    }

    // Refresh asset panel after image/video generation completes
    if (selectedProject && (toolName === 'generate_image' || toolName === 'generate_video_from_image' || toolName === 'generate_video') && data.status === 'completed') {
      loadProjectAssets(selectedProject);
    }

    maybeScroll();
  }
}

function renderMediaPreview(container, artifactId, filePath, jobType) {
  if (!selectedProject) return;
  // Try artifact cache first, fall back to file_path
  var url = artifactId ? resolveArtifactUrl(artifactId) : null;
  if (!url && filePath) {
    var assetPath = filePath;
    var idx = filePath.indexOf('assets/');
    if (idx >= 0) assetPath = filePath.substring(idx);
    url = '/api/v1/assets/' + selectedProject + '/' + assetPath;
  }
  if (!url) return;

  var preview = document.createElement('div');
  preview.className = 'result-media-preview';

  var isVideo = jobType === 'video' || isVideoUrl(url);
  if (isVideo) {
    var video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.onerror = function() { preview.remove(); };
    preview.appendChild(video);
  } else {
    var img = document.createElement('img');
    img.src = url;
    img.onclick = function() { openLightbox(url); };
    img.onerror = function() { preview.remove(); };
    preview.appendChild(img);
  }

  var label = document.createElement('div');
  label.className = 'result-media-label';
  label.textContent = (isVideo ? 'Video' : 'Image') + ' generated' + (artifactId ? ' — ' + artifactId : '');
  preview.appendChild(label);

  container.appendChild(preview);
}

function renderToolResult(container, toolName, result) {
  container.innerHTML = '<div class="tool-section-label">Result</div>';

  // For wait_for_job / generate_image completions with artifact, show brief status
  // (the full media preview is shown in the chat timeline after the tool card)
  if (typeof result === 'object' && result !== null && result.status === 'completed' && (result.artifact_id || result.file_path)) {
    var mediaType = (result.type === 'video') ? 'Video' : 'Image';
    container.innerHTML = '<div class="tool-section-label">Result</div>' +
      '<div class="tool-result-content" style="font-size:12px;color:var(--text-muted);padding:4px 0;">' +
      escHtml(mediaType + ' generated — ' + (result.artifact_id || result.file_path)) + '</div>';
    return;
  }

  // For Task/subagent results, show a brief status — the summary was already
  // streamed as agent_text/think blocks, so don't duplicate it
  if (typeof result === 'object' && result !== null && (result.summary || result.output)) {
    var status = result.status || 'completed';
    var msg = result.message || '';
    container.innerHTML = '<div class="tool-section-label">Result</div>' +
      '<div class="tool-result-content" style="font-size:12px;color:var(--text-muted);padding:4px 0;">' +
      escHtml(status + (msg ? ' — ' + msg : '')) + '</div>';
    return;
  }

  var resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

  // Check if result is markdown-like (from read_file on .md files, or has markdown headers)
  var looksLikeMd = _looksLikeMdRe.test(resultStr);
  // Check if result is JSON
  var looksLikeJson = resultStr.trimStart().startsWith('{') || resultStr.trimStart().startsWith('[');
  // Check if result is very long
  var isLong = resultStr.length > 500;

  var wrapper = document.createElement('div');
  wrapper.className = 'tool-result-content';

  if (looksLikeMd && !looksLikeJson) {
    // Render as markdown
    var mdDiv = document.createElement('div');
    mdDiv.className = 'tool-md-result';
    mdDiv.innerHTML = renderMarkdown(resultStr);
    wrapper.appendChild(mdDiv);
  } else if (looksLikeJson) {
    // Render as formatted JSON code block
    var pre = document.createElement('pre');
    try {
      var parsed = JSON.parse(resultStr);
      pre.textContent = JSON.stringify(parsed, null, 2);
    } catch(e) {
      pre.textContent = resultStr;
    }
    wrapper.appendChild(pre);
  } else {
    // Plain text in pre
    var pre = document.createElement('pre');
    pre.textContent = resultStr;
    wrapper.appendChild(pre);
  }

  // Truncation with expand
  if (isLong) {
    wrapper.classList.add('tool-result-truncated');
    var expandBtn = document.createElement('span');
    expandBtn.className = 'tool-expand-btn';
    expandBtn.textContent = 'Show more';
    expandBtn.onclick = function() {
      if (wrapper.classList.contains('tool-result-truncated')) {
        wrapper.classList.remove('tool-result-truncated');
        this.textContent = 'Show less';
      } else {
        wrapper.classList.add('tool-result-truncated');
        this.textContent = 'Show more';
      }
    };
    container.appendChild(wrapper);
    container.appendChild(expandBtn);
  } else {
    container.appendChild(wrapper);
  }

  // Detect and render images in results
  renderImagesInResult(container, resultStr);
}

function findToolEntry(toolCallId) {
  // toolCallId from server is often empty; try matching by ID or return last pending
  for (const [id, t] of Object.entries(pendingTools)) {
    return t; // return most recent (usually only one pending at a time)
  }
  return null;
}

function handleToolStreaming(entry, data) {
  const streamEl = entry.card.querySelector('.tool-streaming-content');
  if (!streamEl) return;

  // Detect ComfyUI progress pattern: "Step N/M (P%)" or just "P%"
  var progressMatch = data.content && data.content.match(_comfyProgressRe);
  // Also detect status messages: "Processing node X (0%)", "Loading workflow...", etc.
  var pctFromStatus = !progressMatch && data.content && data.content.match(_pctStatusRe);

  if (data.reset && (progressMatch || pctFromStatus || data.content)) {
    // Ensure progress wrapper exists
    var progressWrap = streamEl.querySelector('.gen-progress');
    if (!progressWrap) {
      streamEl.innerHTML = '<div class="gen-progress"><div class="gen-progress-bar"><div class="gen-progress-fill"></div></div><div class="gen-progress-text"></div></div>';
      progressWrap = streamEl.querySelector('.gen-progress');
    }
    var fill = progressWrap.querySelector('.gen-progress-fill');
    var text = progressWrap.querySelector('.gen-progress-text');
    if (progressMatch) {
      var pct = parseInt(progressMatch[3], 10);
      if (fill) fill.style.width = pct + '%';
      if (text) text.textContent = data.content;
    } else {
      // Status message — show text, extract % if present for bar
      var statusPct = pctFromStatus ? parseInt(pctFromStatus[1], 10) : 0;
      if (fill && statusPct > 0) fill.style.width = statusPct + '%';
      if (text) text.textContent = data.content;
    }
  } else {
    // Accumulate raw text for markdown rendering
    if (data.reset) { streamEl.textContent = ''; streamEl._rawText = ''; }
    if (data.content) {
      if (!streamEl._rawText) streamEl._rawText = '';
      streamEl._rawText += data.content;
      // Render as markdown for executor tools, plain text for others
      var isExec = entry.toolName && /^(generate_|gen_|extract_)/.test(entry.toolName);
      if (isExec) {
        streamEl.innerHTML = renderMarkdown(streamEl._rawText) + '<span class="streaming-cursor-inline"></span>';
      } else {
        streamEl.textContent = streamEl._rawText;
      }
    }
    if (data.done && streamEl._rawText) {
      // Final render without cursor
      var isExecFinal = entry.toolName && /^(generate_|gen_|extract_)/.test(entry.toolName);
      if (isExecFinal) {
        streamEl.innerHTML = renderMarkdown(streamEl._rawText);
      }
    }
  }

  // Auto-open tool body (gen-cards are always open via CSS, but regular tool cards need the class)
  const body = entry.card.querySelector('.tool-body');
  if (body && !body.classList.contains('open')) {
    body.classList.add('open');
    var chevron = entry.card.querySelector('.tool-chevron');
    if (chevron) chevron.classList.add('open');
  }
  maybeScroll();
}

function toggleToolBody(header) {
  const chevron = header.querySelector('.tool-chevron');
  const body = header.nextElementSibling;
  chevron.classList.toggle('open');
  body.classList.toggle('open');
}

function copyCardText(btn, event) {
  if (event) event.stopPropagation();
  // Walk up to find the closest card-like container
  var card = btn.closest('.tool-card') || btn.closest('.question-card') || btn.closest('.msg');
  if (!card) return;
  var parts = [];

  // Tool card: name, arguments, streaming content, result
  var nameEl = card.querySelector('.tool-name');
  if (nameEl) parts.push('Tool: ' + nameEl.textContent);
  var argsPre = card.querySelector('.tool-body > pre');
  if (argsPre && argsPre.textContent) parts.push('Arguments:\\n' + argsPre.textContent);
  var streamEl = card.querySelector('.tool-streaming-content');
  if (streamEl && streamEl.textContent.trim()) parts.push('Output:\\n' + streamEl.textContent.trim());
  var resultEl = card.querySelector('.tool-result-section');
  if (resultEl && resultEl.style.display !== 'none') {
    var resultText = resultEl.textContent || '';
    resultText = resultText.replace(_resultPrefixRe, '').trim();
    if (resultText) parts.push('Result:\\n' + resultText);
  }
  // Think card body (md content)
  var mdResult = card.querySelector('.tool-md-result');
  if (mdResult && !argsPre) parts.push(mdResult.textContent || '');
  // Question card
  var qText = card.querySelector('.question-text');
  if (qText) parts.push(qText.textContent || '');
  var answeredLabel = card.querySelector('.question-answered-label');
  if (answeredLabel) parts.push(answeredLabel.textContent || '');
  // Agent message
  var msgContent = card.querySelector('.msg-content');
  if (msgContent && !nameEl && !qText) parts.push(msgContent.textContent || '');
  // Gen card sections
  var genPrompt = card.querySelector('.gen-prompt');
  if (genPrompt) parts.push('Prompt:\\n' + genPrompt.textContent);
  var genRefs = card.querySelectorAll('.gen-ref-path');
  if (genRefs.length > 0) {
    var refs = [];
    genRefs.forEach(function(r) { refs.push(r.textContent); });
    parts.push('References:\\n' + refs.join('\\n'));
  }

  var text = parts.filter(function(p) { return p && p.trim(); }).join('\\n\\n');
  navigator.clipboard.writeText(text).then(function() {
    btn.textContent = '\\u2713 Copied';
    btn.classList.add('copied');
    setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
  }).catch(function() {});
}

// ===== Media in Results =====
function renderImagesInResult(container, text) {
  const mediaPattern = _mediaPatternRe;
  const matches = text.match(mediaPattern);
  if (!matches || !selectedProject) return;

  const seen = new Set();
  matches.forEach(path => {
    if (seen.has(path)) return;
    seen.add(path);
    let assetPath = path;
    const assetsIdx = path.indexOf('assets/');
    if (assetsIdx >= 0) assetPath = path.substring(assetsIdx);
    const url = '/api/v1/assets/' + selectedProject + '/' + assetPath;
    if (isVideoUrl(path)) {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.style.maxWidth = '300px';
      video.style.borderRadius = '6px';
      video.style.marginTop = '8px';
      video.onerror = function() { this.remove(); };
      container.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = url;
      img.style.maxWidth = '300px';
      img.style.borderRadius = '6px';
      img.style.marginTop = '8px';
      img.style.cursor = 'pointer';
      img.onclick = function() { openLightbox(url); };
      img.onerror = function() { this.remove(); };
      container.appendChild(img);
    }
  });
}

// ===== Questions =====
function stopQuestionTimer(card) {
  if (questionTimerInterval) {
    clearInterval(questionTimerInterval);
    questionTimerInterval = null;
  }
  // Update UI to show timer was cancelled
  var tb = card.querySelector('.question-timer-bar');
  if (tb) tb.remove();
  var tt = card.querySelector('.question-timer-text');
  if (tt) { tt.textContent = 'Auto-approve cancelled'; setTimeout(function() { tt.remove(); }, 2000); }
}

function handleQuestion(data) {
  // Finalize any ongoing stream first
  finalizeStream();

  // Clear any previous timer
  if (questionTimerInterval) { clearInterval(questionTimerInterval); questionTimerInterval = null; }

  var question = data.question || '';
  var options = data.options || [];
  var isConfirmation = data.isConfirmation || data.toolCallId === 'confirmation';
  var autoApproveMs = data.autoApproveTimeoutMs || 0;

  // In autonomous mode, auto-respond with first option immediately
  if (autonomousModeActive && options.length > 0) {
    var autoResponse = options[0].label || options[0];
    wsSend({ type: 'user_response', sessionId: sessionId, data: { response: autoResponse } });
    addSystemMessage('[Auto] ' + question.slice(0, 80) + ' → ' + autoResponse);
    return;
  }

  // If confirmation and no options provided, default to Yes/No
  if (isConfirmation && options.length === 0) {
    options = [
      { label: 'Yes', description: 'Confirm and proceed' },
      { label: 'No', description: 'Decline' },
    ];
  }

  var container = currentAgentGroup ? currentAgentGroup.bodyEl : chatMessages;

  var card = document.createElement('div');
  card.className = 'question-card';
  activeQuestionCard = card;

  // Header
  var header = document.createElement('div');
  header.className = 'question-header';
  header.innerHTML = '<div class="question-icon">?</div><button class="tool-copy-btn" style="opacity:0.4;margin-left:auto" onclick="copyCardText(this, event)">Copy</button>';
  card.appendChild(header);

  // Question text
  var textEl = document.createElement('div');
  textEl.className = 'question-text';
  textEl.innerHTML = renderMarkdown(question);
  card.appendChild(textEl);

  // Options
  var selectedOption = null;
  if (options.length > 0) {
    var optionsEl = document.createElement('div');
    optionsEl.className = 'question-options';

    options.forEach(function(opt, idx) {
      var optBtn = document.createElement('button');
      optBtn.className = 'question-option';
      optBtn.innerHTML =
        '<div class="question-option-radio"></div>' +
        '<div class="question-option-content">' +
          '<div class="question-option-label">' + escHtml(opt.label || opt) + '</div>' +
          (opt.description ? '<div class="question-option-desc">' + escHtml(opt.description) + '</div>' : '') +
        '</div>';

      optBtn.onclick = function() {
        // Stop auto-approve timer on any user interaction
        stopQuestionTimer(card);
        // Deselect all
        optionsEl.querySelectorAll('.question-option').forEach(function(o) { o.classList.remove('selected'); });
        optBtn.classList.add('selected');
        selectedOption = opt.label || opt;
        // Enable submit
        var submitBtn = card.querySelector('.question-submit-btn');
        if (submitBtn) submitBtn.disabled = false;
        // If the option is "Other" or "Provide feedback", show custom input
        var customWrap = card.querySelector('.question-custom-wrap');
        if (customWrap) {
          var isCustom = (selectedOption || '').toLowerCase() === 'other' || (selectedOption || '').toLowerCase() === 'provide feedback';
          customWrap.style.display = isCustom ? 'flex' : 'none';
          if (isCustom) customWrap.querySelector('input').focus();
        }
      };

      // Auto-select first option
      if (idx === 0) {
        optBtn.classList.add('selected');
        selectedOption = opt.label || opt;
      }

      optionsEl.appendChild(optBtn);
    });
    card.appendChild(optionsEl);
  }

  // Custom input for "Other"
  var customWrap = document.createElement('div');
  customWrap.className = 'question-custom-wrap';
  customWrap.style.display = 'none';
  var customInput = document.createElement('input');
  customInput.className = 'question-custom-input';
  customInput.placeholder = 'Type your response...';
  customInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') submitQuestion();
  });
  customInput.addEventListener('input', function() { stopQuestionTimer(card); });
  customWrap.appendChild(customInput);
  card.appendChild(customWrap);

  // Actions row
  var actionsEl = document.createElement('div');
  actionsEl.className = 'question-actions';
  var submitBtn = document.createElement('button');
  submitBtn.className = 'question-submit-btn';
  submitBtn.textContent = options.length > 0 ? 'Submit' : 'Reply';
  submitBtn.disabled = options.length > 0 ? false : true; // enabled if options pre-selected
  submitBtn.onclick = function() { submitQuestion(); };
  actionsEl.appendChild(submitBtn);

  // If no options, show a text input inline
  if (options.length === 0) {
    var freeInput = document.createElement('input');
    freeInput.className = 'question-custom-input';
    freeInput.placeholder = 'Type your response...';
    freeInput.style.flex = '1';
    freeInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') submitQuestion();
    });
    freeInput.addEventListener('input', function() {
      stopQuestionTimer(card);
      submitBtn.disabled = !freeInput.value.trim();
    });
    actionsEl.insertBefore(freeInput, submitBtn);
    card._freeInput = freeInput;
  }

  card.appendChild(actionsEl);

  // Timer bar
  if (autoApproveMs > 0 && options.length > 0) {
    var timerBar = document.createElement('div');
    timerBar.className = 'question-timer-bar';
    var timerFill = document.createElement('div');
    timerFill.className = 'question-timer-fill';
    timerFill.style.width = '100%';
    timerBar.appendChild(timerFill);
    card.appendChild(timerBar);

    var timerText = document.createElement('div');
    timerText.className = 'question-timer-text';
    var secsLeft = Math.ceil(autoApproveMs / 1000);
    timerText.textContent = 'Auto-approving in ' + secsLeft + 's...';
    card.appendChild(timerText);

    var startTime = Date.now();
    questionTimerInterval = setInterval(function() {
      var elapsed = Date.now() - startTime;
      var remaining = Math.max(0, autoApproveMs - elapsed);
      var pct = (remaining / autoApproveMs) * 100;
      timerFill.style.width = pct + '%';
      timerText.textContent = 'Auto-approving in ' + Math.ceil(remaining / 1000) + 's...';
      if (remaining <= 0) {
        clearInterval(questionTimerInterval);
        questionTimerInterval = null;
        submitQuestion();
      }
    }, 100);
  }

  container.appendChild(card);
  maybeScroll();

  function submitQuestion() {
    if (questionTimerInterval) { clearInterval(questionTimerInterval); questionTimerInterval = null; }
    var response = '';

    // Check for custom/free input
    var customVal = customInput.value.trim();
    var freeVal = card._freeInput ? card._freeInput.value.trim() : '';

    if (freeVal) {
      response = freeVal;
    } else if ((selectedOption || '').toLowerCase() === 'other' || (selectedOption || '').toLowerCase() === 'provide feedback') {
      response = customVal || selectedOption;
    } else if (selectedOption) {
      response = selectedOption;
    }

    if (!response) return;

    // Mark card as answered
    card.classList.add('answered');
    var answeredLabel = document.createElement('div');
    answeredLabel.className = 'question-answered-label';
    answeredLabel.textContent = 'Answered: ' + response;
    card.appendChild(answeredLabel);
    // Remove timer
    var tb = card.querySelector('.question-timer-bar');
    if (tb) tb.remove();
    var tt = card.querySelector('.question-timer-text');
    if (tt) tt.remove();

    activeQuestionCard = null;
    wsSend({ type: 'user_response', sessionId, data: { response: response } });
    maybeScroll();
  }
}

// ===== Agent Response =====
function handleAgentResponse(data) {
  var hadStream = !!streamingEl;
  finalizeStream();
  // Suppress agent_response when it's just repeating the question (awaiting_input)
  if (data.status === 'awaiting_input') {
    // Question card is already rendered — don't duplicate
    return;
  }
  // Only render output as a new message if it wasn't already shown via streaming
  if (!hadStream && data.output && data.output.trim()) {
    const el = createAgentMessage();
    el.querySelector('.msg-content').innerHTML = renderMarkdown(data.output);
  }
  sendBtn.disabled = false;
  closeAgentGroup();
}

// ===== Todo Updates =====
function handleTodoUpdate(data) {
  const list = document.getElementById('todo-list');
  if (!data.todos || data.todos.length === 0) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">No todos</div>';
    return;
  }
  list.innerHTML = data.todos.map(function(t) {
    const icon = t.status === 'completed' ? '\\u2713' :
                 t.status === 'in_progress' ? '\\u25B6' : '\\u25CB';
    const indent = (t.depth || 0) * 12;
    return '<div class="todo-item" style="padding-left:' + indent + 'px">' +
      '<span class="todo-icon ' + t.status + '">' + icon + '</span>' +
      '<span class="todo-text">' + escHtml(t.task) + '</span></div>';
  }).join('');
}

// ===== Context Usage =====
function handleContextUsage(data) {
  const pct = Math.round(data.percentage || 0);
  document.getElementById('context-fill').style.width = pct + '%';
  document.getElementById('context-label').textContent = 'CTX ' + pct + '%';
  const fill = document.getElementById('context-fill');
  fill.style.background = pct > 80 ? 'var(--red)' : pct > 60 ? 'var(--orange)' : 'var(--accent)';
}

// ===== Phase Transitions =====
function handlePhaseTransition(data) {
  document.getElementById('phase-display').textContent = data.displayName || data.toPhase;
  closeAgentGroup();
  const el = document.createElement('div');
  el.className = 'phase-transition';
  el.innerHTML = '<span class="phase-icon">&#x2192;</span>' +
    '<span class="phase-text">' + escHtml(data.displayName || data.toPhase) + '</span>' +
    (data.description ? '<span class="phase-desc"> \\u2014 ' + escHtml(data.description) + '</span>' : '');
  chatMessages.appendChild(el);
  maybeScroll();
}

// ===== Notifications =====
function handleNotification(data) { showToast(data.message, data.level || 'info'); }

function handleSessionTimer(data) {
  var timerEl = document.getElementById('session-timer');
  if (!timerEl) return;

  sessionElapsedMs = data.elapsedMs || 0;
  timerEl.style.display = '';

  // Clear any existing interval
  if (sessionTimerInterval) { clearInterval(sessionTimerInterval); sessionTimerInterval = null; }

  if (data.completed) {
    // Production complete — show final time in green
    timerEl.textContent = formatTimer(Math.floor(sessionElapsedMs / 1000));
    timerEl.style.color = '#4ade80';
    sessionTimerLocalStart = null;
  } else if (data.running) {
    // Agent actively running — start live counter from accumulated base
    sessionTimerLocalStart = Date.now();
    timerEl.style.color = 'var(--text-muted)';
    function tick() {
      var total = sessionElapsedMs + (Date.now() - sessionTimerLocalStart);
      timerEl.textContent = formatTimer(Math.floor(total / 1000));
    }
    tick();
    sessionTimerInterval = setInterval(tick, 1000);
  } else {
    // Paused (agent not running, between runs)
    timerEl.textContent = formatTimer(Math.floor(sessionElapsedMs / 1000));
    timerEl.style.color = 'var(--text-muted)';
    sessionTimerLocalStart = null;
  }
}

function formatTimer(totalSeconds) {
  var h = Math.floor(totalSeconds / 3600);
  var m = Math.floor((totalSeconds % 3600) / 60);
  var s = totalSeconds % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function showToast(message, level) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast ' + level;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(function() { toast.style.opacity = '0'; setTimeout(function() { toast.remove(); }, 300); }, 4000);
}

// ===== Error =====
function handleError(data) {
  // Suppress "already running" error from auto-resume on reconnect
  if (data.message && data.message.includes('already has a running task')) return;
  const el = document.createElement('div');
  el.className = 'msg error';
  el.innerHTML = '<div class="msg-content"><strong>Error:</strong> ' + escHtml(data.message) + '</div>';
  chatMessages.appendChild(el);
  sendBtn.disabled = false;
  maybeScroll();
}

// ===== Send Message =====
function sendMessage() {
  var text = inputBox.value.trim();
  if (!text && attachedFiles.length === 0) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // Build task with attached file paths
  var task = text;
  if (attachedFiles.length > 0) {
    var filePaths = attachedFiles.map(function(f) { return f.path; }).join('\\n');
    task = (text ? text + '\\n\\n' : '') + 'Attached files:\\n' + filePaths;
  }

  addUserMessage(text || 'Attached ' + attachedFiles.length + ' file(s)');

  // If wizard is on content step, send create_project instead of start_task
  if (newProjectState && newProjectState.step === 'content') {
    wsSend({
      type: 'create_project',
      sessionId: sessionId,
      data: {
        title: text.slice(0, 60),
        templateId: newProjectState.templateId,
        style: newProjectState.style,
        duration: newProjectState.duration,
        resolution: newProjectState.resolution || '480p',
        resolutionWidth: newProjectState.resolutionWidth || 848,
        resolutionHeight: newProjectState.resolutionHeight || 480,
        content: text,
        autonomousMode: newProjectState.autonomousMode || false,
      },
    });
    addSystemMessage('Creating project with ' + newProjectState.templateName + ' / ' + newProjectState.styleName + ' / ' + newProjectState.durationLabel + '...');
    pendingAutoTask = 'Start working on this project. The project has just been created with the user content.';
    newProjectState = null;
    inputBox.placeholder = 'Type a task...';
  } else {
    wsSend({ type: 'start_task', sessionId, data: { task: task } });
  }

  inputBox.value = '';
  inputBox.style.height = 'auto';
  sendBtn.disabled = true;
  clearAttachedFiles();
}

function addUserMessage(text) {
  closeAgentGroup();
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = '<div class="msg-content">' + escHtml(text) + '</div>';
  chatMessages.appendChild(el);
  maybeScroll();
}

function addSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg system';
  el.textContent = text;
  chatMessages.appendChild(el);
}

// ===== File Attachments =====
var attachedFilesEl = document.getElementById('attached-files');
var chatContainer = document.getElementById('chat-container');
var dropOverlay = null;

function renderAttachedFiles() {
  if (attachedFiles.length === 0) {
    attachedFilesEl.classList.add('hidden');
    attachedFilesEl.innerHTML = '';
    return;
  }
  attachedFilesEl.classList.remove('hidden');
  attachedFilesEl.innerHTML = '';
  attachedFiles.forEach(function(f, i) {
    var el = document.createElement('div');
    el.className = 'attached-file';
    var isImg = /\\.(png|jpg|jpeg|webp|gif)$/i.test(f.name);
    el.innerHTML = (isImg ? '<img src="' + f.url + '">' : '') +
      '<span class="file-name">' + escHtml(f.name) + '</span>' +
      '<span class="file-remove" data-idx="' + i + '">&times;</span>';
    el.querySelector('.file-remove').onclick = function() {
      attachedFiles.splice(i, 1);
      renderAttachedFiles();
    };
    attachedFilesEl.appendChild(el);
  });
}

function clearAttachedFiles() {
  attachedFiles = [];
  renderAttachedFiles();
}

async function uploadFile(file) {
  try {
    var res = await fetch('/api/v1/upload?filename=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    var data = await res.json();
    attachedFiles.push({ name: data.name, path: data.path, url: data.url });
    renderAttachedFiles();
  } catch(e) {
    console.error('Upload failed:', e);
    addSystemMessage('Upload failed: ' + file.name);
  }
}

// Drag and drop on chat container
chatContainer.addEventListener('dragover', function(e) {
  e.preventDefault();
  e.stopPropagation();
  if (!dropOverlay) {
    dropOverlay = document.createElement('div');
    dropOverlay.className = 'drop-overlay';
    dropOverlay.textContent = 'Drop files here';
    chatContainer.appendChild(dropOverlay);
  }
});

chatContainer.addEventListener('dragleave', function(e) {
  e.preventDefault();
  if (dropOverlay && !chatContainer.contains(e.relatedTarget)) {
    dropOverlay.remove();
    dropOverlay = null;
  }
});

chatContainer.addEventListener('drop', function(e) {
  e.preventDefault();
  e.stopPropagation();
  if (dropOverlay) { dropOverlay.remove(); dropOverlay = null; }
  var files = e.dataTransfer && e.dataTransfer.files;
  if (files) {
    for (var i = 0; i < files.length; i++) {
      uploadFile(files[i]);
    }
  }
});

// Also handle paste of files (e.g. screenshot paste)
inputBox.addEventListener('paste', function(e) {
  var items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (var i = 0; i < items.length; i++) {
    if (items[i].kind === 'file') {
      var file = items[i].getAsFile();
      if (file) uploadFile(file);
    }
  }
});

// ===== Artifact Cache =====
async function loadArtifactCache(projectName) {
  artifactCache = {};
  try {
    var res = await fetch('/api/v1/projects/' + projectName + '/assets');
    var data = await res.json();
    (data.assets || []).forEach(function(a) {
      artifactCache[a.id] = {
        path: a.path,
        url: '/api/v1/assets/' + projectName + '/' + a.path,
        type: a.type || 'unknown',
      };
    });
  } catch(e) { console.error('loadArtifactCache:', e); }
}

function resolveArtifactUrl(artifactId) {
  var entry = artifactCache[artifactId];
  return entry ? entry.url : null;
}

// ===== Project Browser =====
async function loadProjects() {
  try {
    const res = await fetch('/api/v1/projects');
    if (!res.ok) {
      console.error('loadProjects: HTTP', res.status);
      return;
    }
    const data = await res.json();
    const projects = data.projects || [];
    console.log('loadProjects: found', projects.length, 'projects');
    const sel = projectSelect;
    // Keep first option (Select Project...) and remove the rest
    while (sel.options.length > 1) sel.remove(1);
    // Add New Project option first
    var newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '+ New Project';
    sel.appendChild(newOpt);
    projects.forEach(function(p) {
      const opt = document.createElement('option');
      var name = (p.dirName || '').replace('.dhee', '');
      var phase = p.currentPhase || 'unknown';
      opt.value = name;
      opt.textContent = name + ' (' + phase + ')';
      sel.appendChild(opt);
    });
  } catch(e) { console.error('loadProjects:', e); }
}

projectSelect.addEventListener('change', async function() {
  var val = projectSelect.value;
  if (val === '__new__') {
    selectedProject = null;
    projectSelect.value = '';
    startNewProjectWizard();
    return;
  }
  selectedProject = val || null;
  if (selectedProject) {
    inputBox.placeholder = 'Type a task...';
    wsSend({ type: 'select_project', sessionId, data: { projectName: selectedProject } });
    loadProjectDetails(selectedProject);
    loadProjectAssets(selectedProject);
    loadArtifactCache(selectedProject);
    addSystemMessage('Project: ' + selectedProject);
    sendBtn.disabled = true;
    // Wait for 'ready' status from select_project before sending start_task
    pendingAutoTask = 'Continue working on the existing project. The project state is already injected - proceed with the next step.';
  } else {
    inputBox.placeholder = 'Type a task...';
    document.getElementById('asset-browser').innerHTML = '';
    document.getElementById('phase-display').textContent = '-';
  }
});

async function loadProjectDetails(name) {
  try {
    const res = await fetch('/api/v1/projects/' + name);
    if (!res.ok) return;
    const data = await res.json();
    // Derive phase: use currentPhase, or infer from executor state
    var phase = data.currentPhase;
    if (!phase && data.executorState && data.executorState.nodes) {
      var nodes = data.executorState.nodes;
      // Find the last in-progress or most recent pending type
      var inProgress = Object.values(nodes).find(function(n) { return n.status === 'in_progress'; });
      if (inProgress) {
        phase = inProgress.typeId;
      } else {
        // Find first pending node to show what's next
        var firstPending = Object.values(nodes).find(function(n) { return n.status === 'pending'; });
        if (firstPending) phase = firstPending.typeId;
      }
    }
    document.getElementById('phase-display').textContent = (phase || '-').replace(/_/g, ' ');
    if (data.todos && data.todos.length > 0) {
      const list = document.getElementById('todo-list');
      list.innerHTML = data.todos.map(function(t) {
        const icon = t.status === 'completed' ? '\\u2713' : t.status === 'in_progress' ? '\\u25B6' : '\\u25CB';
        return '<div class="todo-item"><span class="todo-icon ' + (t.status || 'pending') + '">' + icon + '</span>' +
          '<span class="todo-text">' + escHtml(t.content || t.task || '') + '</span></div>';
      }).join('');
    }
  } catch(e) { console.error('loadProjectDetails:', e); }
}

async function loadProjectAssets(name) {
  try {
    const res = await fetch('/api/v1/projects/' + name + '/images');
    const data = await res.json();
    const grid = document.getElementById('asset-browser');
    if (!data.images || data.images.length === 0) {
      grid.innerHTML = '<div style="font-size:12px;color:var(--text-muted);grid-column:1/-1">No images</div>';
      return;
    }
    grid.innerHTML = data.images.map(function(img) {
      return '<img class="asset-thumb" src="' + img.url + '" title="' + escHtml(img.name) +
        '" onclick="openLightbox(this.src)" onerror="this.remove()">';
    }).join('');
  } catch(e) {
    document.getElementById('asset-browser').innerHTML = '<div style="font-size:12px;color:var(--text-muted);grid-column:1/-1">Failed to load</div>';
  }
}

// ===== Lightbox =====
function isVideoUrl(src) {
  return /\\.(mp4|webm|mov)(\\?|$)/i.test(src);
}
function openLightbox(src) {
  var imgEl = document.getElementById('lightbox-img');
  var vidEl = document.getElementById('lightbox-video');
  if (isVideoUrl(src)) {
    imgEl.style.display = 'none';
    vidEl.style.display = 'block';
    vidEl.src = src;
    vidEl.play();
  } else {
    vidEl.style.display = 'none';
    vidEl.pause();
    imgEl.style.display = 'block';
    imgEl.src = src;
  }
  document.getElementById('lightbox').classList.remove('hidden');
}
function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  var vidEl = document.getElementById('lightbox-video');
  vidEl.pause();
  vidEl.src = '';
}

// ===== Auto-scroll =====
const chatEl = document.getElementById('chat-messages');
chatEl.addEventListener('scroll', function() {
  const atBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 60;
  autoScroll = atBottom;
  scrollBtn.classList.toggle('hidden', atBottom);
});
function scrollToBottom() { chatEl.scrollTop = chatEl.scrollHeight; autoScroll = true; scrollBtn.classList.add('hidden'); }
function maybeScroll() { if (autoScroll) requestAnimationFrame(function() { chatEl.scrollTop = chatEl.scrollHeight; }); }

// ===== Input handling =====
inputBox.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
inputBox.addEventListener('input', function() {
  inputBox.style.height = 'auto';
  inputBox.style.height = Math.min(inputBox.scrollHeight, 120) + 'px';
});
// ===== Double-Escape to pause agent =====
var lastEscTime = 0;
var escHintTimeout = null;
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeLightbox();
    var now = Date.now();
    if (now - lastEscTime < 500) {
      // Double-press: send cancel
      lastEscTime = 0;
      if (escHintTimeout) { clearTimeout(escHintTimeout); escHintTimeout = null; hideEscHint(); }
      if (sendBtn.disabled && ws && ws.readyState === WebSocket.OPEN) {
        wsSend({ type: 'cancel', sessionId: sessionId });
        addSystemMessage('Agent paused — you can now provide input to steer the conversation.');
        showToast('Agent paused', 'info');
      }
    } else {
      // First press: show hint
      lastEscTime = now;
      showEscHint();
      escHintTimeout = setTimeout(function() { hideEscHint(); escHintTimeout = null; }, 1500);
    }
  }
});

function showEscHint() {
  var hint = document.getElementById('esc-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'esc-hint';
    hint.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.8);color:#fff;padding:6px 16px;border-radius:6px;font-size:13px;z-index:9999;pointer-events:none;transition:opacity 0.2s;';
    document.body.appendChild(hint);
  }
  hint.textContent = 'Press Esc again to pause agent';
  hint.style.opacity = '1';
}
function hideEscHint() {
  var hint = document.getElementById('esc-hint');
  if (hint) hint.style.opacity = '0';
}

// ===== Markdown Renderer =====
function renderMarkdown(text) {
  if (!text) return '';
  let html = escHtml(text);

  // Code blocks
  html = html.replace(_codeBlockRe, function(m, lang, code) {
    return '<pre><code>' + code + '</code></pre>';
  });

  // Inline code
  html = html.replace(/\`([^\`]+?)\`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold + italic
  html = html.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  html = html.replace(/^[\\-\\*] (.+)$/gm, '<li>$1</li>');
  // Wrap consecutive li in ul
  html = html.replace(_ulWrapRe, '<ul>$1</ul>');

  // Ordered lists
  html = html.replace(_olListRe, '<li>$1</li>');

  // Links
  html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank">$1</a>');

  // Images
  html = html.replace(/!\\[([^\\]]*?)\\]\\(([^)]+)\\)/g, '<img src="$2" alt="$1">');

  // Paragraphs
  html = html.replace(_doubleNewlineRe, '</p><p>');
  html = html.replace(_singleNewlineRe, '<br>');
  html = '<p>' + html + '</p>';

  // Clean up
  html = html.replace(/<p><\\/p>/g, '');
  html = html.replace(/<p>(<h[123]>)/g, '$1');
  html = html.replace(/(<\\/h[123]>)<\\/p>/g, '$1');
  html = html.replace(/<p>(<ul>)/g, '$1');
  html = html.replace(/(<\\/ul>)<\\/p>/g, '$1');
  html = html.replace(/<p>(<pre>)/g, '$1');
  html = html.replace(/(<\\/pre>)<\\/p>/g, '$1');
  html = html.replace(/<p>(<blockquote>)/g, '$1');
  html = html.replace(/(<\\/blockquote>)<\\/p>/g, '$1');

  return html;
}

// ===== Utilities =====
function escHtml(str) {
  if (typeof str !== 'string') str = String(str);
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncStr(str, max) {
  if (!str || str.length <= max) return str;
  return str.substring(0, max) + '...';
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  var secs = Math.floor(ms / 1000);
  if (secs < 60) return secs + 's';
  var mins = Math.floor(secs / 60);
  var remSecs = secs % 60;
  return mins + 'm ' + remSecs + 's';
}

// ===== New Project Wizard =====
async function startNewProjectWizard() {
  try {
    var res = await fetch('/api/v1/templates');
    var data = await res.json();
    newProjectState = {
      step: 'template',
      templateId: null,
      templateName: null,
      style: null,
      styleName: null,
      duration: null,
      durationLabel: null,
      templates: data.templates || [],
      durationPresets: data.durationPresets || {},
    };
    showWizardStep('template');
  } catch(e) {
    console.error('Failed to fetch templates:', e);
    addSystemMessage('Failed to load templates. Please try again.');
  }
}

function removeWizardStepsFrom(stepOrder) {
  // Remove all wizard-step cards at or after the given step order
  var steps = chatMessages.querySelectorAll('.wizard-step');
  steps.forEach(function(el) {
    var order = Number(el.dataset.wizardOrder || 0);
    if (order >= stepOrder) el.remove();
  });
  // Reset placeholder if we removed the content step
  inputBox.placeholder = 'Type a task...';
}

var WIZARD_STEP_ORDER = { template: 1, style: 2, duration: 3, resolution: 4, autonomous: 5, content: 6 };

var RESOLUTION_PRESETS = [
  { id: '480p', label: '480p', width: 848, height: 480, desc: 'Fast preview' },
  { id: '720p', label: '720p', width: 1280, height: 720, desc: 'Standard' },
  { id: '1080p', label: '1080p', width: 1920, height: 1080, desc: 'Full HD' },
  { id: '2k', label: '2K', width: 2560, height: 1440, desc: 'High quality' },
  { id: '4k', label: '4K', width: 3840, height: 2160, desc: 'Ultra HD' },
];

function showWizardStep(step) {
  if (!newProjectState) return;
  newProjectState.step = step;

  // Remove any existing steps at or after this one
  removeWizardStepsFrom(WIZARD_STEP_ORDER[step]);

  var card = document.createElement('div');
  card.className = 'wizard-step';
  card.dataset.wizardOrder = String(WIZARD_STEP_ORDER[step]);

  if (step === 'template') {
    card.innerHTML =
      '<div class="wizard-step-label">Step 1 of 5</div>' +
      '<div class="wizard-step-title">Choose a Template</div>' +
      '<div class="wizard-cards"></div>';
    var grid = card.querySelector('.wizard-cards');
    newProjectState.templates.forEach(function(t) {
      var btn = document.createElement('div');
      btn.className = 'wizard-card';
      btn.innerHTML =
        '<div class="wizard-card-name">' + escHtml(t.displayName) + '</div>' +
        '<div class="wizard-card-desc">' + escHtml(t.description || '') + '</div>';
      btn.onclick = function() {
        newProjectState.templateId = t.id;
        newProjectState.templateName = t.displayName;
        grid.querySelectorAll('.wizard-card').forEach(function(c) { c.classList.remove('selected'); });
        btn.classList.add('selected');
        showWizardStep('style');
      };
      grid.appendChild(btn);
    });
    // Add "Other" option
    var otherBtn = document.createElement('div');
    otherBtn.className = 'wizard-card';
    otherBtn.innerHTML =
      '<div class="wizard-card-name">Other</div>' +
      '<div class="wizard-card-desc">Custom project type</div>';
    otherBtn.onclick = function() {
      newProjectState.templateId = 'narrative';
      newProjectState.templateName = 'Other (Narrative)';
      grid.querySelectorAll('.wizard-card').forEach(function(c) { c.classList.remove('selected'); });
      otherBtn.classList.add('selected');
      showWizardStep('style');
    };
    grid.appendChild(otherBtn);

  } else if (step === 'style') {
    var template = newProjectState.templates.find(function(t) { return t.id === newProjectState.templateId; });
    var styles = template ? (template.styles || []) : [];

    card.innerHTML =
      '<div class="wizard-step-label">Step 2 of 5</div>' +
      '<div class="wizard-step-title">Choose a Style</div>' +
      '<div class="wizard-summary"><span class="wizard-summary-tag">' + escHtml(newProjectState.templateName) + '</span></div>' +
      '<div class="wizard-cards"></div>';
    var grid = card.querySelector('.wizard-cards');

    if (styles.length === 0) {
      // No styles defined, skip to duration
      newProjectState.style = template ? (template.defaultStyle || 'default') : 'default';
      newProjectState.styleName = 'Default';
      showWizardStep('duration');
      return;
    }

    styles.forEach(function(s) {
      var btn = document.createElement('div');
      btn.className = 'wizard-card';
      btn.innerHTML =
        '<div class="wizard-card-name">' + escHtml(s.displayName) + '</div>' +
        '<div class="wizard-card-desc">' + escHtml(s.description || '') + '</div>';
      btn.onclick = function() {
        newProjectState.style = s.id;
        newProjectState.styleName = s.displayName;
        grid.querySelectorAll('.wizard-card').forEach(function(c) { c.classList.remove('selected'); });
        btn.classList.add('selected');
        showWizardStep('duration');
      };
      grid.appendChild(btn);
    });

  } else if (step === 'duration') {
    var presets = newProjectState.durationPresets[newProjectState.templateId] || [];

    card.innerHTML =
      '<div class="wizard-step-label">Step 3 of 5</div>' +
      '<div class="wizard-step-title">Choose Duration</div>' +
      '<div class="wizard-summary">' +
        '<span class="wizard-summary-tag">' + escHtml(newProjectState.templateName) + '</span>' +
        '<span class="wizard-summary-tag">' + escHtml(newProjectState.styleName) + '</span>' +
      '</div>' +
      '<div class="wizard-duration-cards"></div>';
    var btnRow = card.querySelector('.wizard-duration-cards');

    presets.forEach(function(p) {
      var btn = document.createElement('button');
      btn.className = 'wizard-duration-btn' + (newProjectState.duration === p.seconds ? ' selected' : '');
      btn.textContent = p.label;
      btn.onclick = function() {
        newProjectState.duration = p.seconds;
        newProjectState.durationLabel = p.label;
        btnRow.querySelectorAll('.wizard-duration-btn').forEach(function(c) { c.classList.remove('selected'); });
        btn.classList.add('selected');
        showWizardStep('resolution');
      };
      btnRow.appendChild(btn);
    });

    // Custom option — inline input (no browser dialog)
    var customWrap = document.createElement('div');
    customWrap.style.cssText = 'display:inline-flex;gap:4px;align-items:center;';
    var customInput = document.createElement('input');
    customInput.type = 'number';
    customInput.placeholder = 'seconds';
    customInput.style.cssText = 'width:80px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:8px;font-size:13px;';
    var customOk = document.createElement('button');
    customOk.className = 'wizard-duration-btn';
    customOk.textContent = 'Set';
    customOk.onclick = function() {
      var val = Number(customInput.value);
      if (val > 0) {
        newProjectState.duration = val;
        newProjectState.durationLabel = val + ' seconds';
        showWizardStep('resolution');
      }
    };
    customInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') customOk.click();
    });
    customWrap.appendChild(customInput);
    customWrap.appendChild(customOk);
    btnRow.appendChild(customWrap);

  } else if (step === 'resolution') {
    if (!newProjectState.resolution) {
      newProjectState.resolution = '480p';
      newProjectState.resolutionWidth = 848;
      newProjectState.resolutionHeight = 480;
    }
    card.innerHTML =
      '<div class="wizard-step-label">Step 4 of 6</div>' +
      '<div class="wizard-step-title">Choose Resolution</div>' +
      '<div class="wizard-summary">' +
        '<span class="wizard-summary-tag">' + escHtml(newProjectState.templateName) + '</span>' +
        '<span class="wizard-summary-tag">' + escHtml(newProjectState.styleName) + '</span>' +
        '<span class="wizard-summary-tag">' + escHtml(newProjectState.durationLabel) + '</span>' +
      '</div>' +
      '<div class="wizard-duration-cards"></div>';
    var resBtnRow = card.querySelector('.wizard-duration-cards');
    RESOLUTION_PRESETS.forEach(function(r) {
      var btn = document.createElement('button');
      btn.className = 'wizard-duration-btn' + (newProjectState.resolution === r.id ? ' selected' : '');
      btn.innerHTML = '<b>' + r.label + '</b><br><span style="font-size:10px;opacity:0.7">' + r.width + '×' + r.height + ' · ' + r.desc + '</span>';
      btn.onclick = function() {
        newProjectState.resolution = r.id;
        newProjectState.resolutionWidth = r.width;
        newProjectState.resolutionHeight = r.height;
        resBtnRow.querySelectorAll('.wizard-duration-btn').forEach(function(c) { c.classList.remove('selected'); });
        btn.classList.add('selected');
        showWizardStep('autonomous');
      };
      resBtnRow.appendChild(btn);
    });
    chatMessages.appendChild(card);
    maybeScroll();
    return;

  } else if (step === 'autonomous') {
    newProjectState.autonomousMode = false;
    card.innerHTML =
      '<div class="wizard-step-label">Step 5 of 6</div>' +
      '<div class="wizard-step-title">Autonomous Mode</div>' +
      '<div class="wizard-summary">' +
        '<span class="wizard-summary-tag">' + escHtml(newProjectState.templateName) + '</span>' +
        '<span class="wizard-summary-tag">' + escHtml(newProjectState.styleName) + '</span>' +
        '<span class="wizard-summary-tag">' + escHtml(newProjectState.durationLabel) + '</span>' +
        '<span class="wizard-summary-tag">' + escHtml(newProjectState.resolution) + '</span>' +
      '</div>' +
      '<div style="margin:12px 0;display:flex;align-items:center;gap:12px;">' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;color:var(--text);">' +
          '<input type="checkbox" id="autonomous-toggle" style="width:18px;height:18px;cursor:pointer;">' +
          '<span>Autonomous Mode</span>' +
        '</label>' +
        '<span style="font-size:12px;color:var(--text-muted);">Skip all approvals \u2014 run end-to-end</span>' +
      '</div>' +
      '<button class="wizard-duration-btn" id="autonomous-next-btn" style="margin-top:8px;">Continue</button>';
    var autoToggle = card.querySelector('#autonomous-toggle');
    var autoNextBtn = card.querySelector('#autonomous-next-btn');
    autoNextBtn.onclick = function() {
      newProjectState.autonomousMode = autoToggle.checked;
      autonomousModeActive = autoToggle.checked;
      showWizardStep('content');
    };
    chatMessages.appendChild(card);
    maybeScroll();
    return;

  } else if (step === 'content') {
    card.innerHTML =
      '<div class="wizard-step-label">Step 6 of 6</div>' +
      '<div class="wizard-step-title">Describe Your Project</div>' +
      '<div class="wizard-summary">' +
        '<span class="wizard-summary-tag">' + escHtml(newProjectState.templateName) + '</span>' +
        '<span class="wizard-summary-tag">' + escHtml(newProjectState.styleName) + '</span>' +
        '<span class="wizard-summary-tag">' + escHtml(newProjectState.durationLabel) + '</span>' +
        (newProjectState.autonomousMode ? '<span class="wizard-summary-tag" style="color:#4ade80;">Autonomous</span>' : '') +
      '</div>';
    chatMessages.appendChild(card);
    inputBox.placeholder = 'Describe your project idea and press Send...';
    inputBox.focus();
    maybeScroll();
    return;
  }

  chatMessages.appendChild(card);
  maybeScroll();
}

// ===== Autonomous Mode Toggle =====
var autoBtn = document.getElementById('autonomous-btn');
function updateAutoBtnStyle() {
  if (autonomousModeActive) {
    autoBtn.style.borderColor = '#4ade80';
    autoBtn.style.color = '#4ade80';
    autoBtn.style.background = 'rgba(74,222,128,0.1)';
  } else {
    autoBtn.style.borderColor = '#444';
    autoBtn.style.color = '#aaa';
    autoBtn.style.background = 'none';
  }
}
autoBtn.addEventListener('click', function() {
  autonomousModeActive = !autonomousModeActive;
  updateAutoBtnStyle();
  wsSend({ type: 'set_autonomous', sessionId: sessionId, data: { enabled: autonomousModeActive } });
  showToast('Autonomous mode ' + (autonomousModeActive ? 'enabled' : 'disabled'), 'info');
});

// ===== Parallel Media Toggle =====
var parallelBtn = document.getElementById('parallel-media-btn');
function updateParallelBtnStyle() {
  if (parallelMediaActive) {
    parallelBtn.textContent = '⇉ Parallel';
    parallelBtn.style.color = '#58a6ff';
    parallelBtn.style.borderColor = '#58a6ff';
  } else {
    parallelBtn.textContent = '▷ Serial';
    parallelBtn.style.color = '#aaa';
    parallelBtn.style.borderColor = '#444';
  }
}
parallelBtn.addEventListener('click', function() {
  parallelMediaActive = !parallelMediaActive;
  updateParallelBtnStyle();
  wsSend({ type: 'set_parallel_media', sessionId: sessionId, data: { enabled: parallelMediaActive } });
  showToast('Media generation: ' + (parallelMediaActive ? 'parallel (remote server)' : 'serial (local)'), 'info');
});

// ===== Provider Settings =====
const provModal = document.getElementById('provider-modal');
const provSettingsBtn = document.getElementById('provider-settings-btn');
const provCancel = document.getElementById('prov-cancel');
const provSave = document.getElementById('prov-save');
const provImageGen = document.getElementById('prov-image-gen');
const provImageEdit = document.getElementById('prov-image-edit');
const provVideoGen = document.getElementById('prov-video-gen');

provSettingsBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/v1/providers');
    const data = await res.json();
    const fillSelect = (sel, items, currentId) => {
      sel.innerHTML = '';
      for (const p of items) {
        if (!p.available) continue;
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === currentId) opt.selected = true;
        sel.appendChild(opt);
      }
    };
    fillSelect(provImageGen, data.providers.imageGeneration, data.currentConfig.imageGeneration);
    fillSelect(provImageEdit, data.providers.imageEditing, data.currentConfig.imageEditing);
    fillSelect(provVideoGen, data.providers.videoGeneration, data.currentConfig.videoGeneration);
    provModal.style.display = 'flex';
  } catch (e) {
    console.error('Failed to load providers:', e);
  }
});

provCancel.addEventListener('click', () => { provModal.style.display = 'none'; });
provModal.addEventListener('click', (e) => { if (e.target === provModal) provModal.style.display = 'none'; });

provSave.addEventListener('click', async () => {
  try {
    await fetch('/api/v1/providers/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageGeneration: provImageGen.value,
        imageEditing: provImageEdit.value,
        videoGeneration: provVideoGen.value,
      }),
    });
    provModal.style.display = 'none';
  } catch (e) {
    console.error('Failed to save provider config:', e);
  }
});

// ===== Workflow Management =====
var wfModal = document.getElementById('workflow-modal');
var wfBtn = document.getElementById('workflows-btn');
var wfClose = document.getElementById('wf-close');
var wfList = document.getElementById('wf-list');
var wfWizard = document.getElementById('wf-wizard');
var wfWizardContent = document.getElementById('wf-wizard-content');
var wfUploadInput = document.getElementById('wf-upload-input');

var PIPELINE_LABELS = {
  image_generation: 'Image Generation',
  image_editing: 'Image Editing',
  image_processing: 'Image Processing',
  video_generation: 'Video Generation',
};

async function loadWorkflows() {
  try {
    var res = await fetch('/api/v1/workflows');
    var data = await res.json();
    renderWorkflowList(data.workflows, data.active);
  } catch (e) {
    wfList.innerHTML = '<div style="color:#f87171;">Failed to load workflows</div>';
  }
}

function renderWorkflowList(grouped, active) {
  var html = '';
  var pipelines = ['image_generation', 'image_editing', 'video_generation', 'image_processing'];
  for (var p of pipelines) {
    var label = PIPELINE_LABELS[p] || p;
    var items = grouped[p] || [];
    var activeId = active[p];
    html += '<div style="margin-bottom:16px;">';
    html += '<div style="font-weight:600;color:#8b9dc3;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">' + escHtml(label) + '</div>';
    if (items.length === 0) {
      html += '<div style="color:#666;font-size:12px;padding:4px 0;">No workflows installed</div>';
    } else {
      for (var wf of items) {
        var isActive = wf.id === activeId;
        var isBuiltIn = wf.builtIn;
        var borderColor = isActive ? '#3b82f6' : '#333';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;margin-bottom:4px;border:1px solid ' + borderColor + ';border-radius:6px;background:#252538;">';
        html += '<div>';
        if (isActive) html += '<span style="color:#3b82f6;margin-right:6px;" title="Active">★</span>';
        html += '<span style="color:#e0e0e0;">' + escHtml(wf.displayName) + '</span>';
        if (isBuiltIn) html += ' <span style="color:#666;font-size:11px;">(built-in)</span>';
        else html += ' <span style="color:#86efac;font-size:11px;">(user)</span>';
        html += '<div style="color:#777;font-size:11px;margin-top:2px;">' + escHtml(wf.llmDescription || '').substring(0, 100) + '</div>';
        html += '</div>';
        html += '<div style="display:flex;gap:6px;flex-shrink:0;">';
        if (!isBuiltIn && !isActive) {
          html += '<button data-wf-action="override" data-wf-id="' + wf.id + '" style="padding:3px 10px;background:#2563eb;color:white;border:none;border-radius:3px;cursor:pointer;font-size:11px;">Set Active</button>';
        }
        if (!isBuiltIn && isActive) {
          html += '<button data-wf-action="revert" data-wf-pipeline="' + p + '" style="padding:3px 10px;background:#444;color:#ccc;border:1px solid #555;border-radius:3px;cursor:pointer;font-size:11px;">Revert</button>';
        }
        if (!isBuiltIn) {
          html += '<button onclick="deleteWorkflow(\'' + wf.id + '\')" style="padding:3px 10px;background:#7f1d1d;color:#fca5a5;border:none;border-radius:3px;cursor:pointer;font-size:11px;">Delete</button>';
        }
        html += '</div></div>';
      }
    }
    html += '</div>';
  }
  wfList.innerHTML = html;
}

window.setWorkflowOverride = async function(id) {
  await fetch('/api/v1/workflows/' + id + '/override', { method: 'PUT' });
  loadWorkflows();
  showToast('Workflow set as active override', 'info');
};

window.clearWorkflowOverride = async function(pipeline) {
  await fetch('/api/v1/workflows/override/' + pipeline, { method: 'DELETE' });
  loadWorkflows();
  showToast('Reverted to built-in default', 'info');
};

window.deleteWorkflow = async function(id) {
  if (!confirm('Delete this workflow? This cannot be undone.')) return;
  await fetch('/api/v1/workflows/' + id, { method: 'DELETE' });
  loadWorkflows();
  showToast('Workflow deleted', 'info');
};

wfBtn.addEventListener('click', function() {
  wfModal.style.display = 'flex';
  wfWizard.style.display = 'none';
  loadWorkflows();
});
wfClose.addEventListener('click', function() { wfModal.style.display = 'none'; });
wfModal.addEventListener('click', function(e) { if (e.target === wfModal) wfModal.style.display = 'none'; });

// Upload handler
wfUploadInput.addEventListener('change', async function(e) {
  var file = e.target.files[0];
  if (!file) return;
  var content = await file.text();
  try {
    showToast('Uploading and analyzing workflow...', 'info');
    var res = await fetch('/api/v1/workflows/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, content: content }),
    });
    var data = await res.json();
    if (data.error) { showToast('Upload failed: ' + data.error, 'error'); return; }
    showWizard(data.filename, data.parsed, content, data.analysis);
  } catch (err) {
    showToast('Upload failed: ' + err, 'error');
  }
  wfUploadInput.value = '';
});

function showWizard(filename, parsed, rawContent, analysis) {
  wfWizard.style.display = 'block';
  var safeName = filename.replace(/\.json$/, '');
  // Use LLM analysis to pre-fill fields if available
  var llmName = analysis ? analysis.displayName : safeName.replace(/_/g, ' ');
  var llmPipeline = analysis ? analysis.pipeline : parsed.detectedPipeline;
  var llmDesc = analysis ? analysis.llmDescription : '';
  var llmCriteria = analysis ? analysis.selectionCriteria : '';
  var llmExplanation = analysis ? analysis.explanation : '';

  var STANDARD_INPUTS = {
    image_generation: ['prompt', 'negative_prompt', 'seed', 'width', 'height', 'filenamePrefix'],
    image_editing: ['base_image', 'prompt', 'negative_prompt', 'reference_image_1', 'reference_image_2', 'seed', 'filenamePrefix'],
    video_generation: ['first_frame', 'last_frame', 'mid_frame', 'prompt', 'seed', 'durationSeconds', 'width', 'height', 'filenamePrefix'],
    image_processing: ['base_image', 'edit_prompt', 'mask', 'seed', 'filenamePrefix'],
  };

  var html = '';

  // LLM analysis summary (if available)
  if (llmExplanation) {
    html += '<div style="margin-bottom:16px;padding:12px;background:#1a2332;border:1px solid #2563eb33;border-radius:6px;">';
    html += '<div style="color:#3b82f6;font-size:11px;font-weight:600;margin-bottom:4px;">AI Analysis</div>';
    html += '<div style="color:#94a3b8;font-size:12px;">' + escHtml(llmExplanation) + '</div>';
    html += '</div>';
  }

  // Step 1: Name & Type
  html += '<div style="margin-bottom:16px;">';
  html += '<label style="display:block;color:#aaa;font-size:12px;margin-bottom:4px;">Workflow ID</label>';
  html += '<input id="wiz-id" value="' + escHtml(safeName) + '" style="width:100%;padding:6px 8px;background:#2a2a3e;color:#e0e0e0;border:1px solid #555;border-radius:4px;box-sizing:border-box;">';
  html += '</div>';

  html += '<div style="margin-bottom:16px;">';
  html += '<label style="display:block;color:#aaa;font-size:12px;margin-bottom:4px;">Display Name</label>';
  html += '<input id="wiz-name" value="' + escHtml(llmName) + '" style="width:100%;padding:6px 8px;background:#2a2a3e;color:#e0e0e0;border:1px solid #555;border-radius:4px;box-sizing:border-box;">';
  html += '</div>';

  html += '<div style="margin-bottom:16px;">';
  html += '<label style="display:block;color:#aaa;font-size:12px;margin-bottom:4px;">Pipeline Type</label>';
  html += '<select id="wiz-pipeline" style="width:100%;padding:6px 8px;background:#2a2a3e;color:#e0e0e0;border:1px solid #555;border-radius:4px;" onchange="updateWizardMappings()">';
  var pipelines = ['image_generation', 'image_editing', 'video_generation', 'image_processing'];
  for (var p of pipelines) {
    var sel = p === llmPipeline ? ' selected' : '';
    html += '<option value="' + p + '"' + sel + '>' + (PIPELINE_LABELS[p] || p) + '</option>';
  }
  html += '</select>';
  if (parsed.detectedPipeline !== 'unknown') {
    html += '<div style="color:#86efac;font-size:11px;margin-top:4px;">Auto-detected: ' + (PIPELINE_LABELS[parsed.detectedPipeline] || parsed.detectedPipeline) + '</div>';
  }
  html += '</div>';

  // Step 2: Map inputs
  html += '<div style="margin-bottom:16px;">';
  html += '<label style="display:block;color:#aaa;font-size:12px;margin-bottom:8px;">Map Input Nodes (' + parsed.inputNodes.length + ' found)</label>';
  html += '<div id="wiz-mappings">';
  for (var i = 0; i < parsed.inputNodes.length; i++) {
    var node = parsed.inputNodes[i];
    html += renderMappingRow(node, i, parsed.detectedPipeline, STANDARD_INPUTS);
  }
  html += '</div></div>';

  // Step 3: LLM Description
  html += '<div style="margin-bottom:16px;">';
  html += '<label style="display:block;color:#aaa;font-size:12px;margin-bottom:4px;">Description (for LLM — what does this workflow do?)</label>';
  html += '<textarea id="wiz-desc" rows="3" style="width:100%;padding:6px 8px;background:#2a2a3e;color:#e0e0e0;border:1px solid #555;border-radius:4px;box-sizing:border-box;resize:vertical;" placeholder="Generates video by interpolating between first and last frame...">' + escHtml(llmDesc) + '</textarea>';
  html += '</div>';

  html += '<div style="margin-bottom:16px;">';
  html += '<label style="display:block;color:#aaa;font-size:12px;margin-bottom:4px;">Selection Criteria (when should LLM pick this?)</label>';
  html += '<textarea id="wiz-criteria" rows="2" style="width:100%;padding:6px 8px;background:#2a2a3e;color:#e0e0e0;border:1px solid #555;border-radius:4px;box-sizing:border-box;resize:vertical;" placeholder="Shot has clear visual start and end difference...">' + escHtml(llmCriteria) + '</textarea>';
  html += '</div>';

  // Save button
  html += '<div style="display:flex;gap:8px;justify-content:flex-end;">';
  html += '<button onclick="cancelWizard()" style="padding:6px 16px;background:#333;color:#ccc;border:1px solid #555;border-radius:4px;cursor:pointer;">Cancel</button>';
  html += '<button onclick="saveWizard(\'' + escHtml(filename) + '\')" style="padding:6px 16px;background:#3b82f6;color:white;border:none;border-radius:4px;cursor:pointer;">Save Workflow</button>';
  html += '</div>';

  wfWizardContent.innerHTML = html;

  // Store parsed data for later
  window._wizParsed = parsed;
  window._wizFilename = filename;
}

function renderMappingRow(node, idx, pipeline, standardInputs) {
  var options = standardInputs[pipeline] || [];
  var html = '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;padding:6px;background:#1a1a2e;border-radius:4px;">';
  html += '<span style="color:#666;font-size:11px;min-width:40px;">Node ' + node.nodeId + '</span>';
  html += '<span style="color:#8b9dc3;font-size:12px;min-width:140px;">' + escHtml(node.title || node.classType) + '</span>';
  html += '<span style="color:#555;font-size:11px;">→</span>';
  html += '<select id="wiz-map-' + idx + '" data-node-id="' + node.nodeId + '" data-class="' + node.classType + '" style="flex:1;padding:4px 6px;background:#2a2a3e;color:#e0e0e0;border:1px solid #555;border-radius:3px;font-size:12px;">';
  html += '<option value="">(leave as default)</option>';
  for (var opt of options) {
    var sel = node.suggestedInput === opt ? ' selected' : '';
    html += '<option value="' + opt + '"' + sel + '>' + opt + '</option>';
  }
  html += '</select></div>';
  return html;
}

window.updateWizardMappings = function() {
  // Re-render mapping dropdowns when pipeline type changes — for now, just reload
  var pipeline = document.getElementById('wiz-pipeline').value;
  var STANDARD_INPUTS = {
    image_generation: ['prompt', 'negative_prompt', 'seed', 'width', 'height', 'filenamePrefix'],
    image_editing: ['base_image', 'prompt', 'negative_prompt', 'reference_image_1', 'reference_image_2', 'seed', 'filenamePrefix'],
    video_generation: ['first_frame', 'last_frame', 'mid_frame', 'prompt', 'seed', 'durationSeconds', 'width', 'height', 'filenamePrefix'],
    image_processing: ['base_image', 'edit_prompt', 'mask', 'seed', 'filenamePrefix'],
  };
  var mappingsEl = document.getElementById('wiz-mappings');
  var html = '';
  for (var i = 0; i < window._wizParsed.inputNodes.length; i++) {
    html += renderMappingRow(window._wizParsed.inputNodes[i], i, pipeline, STANDARD_INPUTS);
  }
  mappingsEl.innerHTML = html;
};

window.cancelWizard = function() {
  wfWizard.style.display = 'none';
};

window.saveWizard = async function(filename) {
  var id = document.getElementById('wiz-id').value.trim();
  var displayName = document.getElementById('wiz-name').value.trim();
  var pipeline = document.getElementById('wiz-pipeline').value;
  var llmDescription = document.getElementById('wiz-desc').value.trim();
  var selectionCriteria = document.getElementById('wiz-criteria').value.trim();

  if (!id || !displayName) { showToast('ID and display name are required', 'error'); return; }

  // Collect parameter mappings
  var mappings = [];
  var inputReqs = [];
  var parsed = window._wizParsed;
  for (var i = 0; i < parsed.inputNodes.length; i++) {
    var sel = document.getElementById('wiz-map-' + i);
    if (sel && sel.value) {
      mappings.push({ input: sel.value, nodeId: sel.dataset.nodeId, field: getFieldForClass(sel.dataset.class) });
      // Build input requirement
      var isImage = sel.dataset.class === 'LoadImage';
      var source = isImage ? 'shot_image' : (sel.value === 'prompt' || sel.value === 'edit_prompt' ? 'shot_motion_directive' : 'system');
      inputReqs.push({ id: sel.value, type: isImage ? 'image' : 'text', source: source, description: sel.value, required: true });
    }
  }

  var outputType = pipeline === 'video_generation' ? 'video' : 'image';

  var manifest = {
    id: id,
    displayName: displayName,
    pipeline: pipeline,
    llmDescription: llmDescription,
    selectionCriteria: selectionCriteria,
    outputType: outputType,
    priority: 10,
    inputRequirements: inputReqs,
    workflowFile: filename,
    format: 'litegraph',
    parameterMappings: mappings,
    builtIn: false,
    active: true,
  };

  try {
    var res = await fetch('/api/v1/workflows/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    var data = await res.json();
    if (data.error) { showToast('Save failed: ' + data.error, 'error'); return; }
    showToast('Workflow configured: ' + displayName, 'info');
    wfWizard.style.display = 'none';
    loadWorkflows();
  } catch (err) {
    showToast('Save failed: ' + err, 'error');
  }
};

function getFieldForClass(classType) {
  var map = {
    'LoadImage': 'image',
    'CLIPTextEncode': 'text',
    'TextEncodeQwenImageEditPlus': 'text',
    'INTConstant': 'value',
    'KSampler': 'seed',
    'RandomNoise': 'noise_seed',
    'EmptySD3LatentImage': 'width',
    'EmptyLatentImage': 'width',
    'SaveImage': 'filename_prefix',
    'VHS_VideoCombine': 'filename_prefix',
  };
  return map[classType] || 'value';
}

// ===== Init =====
loadProjects();
connect();
`;
}
