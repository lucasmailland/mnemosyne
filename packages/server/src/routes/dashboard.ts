/**
 * Status Dashboard — P22
 *
 * Exposes a single unauthenticated route:
 *   GET /dashboard  → inline HTML operator tool (no auth on the HTML itself)
 *
 * The page contains four sections rendered entirely client-side via vanilla
 * fetch() calls against the existing API:
 *   1. Server Health       — /health/ready + /health/deep (memory:admin)
 *   2. Memory Observability — /health/cognitive (memory:read)
 *   3. LLM/Embedding Config — /config/llm (memory:admin)
 *   4. API Token Management — /admin/keys (admin:keys)
 *
 * Follows the P19 setup wizard pattern exactly:
 *   - Single exported mountDashboard(app) function
 *   - dashboardHtml() template-literal returning the full page
 *   - Dark theme CSS tokens identical to bootstrap.ts
 *   - No CDN, no external scripts, no external fonts
 *
 * Security notes:
 *   - sessionStorage is the only client-side credential store
 *   - localStorage and document.cookie are never written
 *   - 401 from any fetch cancels health interval and re-shows the gate form
 *   - Health section auto-refreshes every 30 s; all other sections are manual
 *
 * ~450 LOC — see docs/archive/sdd/p22-status-dashboard/design.md
 */

