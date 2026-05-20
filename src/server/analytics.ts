/**
 * Analytics Dashboard - Minimal HTTP server for tool usage analytics.
 *
 * Serves a web dashboard on a separate port (default 3001).
 * Reads from the SQLite database populated by ToolAnalytics.
 */

import * as http from 'http';
import { ToolAnalytics } from '../utils/ToolAnalytics.js';

/**
 * Start the analytics dashboard HTTP server.
 * Returns silently if the database is unavailable.
 */
export async function startAnalyticsDashboard(port: number = 3001): Promise<void> {
  const analytics = ToolAnalytics.instance();
  if (!analytics) return;

  const db = analytics.getDb();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const pathname = url.pathname;

    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    try {
      if (pathname === '/api/stats') {
        handleStats(db, res);
      } else if (pathname === '/api/calls') {
        handleCalls(db, url, res);
      } else if (pathname === '/api/sessions') {
        handleSessions(db, res);
      } else if (pathname === '/') {
        handleDashboard(res);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Port already in use — another instance is probably running
        resolve();
      } else {
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`Analytics dashboard: http://localhost:${port}`);
      resolve();
    });
  });
}

function jsonResponse(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function handleStats(db: import('better-sqlite3').Database, res: http.ServerResponse): void {
  const toolStats = db.prepare(`
    SELECT
      tool_name,
      COUNT(*) as call_count,
      ROUND(AVG(duration_ms), 1) as avg_duration_ms,
      ROUND(SUM(CASE WHEN is_error = 1 THEN 1.0 ELSE 0.0 END) / COUNT(*) * 100, 1) as error_rate,
      MIN(started_at) as first_seen,
      MAX(started_at) as last_seen
    FROM tool_calls
    GROUP BY tool_name
    ORDER BY call_count DESC
  `).all();

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_calls,
      COUNT(DISTINCT session_id) as total_sessions,
      COUNT(DISTINCT agent_name) as total_agents,
      ROUND(AVG(duration_ms), 1) as overall_avg_duration_ms,
      ROUND(SUM(CASE WHEN is_error = 1 THEN 1.0 ELSE 0.0 END) / COUNT(*) * 100, 1) as overall_error_rate
    FROM tool_calls
  `).get();

  jsonResponse(res, { tools: toolStats, totals });
}

function handleCalls(
  db: import('better-sqlite3').Database,
  url: URL,
  res: http.ServerResponse
): void {
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 500);
  const offset = parseInt(url.searchParams.get('offset') ?? '0');
  const toolName = url.searchParams.get('tool');
  const sessionId = url.searchParams.get('session');
  const dateFrom = url.searchParams.get('from');
  const dateTo = url.searchParams.get('to');

  let query = 'SELECT * FROM tool_calls WHERE 1=1';
  const params: Record<string, string | number> = {};

  if (toolName) {
    query += ' AND tool_name = @toolName';
    params['toolName'] = toolName;
  }
  if (sessionId) {
    query += ' AND session_id = @sessionId';
    params['sessionId'] = sessionId;
  }
  if (dateFrom) {
    query += ' AND started_at >= @dateFrom';
    params['dateFrom'] = dateFrom;
  }
  if (dateTo) {
    query += ' AND started_at <= @dateTo';
    params['dateTo'] = dateTo;
  }

  query += ' ORDER BY id DESC LIMIT @limit OFFSET @offset';
  params['limit'] = limit;
  params['offset'] = offset;

  const calls = db.prepare(query).all(params);

  const countQuery = query
    .replace('SELECT *', 'SELECT COUNT(*) as count')
    .replace(/ ORDER BY.*$/, '');
  const countParams = { ...params };
  delete countParams['limit'];
  delete countParams['offset'];
  const total = (db.prepare(countQuery).get(countParams) as { count: number })?.count ?? 0;

  jsonResponse(res, { calls, total, limit, offset });
}

function handleSessions(db: import('better-sqlite3').Database, res: http.ServerResponse): void {
  const sessions = db.prepare(`
    SELECT
      session_id,
      MIN(started_at) as started_at,
      MAX(completed_at) as ended_at,
      COUNT(*) as tool_call_count,
      COUNT(DISTINCT tool_name) as unique_tools,
      COUNT(DISTINCT agent_name) as agents_used,
      ROUND(SUM(duration_ms), 0) as total_duration_ms,
      ROUND(SUM(CASE WHEN is_error = 1 THEN 1.0 ELSE 0.0 END) / COUNT(*) * 100, 1) as error_rate
    FROM tool_calls
    GROUP BY session_id
    ORDER BY started_at DESC
    LIMIT 50
  `).all();

  jsonResponse(res, { sessions });
}

function handleDashboard(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(DASHBOARD_HTML);
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>dhee Tool Analytics</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
  h1 { color: #58a6ff; margin-bottom: 8px; font-size: 24px; }
  h2 { color: #8b949e; margin: 24px 0 12px; font-size: 18px; }
  .subtitle { color: #8b949e; margin-bottom: 24px; font-size: 14px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .stat-value { font-size: 28px; font-weight: 700; color: #58a6ff; }
  .stat-label { font-size: 12px; color: #8b949e; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; }
  th { background: #21262d; color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; padding: 10px 14px; text-align: left; }
  td { padding: 10px 14px; border-top: 1px solid #21262d; font-size: 14px; }
  tr:hover td { background: #1c2128; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover td { background: #1c2128; }
  .breadcrumb { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 14px; color: #8b949e; }
  .breadcrumb a { color: #58a6ff; cursor: pointer; text-decoration: none; }
  .breadcrumb a:hover { text-decoration: underline; }
  .breadcrumb .sep { color: #484f58; }
  .drill-label { background: #388bfd26; border: 1px solid #58a6ff; color: #58a6ff; border-radius: 6px; padding: 4px 10px; font-size: 13px; display: inline-flex; align-items: center; gap: 6px; }
  .drill-label .close-x { cursor: pointer; font-size: 16px; line-height: 1; opacity: 0.7; }
  .drill-label .close-x:hover { opacity: 1; }
  .error-badge { background: #da3633; color: #fff; border-radius: 4px; padding: 2px 6px; font-size: 11px; }
  .success-badge { background: #238636; color: #fff; border-radius: 4px; padding: 2px 6px; font-size: 11px; }
  .duration { color: #f0883e; font-variant-numeric: tabular-nums; }
  .count { color: #58a6ff; font-weight: 600; font-variant-numeric: tabular-nums; }
  .preceding-msg { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8b949e; font-size: 12px; cursor: pointer; }
  .args-cell { font-family: monospace; font-size: 11px; color: #7ee787; }
  .preceding-msg.expanded { white-space: pre-wrap; word-break: break-word; max-width: none; }
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
  .tab { padding: 8px 16px; background: #21262d; border: 1px solid #30363d; border-radius: 6px; cursor: pointer; color: #c9d1d9; font-size: 14px; }
  .tab.active { background: #388bfd26; border-color: #58a6ff; color: #58a6ff; }
  .filters { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; }
  .filters select, .filters input { background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 10px; border-radius: 6px; font-size: 13px; }
  .filters button { background: #238636; border: none; color: #fff; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .filters button:hover { background: #2ea043; }
  .section { display: none; }
  .section.active { display: block; }
  .pagination { display: flex; gap: 8px; margin-top: 12px; justify-content: center; }
  .pagination button { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 12px; border-radius: 6px; cursor: pointer; }
  .pagination button:disabled { opacity: 0.4; cursor: default; }
  .refresh-btn { float: right; background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .refresh-btn:hover { background: #30363d; }
  .session-id { font-family: monospace; font-size: 12px; color: #7ee787; }
  .agent-name { color: #d2a8ff; }
  .empty { text-align: center; padding: 40px; color: #484f58; }
</style>
</head>
<body>
<div style="display: flex; justify-content: space-between; align-items: center;">
  <div>
    <h1>dhee Tool Analytics</h1>
    <div class="subtitle">Tool usage insights for data-driven optimization</div>
  </div>
  <button class="refresh-btn" onclick="loadAll()">Refresh</button>
</div>

<div id="totals" class="stats-grid"></div>

<div class="tabs">
  <div class="tab active" onclick="switchTab('tools')">Tools</div>
  <div class="tab" onclick="switchTab('calls')">Recent Calls</div>
  <div class="tab" onclick="switchTab('sessions')">Sessions</div>
</div>

<div id="tools-section" class="section active">
  <table id="tools-table">
    <thead><tr><th>Tool</th><th>Calls</th><th>Avg Duration</th><th>Error Rate</th><th>Last Seen</th></tr></thead>
    <tbody></tbody>
  </table>
</div>

<div id="calls-section" class="section">
  <div id="calls-breadcrumb" class="breadcrumb" style="display:none;"></div>
  <div class="filters">
    <select id="filter-tool"><option value="">All Tools</option></select>
    <select id="filter-session"><option value="">All Sessions</option></select>
    <button onclick="manualFilter()">Filter</button>
  </div>
  <table id="calls-table">
    <thead><tr><th>Tool</th><th>Agent</th><th>Args</th><th>Duration</th><th>Status</th><th>Preceding Message</th><th>Time</th></tr></thead>
    <tbody></tbody>
  </table>
  <div class="pagination">
    <button id="prev-btn" onclick="changePage(-1)" disabled>&larr; Prev</button>
    <span id="page-info"></span>
    <button id="next-btn" onclick="changePage(1)" disabled>Next &rarr;</button>
  </div>
</div>

<div id="sessions-section" class="section">
  <table id="sessions-table">
    <thead><tr><th>Session</th><th>Started</th><th>Tool Calls</th><th>Unique Tools</th><th>Total Duration</th><th>Error Rate</th></tr></thead>
    <tbody></tbody>
  </table>
</div>

<script>
const API = '';
let currentPage = 0;
const PAGE_SIZE = 50;
let totalCalls = 0;

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById(name + '-section').classList.add('active');
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString();
}

function fmtArgs(json) {
  if (!json) return '-';
  try {
    const obj = typeof json === 'string' ? JSON.parse(json) : json;
    return Object.entries(obj).map(([k,v]) => k + '=' + (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
  } catch { return json; }
}

function fmtTimeShort(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleTimeString();
}

async function loadStats() {
  const res = await fetch(API + '/api/stats');
  const data = await res.json();

  // Totals
  const t = data.totals;
  document.getElementById('totals').innerHTML = [
    { v: t.total_calls, l: 'Total Calls' },
    { v: t.total_sessions, l: 'Sessions' },
    { v: t.total_agents, l: 'Agents' },
    { v: fmtDuration(t.overall_avg_duration_ms), l: 'Avg Duration' },
    { v: (t.overall_error_rate || 0) + '%', l: 'Error Rate' },
  ].map(s => '<div class="stat-card"><div class="stat-value">' + s.v + '</div><div class="stat-label">' + s.l + '</div></div>').join('');

  // Tools table
  const tbody = document.querySelector('#tools-table tbody');
  if (!data.tools.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">No tool calls recorded yet. Run the agent to see analytics.</td></tr>';
    return;
  }
  tbody.innerHTML = data.tools.map(t => '<tr class="clickable" onclick="drillTool(\\''+t.tool_name+'\\')">'+
    '<td><strong>' + t.tool_name + '</strong></td>' +
    '<td class="count">' + t.call_count + '</td>' +
    '<td class="duration">' + fmtDuration(t.avg_duration_ms) + '</td>' +
    '<td>' + (t.error_rate > 0 ? '<span class="error-badge">' + t.error_rate + '%</span>' : '<span class="success-badge">0%</span>') + '</td>' +
    '<td>' + fmtTime(t.last_seen) + '</td>' +
    '</tr>').join('');

  // Populate tool filter
  const toolSelect = document.getElementById('filter-tool');
  const existing = new Set([...toolSelect.options].map(o => o.value));
  data.tools.forEach(t => {
    if (!existing.has(t.tool_name)) {
      const opt = document.createElement('option');
      opt.value = t.tool_name;
      opt.textContent = t.tool_name;
      toolSelect.appendChild(opt);
    }
  });
}

async function loadCalls() {
  // Use activeDrill state as source of truth (dropdowns are secondary UI)
  const tool = activeDrill && activeDrill.type === 'tool' ? activeDrill.value : document.getElementById('filter-tool').value;
  const session = activeDrill && activeDrill.type === 'session' ? activeDrill.value : document.getElementById('filter-session').value;
  let url = API + '/api/calls?limit=' + PAGE_SIZE + '&offset=' + (currentPage * PAGE_SIZE);
  if (tool) url += '&tool=' + encodeURIComponent(tool);
  if (session) url += '&session=' + encodeURIComponent(session);

  const res = await fetch(url);
  const data = await res.json();
  totalCalls = data.total;

  const tbody = document.querySelector('#calls-table tbody');
  if (!data.calls.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">No calls found.</td></tr>';
  } else {
    tbody.innerHTML = data.calls.map(c => '<tr>' +
      '<td><strong>' + c.tool_name + '</strong></td>' +
      '<td class="agent-name">' + c.agent_name + '</td>' +
      '<td class="args-cell preceding-msg" title="Click to expand">' + fmtArgs(c.args_summary) + '</td>' +
      '<td class="duration">' + fmtDuration(c.duration_ms) + '</td>' +
      '<td>' + (c.is_error ? '<span class="error-badge">Error</span>' : '<span class="success-badge">OK</span>') + '</td>' +
      '<td class="preceding-msg" title="Click to expand">' + (c.preceding_message || '-') + '</td>' +
      '<td>' + fmtTimeShort(c.started_at) + '</td>' +
      '</tr>').join('');
  }

  document.getElementById('prev-btn').disabled = currentPage === 0;
  document.getElementById('next-btn').disabled = (currentPage + 1) * PAGE_SIZE >= totalCalls;
  document.getElementById('page-info').textContent = 'Page ' + (currentPage + 1) + ' of ' + Math.max(1, Math.ceil(totalCalls / PAGE_SIZE));
}

async function loadSessions() {
  const res = await fetch(API + '/api/sessions');
  const data = await res.json();

  const tbody = document.querySelector('#sessions-table tbody');
  if (!data.sessions.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No sessions recorded yet.</td></tr>';
    return;
  }
  tbody.innerHTML = data.sessions.map(s => '<tr class="clickable" onclick="drillSession(\\''+s.session_id+'\\')">'+
    '<td class="session-id">' + s.session_id + '</td>' +
    '<td>' + fmtTime(s.started_at) + '</td>' +
    '<td class="count">' + s.tool_call_count + '</td>' +
    '<td>' + s.unique_tools + '</td>' +
    '<td class="duration">' + fmtDuration(s.total_duration_ms) + '</td>' +
    '<td>' + (s.error_rate > 0 ? '<span class="error-badge">' + s.error_rate + '%</span>' : '<span class="success-badge">0%</span>') + '</td>' +
    '</tr>').join('');

  // Populate session filter
  const sessionSelect = document.getElementById('filter-session');
  const existing = new Set([...sessionSelect.options].map(o => o.value));
  data.sessions.forEach(s => {
    if (!existing.has(s.session_id)) {
      const opt = document.createElement('option');
      opt.value = s.session_id;
      opt.textContent = s.session_id.substring(0, 30) + '...';
      sessionSelect.appendChild(opt);
    }
  });
}

function manualFilter() {
  activeDrill = null;
  document.getElementById('calls-breadcrumb').style.display = 'none';
  currentPage = 0;
  loadCalls();
}

function changePage(delta) {
  currentPage += delta;
  if (currentPage < 0) currentPage = 0;
  loadCalls();
}

let activeDrill = null; // { type: 'tool'|'session', value: string }

function drillTool(toolName) {
  activeDrill = { type: 'tool', value: toolName };
  const sel = document.getElementById('filter-tool');
  if (![...sel.options].some(o => o.value === toolName)) {
    const opt = document.createElement('option');
    opt.value = toolName;
    opt.textContent = toolName;
    sel.appendChild(opt);
  }
  sel.value = toolName;
  document.getElementById('filter-session').value = '';
  currentPage = 0;
  showCallsTab();
  updateBreadcrumb();
  loadCalls();
}

function drillSession(sessionId) {
  activeDrill = { type: 'session', value: sessionId };
  // Ensure option exists in dropdown before setting value
  const sel = document.getElementById('filter-session');
  if (![...sel.options].some(o => o.value === sessionId)) {
    const opt = document.createElement('option');
    opt.value = sessionId;
    opt.textContent = sessionId.substring(0, 30) + '...';
    sel.appendChild(opt);
  }
  sel.value = sessionId;
  document.getElementById('filter-tool').value = '';
  currentPage = 0;
  showCallsTab();
  updateBreadcrumb();
  loadCalls();
}

function showCallsTab() {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab')[1].classList.add('active');
  document.getElementById('calls-section').classList.add('active');
}

function updateBreadcrumb() {
  const bc = document.getElementById('calls-breadcrumb');
  if (!activeDrill) {
    bc.style.display = 'none';
    return;
  }
  bc.style.display = 'flex';
  const origin = activeDrill.type === 'tool' ? 'Tools' : 'Sessions';
  const label = activeDrill.type === 'tool' ? activeDrill.value : activeDrill.value.substring(0, 30) + '...';
  bc.innerHTML = '<a onclick="clearDrillAndGoBack()">' + origin + '</a>' +
    '<span class="sep">&rsaquo;</span>' +
    '<span class="drill-label">' + label + '<span class="close-x" onclick="clearDrill(event)">&times;</span></span>';
}

function clearDrill(e) {
  if (e) e.stopPropagation();
  activeDrill = null;
  document.getElementById('filter-tool').value = '';
  document.getElementById('filter-session').value = '';
  document.getElementById('calls-breadcrumb').style.display = 'none';
  currentPage = 0;
  loadCalls();
}

function clearDrillAndGoBack() {
  const tab = activeDrill ? activeDrill.type : null;
  clearDrill();
  if (tab === 'tool') {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.tab')[0].classList.add('active');
    document.getElementById('tools-section').classList.add('active');
  } else if (tab === 'session') {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.tab')[2].classList.add('active');
    document.getElementById('sessions-section').classList.add('active');
  }
}

function loadAll() {
  loadStats();
  loadCalls();
  loadSessions();
}

// Event delegation for expanding preceding messages
document.addEventListener('click', function(e) {
  if (e.target && e.target.classList.contains('preceding-msg')) {
    e.target.classList.toggle('expanded');
  }
});

loadAll();

// Auto-refresh every 3s while tab is visible
let pollTimer = null;
function startPolling() { if (!pollTimer) pollTimer = setInterval(loadAll, 3000); }
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
document.addEventListener('visibilitychange', () => document.hidden ? stopPolling() : startPolling());
startPolling();
</script>
</body>
</html>`;
