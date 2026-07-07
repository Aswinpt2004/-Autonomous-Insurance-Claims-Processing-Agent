/**
 * ClaimSight AI — Frontend Application Logic
 * Vanilla JS: no build step, no dependencies, works directly from Flask static serving.
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let selectedFile = null;
let lastClaimResult = null;
const API_BASE = '';  // same origin as Flask

// ── Panel Navigation ──────────────────────────────────────────────────────────
function showPanel(name) {
  ['upload', 'history'].forEach(p => {
    document.getElementById(`panel-${p}`).style.display = (p === name) ? '' : 'none';
    document.getElementById(`nav-${p}`).classList.toggle('active', p === name);
  });
  if (name === 'history') loadHistory();
}

// ── Drag-and-Drop ─────────────────────────────────────────────────────────────
function handleDragOver(e) {
  e.preventDefault();
  document.getElementById('upload-zone').classList.add('drag-over');
}

function handleDragLeave(e) {
  document.getElementById('upload-zone').classList.remove('drag-over');
}

function handleDrop(e) {
  e.preventDefault();
  document.getElementById('upload-zone').classList.remove('drag-over');
  const files = e.dataTransfer.files;
  if (files.length > 0) setFile(files[0]);
}

function handleFileSelect(e) {
  if (e.target.files.length > 0) setFile(e.target.files[0]);
}

function setFile(file) {
  const allowed = ['.pdf', '.txt', '.text'];
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!allowed.includes(ext)) {
    showError(`Unsupported file type: ${ext}. Please upload a PDF or TXT file.`);
    return;
  }
  selectedFile = file;
  document.getElementById('file-name-display').textContent = file.name;
  document.getElementById('file-size-display').textContent = formatBytes(file.size);
  document.getElementById('file-preview').style.display = '';
  // Hide old results
  document.getElementById('pipeline-card').style.display = 'none';
  document.getElementById('results-card').style.display = 'none';
}

function clearFile() {
  selectedFile = null;
  document.getElementById('file-input').value = '';
  document.getElementById('file-preview').style.display = 'none';
  document.getElementById('pipeline-card').style.display = 'none';
  document.getElementById('results-card').style.display = 'none';
}

// ── Process Claim ─────────────────────────────────────────────────────────────
async function processClaim() {
  if (!selectedFile) {
    showError('Please select a file first.');
    return;
  }

  const btn = document.getElementById('process-btn');
  btn.disabled = true;
  btn.querySelector('.btn-text').textContent = 'Processing…';

  // Show pipeline progress
  const pipelineCard = document.getElementById('pipeline-card');
  pipelineCard.style.display = '';
  resetPipeline();

  // Results card
  const resultsCard = document.getElementById('results-card');
  resultsCard.style.display = 'none';
  resultsCard.innerHTML = '';

  // ── Stage 0 starts ───────────────────────────────────────────────────────
  await activateStage(0);
  updateStageOutput(0, `File: ${selectedFile.name}\nSize: ${formatBytes(selectedFile.size)}\nParsing document stream...`);
  await sleep(600);

  // Build form data
  const formData = new FormData();
  formData.append('fnol', selectedFile);

  let result;
  try {
    // ── Stage 1 starts while fetch runs ────────────────────────────────────
    completeStage(0);
    await activateStage(1);
    updateStageOutput(1, "Sending payload to Gemini 2.5 Flash...\nWaiting for structured JSON schema response...");

    const response = await fetch(`${API_BASE}/process-claim`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(err.error || `Server error ${response.status}`);
    }

    result = await response.json();

    // ── Stage 1 finishes with real data ────────────────────────────────────
    const keysCount = Object.keys(result.extractedFields || {}).length;
    const risksCount = (result.riskSignals || []).length;
    completeStage(1);
    updateStageOutput(1, `Gemini extraction success\nExtracted: ${keysCount} fields\nRisk signals: ${risksCount} flagged`);
    await sleep(200);

    // ── Stage 2: Validation ───────────────────────────────────────────────
    await activateStage(2);
    const missingCount = (result.missingFields || []).length;
    const lowConfCount = (result.lowConfidenceFields || []).length;
    const consistencyCount = (result.consistencyIssues || []).length;
    updateStageOutput(2, `Missing required fields: ${missingCount}\nLow-confidence fields: ${lowConfCount}\nConsistency issues: ${consistencyCount}`);
    await sleep(300);
    completeStage(2);
    await sleep(200);

    // ── Stage 3: Routing ──────────────────────────────────────────────────
    await activateStage(3);
    updateStageOutput(3, `Escalation Score: ${result.escalationScore}\nRecommended Route: ${result.recommendedRoute}`);
    await sleep(300);
    completeStage(3);
    await sleep(200);

    // ── Stage 4: Explanation ──────────────────────────────────────────────
    await activateStage(4);
    updateStageOutput(4, `Audit Trail Summary:\n${result.reasoning}`);
    await sleep(300);
    completeStage(4);
    await sleep(200);

  } catch (err) {
    // Mark last active stage as error
    showPipelineError(err.message);
    btn.disabled = false;
    btn.querySelector('.btn-text').textContent = 'Process Claim';
    return;
  }

  // Render results
  renderResults(result, resultsCard);
  resultsCard.style.display = '';
  resultsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

  btn.disabled = false;
  btn.querySelector('.btn-text').textContent = 'Process Claim';
}

// ── Pipeline Animation ─────────────────────────────────────────────────────────
function resetPipeline() {
  for (let i = 0; i <= 4; i++) {
    const el = document.getElementById(`stage-${i}`);
    el.classList.remove('active', 'done', 'error');
    el.querySelector('.stage-status-icon').innerHTML = '';
    el.querySelector('.stage-num').textContent = i;
    
    const out = document.getElementById(`stage-${i}-output`);
    if (out) {
      out.textContent = '';
      out.style.display = 'none';
    }
  }
  document.querySelectorAll('.pipeline-connector').forEach(c => c.classList.remove('done'));
}

async function activateStage(n, delayMs = 0) {
  if (delayMs) await sleep(delayMs);
  const el = document.getElementById(`stage-${n}`);
  el.classList.add('active');
  el.querySelector('.stage-status-icon').innerHTML =
    `<div class="stage-spinner"></div>`;
}

function completeStage(n) {
  const el = document.getElementById(`stage-${n}`);
  el.classList.remove('active');
  el.classList.add('done');
  el.querySelector('.stage-status-icon').innerHTML =
    `<svg class="stage-check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
  // Animate connector below
  const connectors = document.querySelectorAll('.pipeline-connector');
  if (connectors[n]) connectors[n].classList.add('done');
}

function updateStageOutput(n, text) {
  const out = document.getElementById(`stage-${n}-output`);
  if (out) {
    out.textContent = text;
    out.style.display = 'block';
  }
}

function showPipelineError(message) {
  showError(message);
}

// ── Results Rendering ─────────────────────────────────────────────────────────
function renderResults(data, container) {
  const route = data.recommendedRoute || 'Unknown';
  const score = data.escalationScore ?? '—';
  const routeClass = routeToClass(route);

  let html = '';

  // ── Route verdict banner ──────────────────────────────────────────────────
  html += `
    <div class="route-banner ${routeClass}">
      <div class="route-left">
        <div class="route-label">Recommended Route</div>
        <div class="route-value">${escHtml(route)}</div>
      </div>
      <div class="route-score-wrap">
        <div class="score-label">Escalation Score</div>
        <div class="score-value">${score}</div>
      </div>
    </div>`;

  // ── Reasoning ─────────────────────────────────────────────────────────────
  if (data.reasoning) {
    html += `
      <div class="reasoning-block">
        <h4>Routing Reasoning</h4>
        <p class="reasoning-text">${escHtml(data.reasoning)}</p>
      </div>`;
  }

  html += `<div class="results-divider"></div>`;

  // ── Extracted Fields ──────────────────────────────────────────────────────
  const fields = data.extractedFields || {};
  const missingSet = new Set(data.missingFields || []);
  const lowConfSet = new Set((data.lowConfidenceFields || []).map(f => f.field));

  const GROUPS = [
    {
      title: "Policy Information",
      fields: {
        policyNumber: 'Policy Number',
        policyholderName: 'Policyholder Name',
        policyEffectiveDates: 'Effective Dates',
      }
    },
    {
      title: "Incident Information",
      fields: {
        incidentDate: 'Date',
        incidentTime: 'Time',
        incidentLocation: 'Location',
        incidentDescription: 'Description',
      }
    },
    {
      title: "Involved Parties",
      fields: {
        claimant: 'Claimant',
        thirdParties: 'Third Parties',
        contactDetails: 'Contact Details',
      }
    },
    {
      title: "Asset Details",
      fields: {
        assetType: 'Asset Type',
        assetId: 'Asset ID',
        estimatedDamage: 'Estimated Damage',
      }
    },
    {
      title: "Other Mandatory Fields",
      fields: {
        claimType: 'Claim Type',
        attachments: 'Attachments',
        initialEstimate: 'Initial Estimate',
      }
    }
  ];

  html += `<div class="fields-section">
    <div class="section-title" style="font-size:1.15rem; border-bottom: 2px solid var(--text-primary); padding-bottom: 6px; margin-bottom: 24px;">Fields Extracted</div>`;

  for (const group of GROUPS) {
    html += `
      <div class="field-group-container">
        <h4 class="field-group-title">${group.title}</h4>
        <ul class="field-list">`;

    for (const [key, label] of Object.entries(group.fields)) {
      const fieldObj = fields[key] || {};
      const value = fieldObj.value;
      const confidence = fieldObj.confidence;
      const isMissing = missingSet.has(key);
      const isLowConf = lowConfSet.has(key);

      let itemClass = "field-list-item";
      if (isMissing) itemClass += " missing";
      else if (isLowConf) itemClass += " flagged";

      let displayValue = "";
      if (isMissing || value === null || value === undefined) {
        displayValue = '<span class="field-list-value missing">Missing</span>';
      } else {
        const valStr = typeof value === 'number' ? `₹${value.toLocaleString('en-IN')}` : escHtml(String(value));
        displayValue = `<span class="field-list-value">${valStr}</span>`;
      }

      // Add inline flags / meta
      let metaText = "";
      if (!isMissing && typeof confidence === 'number') {
        const pct = Math.round(confidence * 100);
        if (isLowConf) {
          metaText = ` <span style="font-size:0.75rem; color:var(--text-muted); font-weight:500;">(Low Confidence: ${pct}%)</span>`;
        } else if (pct < 100) {
          metaText = ` <span style="font-size:0.75rem; color:var(--text-muted);">(Conf: ${pct}%)</span>`;
        }
      }

      html += `
        <li class="${itemClass}">
          <span class="field-list-label">${label}:</span>
          ${displayValue}${metaText}
        </li>`;
    }

    html += `</ul></div>`;
  }

  html += `</div><div class="results-divider"></div>`;

  // ── Risk Signals ──────────────────────────────────────────────────────────
  const signals = data.riskSignals || [];
  html += `<div class="risk-section">
    <div class="section-title">Risk Signals <span class="section-count">${signals.length}</span></div>`;

  if (signals.length === 0) {
    html += `<div class="empty-state">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
      No risk signals detected.
    </div>`;
  } else {
    html += `<div class="risk-signals">`;
    for (const sig of signals) {
      const sev = sig.severity || 'low';
      html += `
        <div class="risk-signal-card sev-${sev}">
          <span class="sev-badge">${sev.toUpperCase()}</span>
          <div class="risk-signal-body">
            <div class="risk-signal-name">${escHtml(sig.signal)}</div>
            <div class="risk-evidence">${escHtml(sig.evidence)}</div>
            ${sig.source ? `<div class="risk-source">${escHtml(sig.source)}</div>` : ''}
          </div>
        </div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;

  // ── Consistency Issues ────────────────────────────────────────────────────
  const issues = data.consistencyIssues || [];
  if (issues.length > 0) {
    html += `<div class="results-divider"></div><div class="consistency-section">
      <div class="section-title">Consistency Issues <span class="section-count">${issues.length}</span></div>
      <div class="consistency-issues">`;
    for (const issue of issues) {
      html += `<div class="consistency-item">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;margin-top:2px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        ${escHtml(issue)}
      </div>`;
    }
    html += `</div></div>`;
  }

  // ── Metadata footer ───────────────────────────────────────────────────────
  html += `<div class="results-divider"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:16px;">
      <span style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-mono)">
        Claim ID: ${escHtml(data.claimId || '—')}
      </span>
      <span style="font-size:0.75rem;color:var(--text-muted)">
        ${data.needsVision ? '👁 Vision pathway used' : '📄 Text pathway used'} ·
        Processed ${data.processedAt ? new Date(data.processedAt).toLocaleString() : ''}
      </span>
    </div>`;

  // ── JSON Viewer & Download ───────────────────────────────────────────────
  lastClaimResult = data;
  
  html += `
    <div class="results-divider"></div>
    <div class="json-section" style="margin-top:20px;">
      <div class="section-title" style="display:flex; justify-content:space-between; align-items:center;">
        <span>JSON Payload</span>
        <button class="download-btn" onclick="downloadJSON()" style="padding:6px 12px; font-size:0.75rem; font-family:var(--font-body); font-weight:600; background:#000000; color:#ffffff; border:1px solid #000000; border-radius:var(--radius-sm); cursor:pointer; display:flex; align-items:center; gap:6px; transition:all var(--duration);">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download JSON
        </button>
      </div>
      <pre id="json-viewer" style="background:var(--bg-glass); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:14px; font-family:var(--font-mono); font-size:0.725rem; color:var(--text-primary); overflow-x:auto; max-height:240px; margin-top:10px; white-space:pre-wrap; word-break:break-all; text-align:left;"></pre>
    </div>`;

  container.innerHTML = html;

  const viewer = document.getElementById('json-viewer');
  if (viewer) {
    viewer.textContent = JSON.stringify(data, null, 2);
  }
}

// ── History ───────────────────────────────────────────────────────────────────
async function loadHistory() {
  const list = document.getElementById('history-list');
  const loading = document.getElementById('history-loading');
  loading.style.display = 'flex';
  list.innerHTML = '';

  try {
    const response = await fetch(`${API_BASE}/claims`);
    const claims = await response.json();
    loading.style.display = 'none';

    if (!Array.isArray(claims) || claims.length === 0) {
      list.innerHTML = `
        <div class="history-empty">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--text-muted)"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <p>No claims processed yet. Upload an FNOL document to get started.</p>
        </div>`;
      return;
    }

    list.innerHTML = claims.map(c => {
      const rc = routeToClass(c.recommendedRoute || '');
      const date = c.processedAt ? new Date(c.processedAt).toLocaleString() : '—';
      return `
        <div class="history-item" onclick="loadClaim('${escHtml(c.claimId)}')">
          <span class="history-route-badge ${rc}">${escHtml(c.recommendedRoute || '—')}</span>
          <div class="history-meta">
            <div class="history-filename">${escHtml(c.filename || c.claimId)}</div>
            <div class="history-date">${date}</div>
          </div>
          <div class="history-stats">
            <div class="history-stat"><strong>${c.escalationScore ?? '—'}</strong>Score</div>
            <div class="history-stat"><strong>${c.riskSignalCount ?? 0}</strong>Risks</div>
            <div class="history-stat"><strong>${c.missingFieldCount ?? 0}</strong>Missing</div>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-muted);flex-shrink:0"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        </div>`;
    }).join('');

  } catch (err) {
    loading.style.display = 'none';
    list.innerHTML = `<div class="history-empty"><p style="color:var(--red-400)">Error loading history: ${escHtml(err.message)}</p></div>`;
  }
}

async function loadClaim(claimId) {
  try {
    const response = await fetch(`${API_BASE}/claims/${claimId}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    showPanel('upload');
    const resultsCard = document.getElementById('results-card');
    document.getElementById('pipeline-card').style.display = 'none';
    renderResults(data, resultsCard);
    resultsCard.style.display = '';
    resultsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showError(`Could not load claim: ${err.message}`);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function routeToClass(route) {
  if (!route) return '';
  const r = route.toLowerCase();
  if (r.includes('fast')) return 'fasttrack';
  if (r.includes('specialist')) return 'specialist';
  if (r.includes('investigation')) return 'investigation';
  return 'manual';
}

function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function showError(message) {
  // Remove any existing error
  document.querySelectorAll('.toast-error').forEach(e => e.remove());

  const toast = document.createElement('div');
  toast.className = 'toast-error';
  toast.style.cssText = `
    position: fixed; bottom: 24px; right: 24px; z-index: 9999;
    background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.35);
    color: #f87171; padding: 14px 20px; border-radius: 12px;
    font-size: 0.875rem; font-family: var(--font-body);
    max-width: 380px; line-height: 1.5;
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    animation: slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  `;
  toast.textContent = message;

  const style = document.createElement('style');
  style.textContent = `@keyframes slideIn { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:translateY(0); } }`;
  document.head.appendChild(style);

  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

function downloadJSON() {
  if (!lastClaimResult) return;
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(lastClaimResult, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", `claim-${lastClaimResult.claimId || 'export'}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}