import type { Hono } from "hono";

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mnemosyne Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f1117; color: #e0e0e0; margin: 0; padding: 0; }
  a { color: #5865f2; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Layout */
  #app { display: flex; flex-direction: column; min-height: 100vh; }
  #header { background: #1a1d27; border-bottom: 1px solid #2a2d3a; padding: 0.75rem 1.5rem; display: none; align-items: center; justify-content: space-between; }
  #header h1 { font-size: 1.1rem; font-weight: 700; color: #fff; margin: 0; }
  #header-right { display: flex; align-items: center; gap: 1rem; }
  .plan-badge { background: #2a2d3a; color: #a0a4be; font-size: 0.75rem; font-weight: 600; padding: 0.2rem 0.6rem; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
  .workspace-name { color: #a0a4be; font-size: 0.85rem; }
  #main { padding: 1.5rem; max-width: 1100px; margin: 0 auto; width: 100%; display: none; flex-direction: column; gap: 1.5rem; }

  /* Key gate */
  #key-gate { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 2rem; }
  .gate-card { background: #1a1d27; border: 1px solid #2a2d3a; border-radius: 12px; padding: 2.5rem; width: 100%; max-width: 420px; }
  .gate-card h2 { font-size: 1.4rem; font-weight: 700; color: #fff; margin: 0 0 0.4rem; }
  .gate-card p { color: #a0a4be; font-size: 0.9rem; margin: 0 0 1.5rem; }

  /* Cards */
  .card { background: #1a1d27; border: 1px solid #2a2d3a; border-radius: 12px; padding: 1.5rem; }
  .card-title { font-size: 1rem; font-weight: 700; color: #fff; margin: 0 0 1rem; display: flex; align-items: center; justify-content: space-between; }
  .card-title span { font-size: 0.8rem; font-weight: 400; color: #a0a4be; }

  /* Form elements */
  label { display: block; font-size: 0.85rem; font-weight: 600; color: #a0a4be; margin-bottom: 0.3rem; }
  input[type="text"], input[type="password"], select { width: 100%; padding: 0.6rem 0.9rem; background: #12151e; border: 1px solid #2a2d3a; border-radius: 6px; color: #e0e0e0; font-size: 0.9rem; margin-bottom: 1.2rem; outline: none; }
  input[type="text"]:focus, input[type="password"]:focus, select:focus { border-color: #5865f2; }
  button { padding: 0.55rem 1rem; border: none; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 600; transition: background 0.15s; }
  .btn-primary { background: #5865f2; color: #fff; }
  .btn-primary:hover { background: #4752c4; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary { background: #2a2d3a; color: #a0a4be; }
  .btn-secondary:hover { background: #3a3d4a; }
  .btn-danger { background: #3a1c1c; color: #ef4444; border: 1px solid #5a2020; }
  .btn-danger:hover { background: #4a2020; }
  .btn-full { width: 100%; padding: 0.75rem; font-size: 1rem; border-radius: 8px; margin-top: 0.5rem; }

  /* Status badges */
  .badge { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; font-weight: 600; padding: 0.25rem 0.65rem; border-radius: 4px; }
  .badge-ok { background: #0d2b1d; color: #22c55e; }
  .badge-warn { background: #2b2100; color: #eab308; }
  .badge-error { background: #2b0d0d; color: #ef4444; }
  .badge-unknown { background: #1a1d27; color: #a0a4be; border: 1px solid #2a2d3a; }

  /* Health grid */
  .health-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
  .health-item { background: #12151e; border: 1px solid #2a2d3a; border-radius: 8px; padding: 0.85rem 1rem; }
  .health-item-label { font-size: 0.75rem; font-weight: 600; color: #a0a4be; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.4rem; }

  /* Metric cards */
  .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; }
  .metric-card { background: #12151e; border: 1px solid #2a2d3a; border-radius: 8px; padding: 1rem; }
  .metric-label { font-size: 0.73rem; font-weight: 600; color: #a0a4be; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.4rem; }
  .metric-value { font-size: 1.5rem; font-weight: 700; color: #fff; }
  .metric-unit { font-size: 0.75rem; color: #a0a4be; margin-left: 0.2rem; }

  /* SLO table */
  .slo-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-top: 0.75rem; }
  .slo-table th { text-align: left; color: #a0a4be; font-weight: 600; padding: 0.4rem 0.6rem; border-bottom: 1px solid #2a2d3a; }
  .slo-table td { padding: 0.4rem 0.6rem; border-bottom: 1px solid #1f2130; }

  /* LLM config */
  .config-row { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.75rem; }
  .config-label { font-size: 0.8rem; font-weight: 600; color: #a0a4be; min-width: 120px; }
  .config-value { font-size: 0.9rem; color: #e0e0e0; }
  .source-badge { font-size: 0.72rem; font-weight: 600; background: #1a2340; color: #7aa2f7; border: 1px solid #2a3f6f; padding: 0.15rem 0.5rem; border-radius: 3px; }

  /* API keys table */
  .keys-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .keys-table th { text-align: left; color: #a0a4be; font-weight: 600; padding: 0.4rem 0.6rem; border-bottom: 1px solid #2a2d3a; }
  .keys-table td { padding: 0.45rem 0.6rem; border-bottom: 1px solid #1f2130; vertical-align: middle; }

  /* Scope pills */
  .scope-pill { display: inline-block; background: #1e2035; color: #8b9cf4; border: 1px solid #2a3060; font-size: 0.7rem; padding: 0.1rem 0.4rem; border-radius: 3px; margin: 0.1rem 0.15rem 0.1rem 0; }

  /* Create form */
  .create-form { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #2a2d3a; }
  .create-form h4 { font-size: 0.9rem; font-weight: 700; color: #fff; margin: 0 0 1rem; }
  .scope-checks { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1.2rem; }
  .scope-check-label { display: flex; align-items: center; gap: 0.4rem; font-size: 0.82rem; color: #a0a4be; cursor: pointer; }
  .scope-check-label input { width: auto; margin: 0; }

  /* Alerts */
  .alert { padding: 0.85rem 1rem; border-radius: 8px; font-size: 0.875rem; margin-bottom: 0.75rem; }
  .alert-error { background: #2b0d0d; border: 1px solid #5a2020; color: #f87171; }
  .alert-warn { background: #2b1a00; border: 1px solid #5a3800; color: #fbbf24; }
  .alert-info { background: #0d1a2b; border: 1px solid #1a3a5a; color: #60a5fa; }
  .alert-success { background: #0d2b1d; border: 1px solid #1a5a36; color: #4ade80; }

  /* Secret reveal */
  .secret-box { background: #12151e; border: 1px solid #22c55e; border-radius: 6px; padding: 0.85rem 1rem; margin-top: 0.75rem; }
  .secret-box pre { margin: 0; font-size: 0.82rem; white-space: pre-wrap; word-break: break-all; color: #4ade80; }

  /* Misc */
  .row { display: flex; gap: 0.75rem; align-items: flex-end; flex-wrap: wrap; }
  .muted { color: #a0a4be; }
  .text-sm { font-size: 0.82rem; }
  pre { background: #12151e; border: 1px solid #2a2d3a; border-radius: 6px; padding: 1rem; font-size: 0.82rem; white-space: pre-wrap; word-break: break-all; margin: 0; }
</style>
</head>
<body>
<div id="app">

  <!-- ── Key gate ──────────────────────────────────────────────────────── -->
  <div id="key-gate">
    <div class="gate-card">
      <h2>Mnemosyne Dashboard</h2>
      <p>Enter your API key to access the operator dashboard. The key is stored in sessionStorage only and cleared when you close the tab.</p>
      <form id="gate-form">
        <label for="gate-key">API key</label>
        <input type="password" id="gate-key" name="apiKey" placeholder="mns_live_..." autocomplete="off" required>
        <div id="gate-error"></div>
        <button type="submit" class="btn-primary btn-full" id="gate-submit">Unlock</button>
      </form>
    </div>
  </div>

  <!-- ── Header bar ────────────────────────────────────────────────────── -->
  <div id="header">
    <h1>Mnemosyne Dashboard</h1>
    <div id="header-right">
      <span id="workspace-name" class="workspace-name"></span>
      <span id="plan-badge" class="plan-badge"></span>
      <button class="btn-secondary" id="logout-btn">Logout</button>
    </div>
  </div>

  <!-- ── Dashboard sections ────────────────────────────────────────────── -->
  <div id="main">

    <!-- Section 1: Server Health -->
    <div class="card" id="section-health">
      <div class="card-title">
        Server Health
        <span id="health-last-updated"></span>
      </div>
      <div id="health-content"><p class="muted text-sm">Loading…</p></div>
    </div>

    <!-- Section 2: Memory Observability -->
    <div class="card" id="section-observability">
      <div class="card-title">Memory Observability</div>
      <div id="observability-content"><p class="muted text-sm">Loading…</p></div>
    </div>

    <!-- Section 3: LLM / Embedding Config -->
    <div class="card" id="section-llm-config">
      <div class="card-title">LLM / Embedding Config</div>
      <div id="llm-content"><p class="muted text-sm">Loading…</p></div>
    </div>

    <!-- Section 4: API Token Management -->
    <div class="card" id="section-api-keys">
      <div class="card-title">API Token Management</div>
      <div id="keys-content"><p class="muted text-sm">Loading…</p></div>
    </div>

  </div><!-- /#main -->

</div><!-- /#app -->
<script>
// ── Constants ────────────────────────────────────────────────────────────────
const SESSION_KEY = 'mnemo_api_key';
// Health section auto-refresh: 30-second poll rate.
// Cancelled on 401 to avoid polling with an expired key.
const HEALTH_POLL_MS = 30000;
let healthTimer = null;

// ── Utilities ────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function showEl(id) {
  const e = el(id);
  if (e) e.style.display = '';
}

function hideEl(id) {
  const e = el(id);
  if (e) e.style.display = 'none';
}

function setHtml(id, html) {
  const e = el(id);
  if (e) e.innerHTML = html;
}

function scopeBanner(msg) {
  return '<div class="alert alert-warn">' + (msg || 'Insufficient scope — this section requires additional permissions.') + '</div>';
}

function errorBanner(msg) {
  return '<div class="alert alert-error">' + escHtml(msg) + '</div>';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return iso; }
}

function badgeHtml(status) {
  if (!status) return '<span class="badge badge-unknown">unknown</span>';
  const s = String(status).toLowerCase();
  if (s === 'ok' || s === 'up' || s === 'healthy') {
    return '<span class="badge badge-ok">&#10003; ' + escHtml(status) + '</span>';
  }
  if (s === 'degraded' || s === 'warn' || s === 'warning') {
    return '<span class="badge badge-warn">&#9888; ' + escHtml(status) + '</span>';
  }
  return '<span class="badge badge-error">&#10007; ' + escHtml(status) + '</span>';
}

// ── Session management ────────────────────────────────────────────────────────
function getKey() {
  return sessionStorage.getItem(SESSION_KEY);
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  el('header').style.display = 'none';
  el('main').style.display = 'none';
  el('key-gate').style.display = 'flex';
}

// ── Authenticated fetch ───────────────────────────────────────────────────────
async function apiFetch(path, opts) {
  const key = getKey();
  const headers = Object.assign({ 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, (opts && opts.headers) || {});
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401) { clearSession(); return null; }
  return res;
}

// ── Auth gate ─────────────────────────────────────────────────────────────────
el('gate-form').addEventListener('submit', async function(e) {
  e.preventDefault();
  const btn = el('gate-submit');
  const errDiv = el('gate-error');
  errDiv.innerHTML = '';
  btn.disabled = true;
  btn.textContent = 'Validating…';
  const key = el('gate-key').value.trim();
  try {
    const res = await fetch('/me', { headers: { 'Authorization': 'Bearer ' + key } });
    if (res.status === 200) {
      const data = await res.json();
      sessionStorage.setItem(SESSION_KEY, key);
      renderDashboard(data);
    } else {
      errDiv.innerHTML = '<div class="alert alert-error" style="margin-top:0.75rem">Invalid API key (HTTP ' + res.status + '). Please try again.</div>';
    }
  } catch (err) {
    errDiv.innerHTML = '<div class="alert alert-error" style="margin-top:0.75rem">Network error: ' + escHtml(String(err)) + '</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock';
  }
});

el('logout-btn').addEventListener('click', function() { clearSession(); });

// ── Dashboard entry point ─────────────────────────────────────────────────────
function renderDashboard(meData) {
  // Show header
  el('header').style.display = 'flex';
  if (meData.workspaceId) {
    el('workspace-name').textContent = 'ws: ' + meData.workspaceId.slice(0, 8) + '…';
  }
  if (meData.plan) {
    el('plan-badge').textContent = meData.plan;
  }
  // Hide gate, show main
  hideEl('key-gate');
  el('main').style.display = 'flex';
  const scopes = Array.isArray(meData.scopes) ? meData.scopes : [];
  // Render all sections in parallel
  renderHealth(scopes);
  renderObservability(scopes);
  renderLlmConfig(scopes);
  renderApiKeys(scopes);
  // 30-second health auto-refresh
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(function() { renderHealth(scopes); }, HEALTH_POLL_MS);
}

// ── Section 1: Server Health ──────────────────────────────────────────────────
async function renderHealth(scopes) {
  setHtml('health-last-updated', '<span class="muted" style="font-size:0.75rem">refreshing…</span>');
  let html = '';
  // Always fetch /health/ready (unauthenticated endpoint)
  try {
    const readyRes = await fetch('/health/ready');
    if (readyRes.status === 401) { clearSession(); return; }
    if (readyRes.ok) {
      const data = await readyRes.json();
      const checks = data.checks || {};
      html += '<div class="health-grid">';
      // Overall status badge
      html += '<div class="health-item"><div class="health-item-label">Overall</div>' + badgeHtml(data.status) + '</div>';
      // Individual subsystems
      const systems = ['postgres', 'vector', 'cache'];
      for (const sys of systems) {
        const s = checks[sys];
        const statusStr = s ? (s.status || (s.ok ? 'ok' : 'down')) : 'unknown';
        html += '<div class="health-item"><div class="health-item-label">' + escHtml(sys) + '</div>' + badgeHtml(statusStr) + '</div>';
      }
      html += '</div>';
    } else {
      html += errorBanner('GET /health/ready returned HTTP ' + readyRes.status);
    }
  } catch (err) {
    html += errorBanner('Health check failed: ' + String(err));
  }
  // SLO table — only if memory:admin scope
  html += '<div id="health-slo">';
  if (scopes.includes('memory:admin')) {
    try {
      const deepRes = await apiFetch('/health/deep');
      if (deepRes === null) return; // 401 handled by apiFetch
      if (deepRes.status === 403) {
        html += scopeBanner('Insufficient scope — memory:admin required for deep health.');
      } else if (deepRes.ok) {
        const deep = await deepRes.json();
        const targets = (deep.slos && deep.slos.targets) ? deep.slos.targets : [];
        if (targets.length > 0) {
          html += '<h4 style="font-size:0.875rem;font-weight:700;color:#fff;margin:1rem 0 0.5rem">SLO Targets</h4>';
          html += '<table class="slo-table"><thead><tr><th>SLO</th><th>Target</th><th>Current</th><th>Status</th></tr></thead><tbody>';
          for (const t of targets) {
            const st = t.met ? 'badge-ok' : 'badge-error';
            const stLabel = t.met ? 'Met' : 'Breached';
            html += '<tr><td>' + escHtml(t.name || t.id || '—') + '</td><td>' + escHtml(String(t.target ?? '—')) + '</td><td>' + escHtml(String(t.current ?? '—')) + '</td><td><span class="badge ' + st + '">' + stLabel + '</span></td></tr>';
          }
          html += '</tbody></table>';
        } else {
          html += '<p class="muted text-sm" style="margin-top:0.75rem">No SLO targets configured.</p>';
        }
      } else {
        html += errorBanner('GET /health/deep returned HTTP ' + deepRes.status);
      }
    } catch (err) {
      html += errorBanner('Deep health failed: ' + String(err));
    }
  }
  html += '</div>';
  setHtml('health-content', html);
  el('health-last-updated').innerHTML = '<span class="muted" style="font-size:0.75rem">Updated ' + new Date().toLocaleTimeString() + '</span>';
}

// ── Section 2: Memory Observability ──────────────────────────────────────────
async function renderObservability(scopes) {
  if (!scopes.includes('memory:read')) {
    setHtml('observability-content', scopeBanner('Insufficient scope — memory:read required.'));
    return;
  }
  try {
    const res = await apiFetch('/health/cognitive');
    if (res === null) return;
    if (res.status === 403) {
      setHtml('observability-content', scopeBanner());
      return;
    }
    if (!res.ok) {
      setHtml('observability-content', errorBanner('GET /health/cognitive returned HTTP ' + res.status));
      return;
    }
    const d = await res.json();
    const economics = d.unitEconomics || {};
    const metrics = [
      { label: 'Worth Convergence', key: 'worthConvergenceRate', value: d.worthConvergenceRate, unit: '%', scale: 100 },
      { label: 'Hot Tier Hit Rate', key: 'hotTierHitRate', value: d.hotTierHitRate, unit: '%', scale: 100 },
      { label: 'Session Collapse', key: 'sessionCollapseRate', value: d.sessionCollapseRate, unit: '%', scale: 100 },
      { label: 'Avg Memory Worth', key: 'avgMemoryWorth', value: d.avgMemoryWorth, unit: '', scale: 1 },
      { label: 'Recall Count', key: 'recallCount', value: d.recallCount, unit: '', scale: 1 },
      { label: 'Cost (USD)', key: 'costUsd', value: economics.costUsd, unit: 'USD', scale: 1 },
      { label: 'ROI', key: 'ROI', value: economics.ROI, unit: 'x', scale: 1 },
    ];
    let html = '<div class="metric-grid">';
    for (const m of metrics) {
      let val = '—';
      if (m.value !== null && m.value !== undefined) {
        const n = Number(m.value);
        if (!isNaN(n)) {
          val = (m.scale === 100) ? (n * 100).toFixed(1) : (Number.isInteger(n) ? String(n) : n.toFixed(3));
        }
      }
      html += '<div class="metric-card"><div class="metric-label">' + escHtml(m.label) + '</div><div class="metric-value">' + escHtml(val) + (val !== '—' ? '<span class="metric-unit">' + escHtml(m.unit) + '</span>' : '') + '</div></div>';
    }
    html += '</div>';
    setHtml('observability-content', html);
  } catch (err) {
    setHtml('observability-content', errorBanner('Observability fetch failed: ' + String(err)));
  }
}

// ── Section 3: LLM / Embedding Config ────────────────────────────────────────
async function renderLlmConfig(scopes) {
  if (!scopes.includes('memory:admin')) {
    setHtml('llm-content', scopeBanner('Insufficient scope — memory:admin required.'));
    return;
  }
  try {
    const res = await apiFetch('/config/llm');
    if (res === null) return;
    if (res.status === 403) { setHtml('llm-content', scopeBanner()); return; }
    if (res.status === 501) {
      setHtml('llm-content', '<div class="alert alert-warn">Encryption not configured — set <code>MNEMO_MASTER_KEY</code> environment variable to enable LLM configuration management.</div>');
      return;
    }
    if (!res.ok) {
      setHtml('llm-content', errorBanner('GET /config/llm returned HTTP ' + res.status));
      return;
    }
    const cfg = await res.json();
    renderLlmDisplay(cfg);
  } catch (err) {
    setHtml('llm-content', errorBanner('LLM config fetch failed: ' + String(err)));
  }
}

function renderLlmDisplay(cfg) {
  let html = '<div id="llm-display">';
  html += '<div class="config-row"><span class="config-label">Provider</span><span class="config-value">' + escHtml(cfg.provider || '—') + '</span></div>';
  html += '<div class="config-row"><span class="config-label">LLM Model</span><span class="config-value">' + escHtml(cfg.llmModel || cfg.model || '—') + '</span></div>';
  html += '<div class="config-row"><span class="config-label">Embed Model</span><span class="config-value">' + escHtml(cfg.embedModel || '—') + '</span></div>';
  if (cfg.source) {
    html += '<div class="config-row"><span class="config-label">Source</span><span class="source-badge">' + escHtml(cfg.source) + '</span></div>';
  }
  html += '<div class="row" style="margin-top:1rem">';
  html += '<button class="btn-secondary" id="llm-edit-btn">Edit</button>';
  html += '<button class="btn-danger" id="llm-delete-btn">Reset to defaults</button>';
  html += '</div>';
  html += '</div>';
  // Edit form (hidden initially)
  html += '<div id="llm-edit-form" style="display:none;margin-top:1rem;padding-top:1rem;border-top:1px solid #2a2d3a">';
  html += '<h4 style="font-size:0.9rem;font-weight:700;color:#fff;margin:0 0 1rem">Edit LLM Config</h4>';
  html += '<label for="llm-provider">Provider</label>';
  html += '<select id="llm-provider" style="margin-bottom:1.2rem"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="local">Local (Ollama)</option></select>';
  html += '<label for="llm-model">LLM Model</label><input type="text" id="llm-model" placeholder="gpt-4o-mini" value="' + escHtml(cfg.llmModel || cfg.model || '') + '">';
  html += '<label for="llm-embed-model">Embed Model</label><input type="text" id="llm-embed-model" placeholder="text-embedding-3-small" value="' + escHtml(cfg.embedModel || '') + '">';
  html += '<label for="llm-api-key">API Key (leave blank to keep current)</label><input type="password" id="llm-api-key" autocomplete="off" placeholder="sk-…">';
  html += '<div id="llm-edit-error"></div>';
  html += '<div class="row"><button class="btn-primary" id="llm-save-btn">Save</button><button class="btn-secondary" id="llm-cancel-btn">Cancel</button></div>';
  html += '</div>';
  setHtml('llm-content', html);
  // Set current provider in select
  const provSel = el('llm-provider');
  if (provSel && cfg.provider) provSel.value = cfg.provider;

  el('llm-edit-btn').addEventListener('click', function() {
    el('llm-display').style.display = 'none';
    el('llm-edit-form').style.display = '';
  });
  el('llm-cancel-btn').addEventListener('click', function() {
    el('llm-display').style.display = '';
    el('llm-edit-form').style.display = 'none';
  });
  el('llm-delete-btn').addEventListener('click', async function() {
    if (!window.confirm('Reset LLM config to defaults? This cannot be undone.')) return;
    const btn = el('llm-delete-btn');
    btn.disabled = true;
    try {
      const res = await apiFetch('/config/llm', { method: 'DELETE' });
      if (res === null) return;
      if (res.status === 501) {
        setHtml('llm-content', '<div class="alert alert-warn">Encryption not configured — set <code>MNEMO_MASTER_KEY</code> to manage LLM config.</div>');
        return;
      }
      if (!res.ok) {
        setHtml('llm-content', errorBanner('DELETE /config/llm returned HTTP ' + res.status));
        return;
      }
      renderLlmConfig(['memory:admin']);
    } catch (err) {
      setHtml('llm-content', errorBanner('Delete failed: ' + String(err)));
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  el('llm-save-btn').addEventListener('click', async function() {
    const btn = el('llm-save-btn');
    const errDiv = el('llm-edit-error');
    errDiv.innerHTML = '';
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const body = {
      provider: el('llm-provider').value,
      llmModel: el('llm-model').value.trim() || undefined,
      embedModel: el('llm-embed-model').value.trim() || undefined,
    };
    const apiKeyVal = el('llm-api-key').value.trim();
    if (apiKeyVal) body.apiKey = apiKeyVal;
    try {
      const res = await apiFetch('/config/llm', { method: 'PUT', body: JSON.stringify(body) });
      if (res === null) return;
      if (res.status === 501) {
        setHtml('llm-content', '<div class="alert alert-warn">Encryption not configured — set <code>MNEMO_MASTER_KEY</code> to manage LLM config.</div>');
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        errDiv.innerHTML = errorBanner('Save failed (HTTP ' + res.status + '): ' + (errData.error || ''));
        return;
      }
      // Re-render with updated config
      renderLlmConfig(['memory:admin']);
    } catch (err) {
      errDiv.innerHTML = errorBanner('Save failed: ' + String(err));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  });
}

// ── Section 4: API Token Management ──────────────────────────────────────────
async function renderApiKeys(scopes) {
  if (!scopes.includes('admin:keys')) {
    setHtml('keys-content', scopeBanner('Insufficient scope — admin:keys required.'));
    return;
  }
  await loadKeysList(scopes);
}

async function loadKeysList(scopes) {
  try {
    const res = await apiFetch('/admin/keys');
    if (res === null) return;
    if (res.status === 403) { setHtml('keys-content', scopeBanner()); return; }
    if (!res.ok) {
      setHtml('keys-content', errorBanner('GET /admin/keys returned HTTP ' + res.status));
      return;
    }
    const data = await res.json();
    const items = data.items || data.keys || [];
    let html = '';
    if (items.length === 0) {
      html += '<p class="muted text-sm">No API keys found.</p>';
    } else {
      html += '<table class="keys-table"><thead><tr><th>Label</th><th>Prefix</th><th>Scopes</th><th>Created</th><th>Expires</th><th></th></tr></thead><tbody>';
      for (const k of items) {
        const scopePills = (k.scopes || []).map(function(s) { return '<span class="scope-pill">' + escHtml(s) + '</span>'; }).join('');
        html += '<tr>';
        html += '<td>' + escHtml(k.label || k.name || '—') + '</td>';
        html += '<td><code style="font-size:0.78rem;color:#a0a4be">' + escHtml(k.prefix || k.id?.slice(0,12) + '…' || '—') + '</code></td>';
        html += '<td>' + (scopePills || '<span class="muted">—</span>') + '</td>';
        html += '<td>' + fmtDate(k.createdAt || k.created_at) + '</td>';
        html += '<td>' + (k.expiresAt || k.expires_at ? fmtDate(k.expiresAt || k.expires_at) : '<span class="muted">never</span>') + '</td>';
        html += '<td><button class="btn-danger btn-revoke" data-id="' + escHtml(k.id) + '" style="padding:0.3rem 0.6rem;font-size:0.78rem">Revoke</button></td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
    }
    // Create form
    html += '<div class="create-form">';
    html += '<h4>Create new API key</h4>';
    html += '<label for="new-key-label">Label</label>';
    html += '<input type="text" id="new-key-label" placeholder="My integration key">';
    html += '<label>Scopes</label>';
    html += '<div class="scope-checks">';
    const scopeOptions = ['memory:read', 'memory:write', 'memory:admin', 'admin:keys'];
    for (const s of scopeOptions) {
      html += '<label class="scope-check-label"><input type="checkbox" name="scope" value="' + s + '"> ' + s + '</label>';
    }
    html += '</div>';
    html += '<label for="new-key-expiry">Expires in</label>';
    html += '<select id="new-key-expiry"><option value="">Never</option><option value="7d">7 days</option><option value="30d">30 days</option><option value="90d">90 days</option><option value="365d">1 year</option></select>';
    html += '<div id="keys-create-error"></div>';
    html += '<div id="keys-secret-reveal"></div>';
    html += '<div class="row" style="margin-top:0.75rem">';
    html += '<button class="btn-primary" id="create-key-btn">Create key</button>';
    html += '</div>';
    html += '</div>';
    setHtml('keys-content', html);
    // Revoke buttons
    document.querySelectorAll('.btn-revoke').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        const id = btn.getAttribute('data-id');
        if (!window.confirm('Revoke this key? This action cannot be undone.')) return;
        btn.disabled = true;
        const res = await apiFetch('/admin/keys/' + id, { method: 'DELETE' });
        if (res === null) return;
        if (res.ok) {
          await loadKeysList(scopes);
        } else {
          const errD = el('keys-create-error');
          if (errD) errD.innerHTML = errorBanner('Revoke failed (HTTP ' + res.status + ')');
          btn.disabled = false;
        }
      });
    });
    // Create key
    el('create-key-btn').addEventListener('click', async function() {
      const btn = el('create-key-btn');
      const errDiv = el('keys-create-error');
      const revealDiv = el('keys-secret-reveal');
      errDiv.innerHTML = '';
      revealDiv.innerHTML = '';
      btn.disabled = true;
      btn.textContent = 'Creating…';
      const label = el('new-key-label').value.trim();
      if (!label) {
        errDiv.innerHTML = errorBanner('Label is required.');
        btn.disabled = false; btn.textContent = 'Create key';
        return;
      }
      const selectedScopes = [];
      document.querySelectorAll('input[name="scope"]:checked').forEach(function(cb) {
        selectedScopes.push(cb.value);
      });
      const expiresIn = el('new-key-expiry').value;
      const body = { label, scopes: selectedScopes };
      if (expiresIn) body.expiresIn = expiresIn;
      try {
        const res = await apiFetch('/admin/keys', { method: 'POST', body: JSON.stringify(body) });
        if (res === null) return;
        if (res.status === 201 || res.ok) {
          const data = await res.json();
          const secret = data.key || data.apiKey || data.plaintext || '';
          if (secret) {
            revealDiv.innerHTML = '<div class="alert alert-success" style="margin-top:0.75rem">Key created. Copy the secret below — it will NOT be shown again.</div><div class="secret-box"><pre>' + escHtml(secret) + '</pre></div>';
          }
          await loadKeysList(scopes);
        } else {
          const errData = await res.json().catch(() => ({}));
          errDiv.innerHTML = errorBanner('Create failed (HTTP ' + res.status + '): ' + (errData.error || errData.message || ''));
          btn.disabled = false; btn.textContent = 'Create key';
        }
      } catch (err) {
        errDiv.innerHTML = errorBanner('Create failed: ' + String(err));
        btn.disabled = false; btn.textContent = 'Create key';
      }
    });
  } catch (err) {
    setHtml('keys-content', errorBanner('Keys fetch failed: ' + String(err)));
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  const key = getKey();
  if (key) {
    // Revalidate stored key
    fetch('/me', { headers: { 'Authorization': 'Bearer ' + key } }).then(function(res) {
      if (res.status === 200) {
        res.json().then(function(data) { renderDashboard(data); });
      } else {
        clearSession();
      }
    }).catch(function() { clearSession(); });
  }
  // else: gate form is already visible by default
});
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Mount function
// ---------------------------------------------------------------------------

/**
 * Mount the status dashboard at GET /dashboard.
 *
 * The route is unauthenticated at the HTTP level — auth is enforced entirely
 * client-side via the API key gate (REQ-P22-02). This mirrors the /setup
 * pattern in bootstrap.ts and must be registered on the root app BEFORE the
 * /v1 sub-router so the auth middleware never runs against it.
 */
export function mountDashboard(app: Hono): void {
  app.get("/dashboard", (c) => {
    return c.html(dashboardHtml());
  });
}
