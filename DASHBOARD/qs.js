/* qs.js - QS Payment Certificates module logic.
   Extracted verbatim from qs.html (June 2026). Loaded by qs.html only. */
'use strict';
// ══════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════
// SB and KEY are provided by shared.js

// ══════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════
let currentUser = null;
let perms = [];
let canView = false, canManage = false, canAdmin = false, isSuperAdmin = false;
let allScopes = [];
let allTemplates = []; // scope templates (is_template=true)
let selectedScope = null;
let selectedPC = null;
let scopeVillaTypes = [];
let scopeActivityGroups = [];
let scopeActivities = []; // flat, with group info
let scopeVillas = [];
let pcOverrides = {};  // key: villa_id+':'+activity_code
let billedRecords = {}; // key: villa_id+':'+activity_code → pc_id
let wirData = {};      // key: villa_id+':'+activity_code → {approved, response_date}
let pcSigsList = [];   // for current PC
let globalSigs = [];
let allVillasCache = [];
let subcontractorsList = [];
let allScopePCs = [];       // all PCs for currently selected scope (for running totals)
let pcNumById = {};         // pc_id → pc_number (to order PCs: earlier = prev, later = ignore)
let scopeVariations = [];   // VOs for current scope
// ── Multi-scope PC state ──
let pcSections = [];        // [{scope, ctx}] — all scopes merged into the current PC
let isMultiPC = false;      // true when the current PC includes >1 scope
let newPcScopeIds = [];     // scope ids ticked in the New PC modal
let progressSectionIdx = 0; // which scope's grid is shown on the Progress tab (multi)
let lastAdvAed = 0;         // combined advance recovery captured for saveFinancials/lock
let scopeLockedTotals = {}; // scope_id → {gross,retention,advRec,lockedCount} from qs_pc_scopes snapshots
let allPCsGlobal = [];      // all PCs across all scopes (for dashboard)
let allVOsGlobal = [];      // all VOs across all scopes (for dashboard)
let lastGrossAed = 0;       // totTodAmt captured from last renderPaymentSummary() call

// cfg modal state
let cfgVillaTypes = [];
let cfgActGroups = [];
let cfgActivities = []; // working copy for config modal (has _gi: index into cfgActGroups)
let cfgScopeVillas = [];
let cfgTab = 'types';

// progress sheet cluster filter
let psClusterFilter = 'all'; // 'all' or cluster_id as string

// override state
let ovPending = null; // {villa_id, activity_code, villa_no, act_name}

// new/edit scope modal mode
let editScopeMode = false;

// historical PC state
let histPCMeta = null;   // {num, date, label, notes}
let histPCSelections = {}; // key: villa_id+':'+activity_code → true/false

// villa search state
let vsFoundVilla = null;

// ══════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════
function getH(extra={}) {
  const h = { 'apikey': KEY, 'Content-Type':'application/json' };
  if (window.__MEP_TOKEN__) h['Authorization'] = 'Bearer ' + window.__MEP_TOKEN__;
  return Object.assign(h, extra);
}
async function fa(path) {
  try {
    const r = await fetch(`${SB}/rest/v1/${path}`, { headers: getH() });
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}
async function fp(path, body) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method:'POST', headers: getH({'Prefer':'return=representation'}), body: JSON.stringify(body)
  });
  const d = await r.json();
  if (!r.ok) throw new Error((d && d.message) ? `[${r.status}] ${d.message}` : `HTTP ${r.status}`);
  // Supabase always returns an array; unwrap for single-object inserts
  if (Array.isArray(d)) return !Array.isArray(body) ? (d[0] || null) : d;
  return d;
}
async function fpatch(path, body) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method:'PATCH', headers: getH({'Prefer':'return=representation'}), body: JSON.stringify(body)
  });
  const d = await r.json();
  if (!r.ok) throw new Error((d && d.message) ? `[${r.status}] ${d.message}` : `HTTP ${r.status}`);
  return d;
}
async function fdel(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { method:'DELETE', headers: getH() });
  if (!r.ok) {
    let errMsg = `HTTP ${r.status}`;
    try { const ed = await r.json(); if (ed && ed.message) errMsg = `[${r.status}] ${ed.message}`; } catch(_){}
    throw new Error(`DELETE ${path} failed: ${errMsg}`);
  }
}

function fmtAED(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (n === 0) return '-';
  return Number(n).toLocaleString('en-AE', { minimumFractionDigits:2, maximumFractionDigits:2 });
}
function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return (n * 100).toFixed(2) + '%';
}
function fmtQty(n) {
  if (!n) return '-';
  return Number(n).toFixed(2);
}
function escH(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
// Returns the display name for a scope (full company name if set, else the subcontractor lookup name)
function scopeDisplayName(scope) { return (scope && scope.display_name) ? scope.display_name : (scope && scope.subcontractor_name) || ''; }

// ══════════════════════════════════════════════
// PERMISSION CHECK
// ══════════════════════════════════════════════
function applyTheme(t) { document.documentElement.setAttribute('data-theme', t||'dark'); }

async function init() {
  perms = (window.__MEP_USER__?.permissions) || [];
  isSuperAdmin = perms.includes('manage_users') && perms.includes('manage_system');
  canView   = isSuperAdmin || perms.includes('view_qs');
  canManage = isSuperAdmin || perms.includes('manage_qs');
  canAdmin  = isSuperAdmin || perms.includes('admin_qs');
  currentUser = window.__MEP_USER__;

  if (!canView) {
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:var(--bg,#0d0d12);color:var(--tx,#ccc);flex-direction:column;gap:16px;font-family:inherit"><div style="font-size:48px">🔒</div><div style="font-size:22px;font-weight:700;color:#ff6b6b">Access Denied</div><div style="color:#888;font-size:14px">QS data is confidential. Contact your administrator.</div></div>';
    return;
  }

  if (canManage || canAdmin) {
    document.getElementById('btn-new-scope').style.display = '';
  }

  await loadScopes();
}

// ══════════════════════════════════════════════
// SCOPES
// ══════════════════════════════════════════════
async function loadScopes() {
  // Use explicit is_template filters in the query so the DB does the separation —
  // avoids any risk of templates leaking into the scope list if is_template is
  // ever returned as null/undefined by PostgREST (e.g. column visibility, old cache).
  const SCOPE_COLS = 'id,subcontractor_name,display_name,scope_title,sca_ref,package,project,contract_value_aed,retention_pct,advance_amount_aed,advance_recovery_pct,is_template';
  const [realScopes, templates, pcs, vos, pcScopes] = await Promise.all([
    fa(`qs_scopes?select=${SCOPE_COLS}&is_template=eq.false&order=subcontractor_name.asc`),
    fa('qs_scopes?select=id,subcontractor_name,scope_title,is_template&is_template=eq.true&order=subcontractor_name.asc'),
    fa('qs_payment_certificates?select=id,scope_id,pc_number,period_label,status,gross_aed,retention_aed,advance_recovery_aed&order=pc_number.desc'),
    fa('qs_variation_orders?select=id,scope_id,value_aed,status&order=created_at.asc'),
    fa('qs_pc_scopes?select=pc_id,scope_id,gross_aed,retention_aed,advance_recovery_aed')
  ]);
  allPCsGlobal = pcs;
  allVOsGlobal = vos;
  const latestPcByScopeId = {};
  pcs.forEach(p => { if (!latestPcByScopeId[p.scope_id]) latestPcByScopeId[p.scope_id] = p; });
  // Templates and real scopes come from separate DB-filtered queries — no JS split needed
  allTemplates = templates.sort((a,b)=>a.subcontractor_name.localeCompare(b.subcontractor_name));
  allScopes = realScopes.map(s => ({ ...s, latestPc: latestPcByScopeId[s.id] || null }));
  // Per-scope locked totals from section snapshots (correctly splits combined PCs by scope)
  const pcStatusById = {}; pcs.forEach(p => pcStatusById[p.id] = p.status);
  scopeLockedTotals = {};
  pcScopes.forEach(r => {
    if (pcStatusById[r.pc_id] !== 'locked') return;
    const m = scopeLockedTotals[r.scope_id] || (scopeLockedTotals[r.scope_id] = { gross:0, retention:0, advRec:0, pcIds:new Set() });
    m.gross     += parseFloat(r.gross_aed)||0;
    m.retention += parseFloat(r.retention_aed)||0;
    m.advRec    += parseFloat(r.advance_recovery_aed)||0;
    m.pcIds.add(r.pc_id);
  });
  renderScopeList();
  renderDashboard();
}

let expandedSubs = {};   // subcontractor name → expanded?
let subGroupOrder = [];  // index → subcontractor name (for click handlers)

function renderScopeList() {
  const q = (document.getElementById('scope-search').value || '').toLowerCase();
  const list = document.getElementById('scope-list');
  const filtered = allScopes.filter(s =>
    s.subcontractor_name.toLowerCase().includes(q) ||
    (s.scope_title||'').toLowerCase().includes(q)
  );
  if (!filtered.length) { list.innerHTML = '<div class="lp-empty">No scopes found</div>'; renderTemplateList(); return; }

  // Group scopes by subcontractor
  const groups = {};
  filtered.forEach(s => { (groups[s.subcontractor_name] = groups[s.subcontractor_name] || []).push(s); });
  subGroupOrder = Object.keys(groups).sort((a,b)=>a.localeCompare(b));
  const searching = q.length > 0;

  list.innerHTML = subGroupOrder.map((name, gi) => {
    const scopes = groups[name];
    const hasSelected = scopes.some(s => selectedScope?.id === s.id);
    const open = searching || hasSelected || !!expandedSubs[name];
    const cards = !open ? '' : scopes.map(s => {
      const lp = s.latestPc;
      const badgeClass = lp ? lp.status : 'none';
      const badgeText = lp ? `PC#${lp.pc_number} · ${lp.period_label}` : 'No PCs yet';
      return `<div class="scope-card sub-scope${selectedScope?.id===s.id?' active':''}" onclick="event.stopPropagation();selectScope(${s.id})">
        <div class="sc-sub" style="color:var(--tx);font-weight:600">${escH(s.scope_title||'(untitled scope)')}</div>
        <div class="sc-meta"><span class="sc-badge ${badgeClass}">${escH(badgeText)}</span></div>
      </div>`;
    }).join('');
    return `<div class="sub-group">
      <div class="sub-head${hasSelected?' active':''}" onclick="toggleSub(${gi})">
        <span class="sub-caret">${open?'▾':'▸'}</span>
        <span class="sub-name">${escH(name)}</span>
        <span class="sub-count">${scopes.length}</span>
        <button class="sub-add" title="Add a scope for this subcontractor" onclick="addScopeForSub(event,${gi})">+</button>
      </div>
      <div class="sub-scopes">${cards}</div>
    </div>`;
  }).join('');
  renderTemplateList();
}

function toggleSub(gi) {
  const name = subGroupOrder[gi]; if (name == null) return;
  expandedSubs[name] = !expandedSubs[name];
  renderScopeList();
}
function addScopeForSub(ev, gi) {
  ev.stopPropagation();
  const name = subGroupOrder[gi]; if (name == null) return;
  openNewScope(name);
}

function filterScopes() { renderScopeList(); }

// ══════════════════════════════════════════════
// SCOPE TEMPLATES
// ══════════════════════════════════════════════
let tplSectionOpen = false;

function toggleTplSection() {
  tplSectionOpen = !tplSectionOpen;
  document.getElementById('tpl-list-wrap').style.display = tplSectionOpen ? '' : 'none';
  document.getElementById('tpl-caret').classList.toggle('open', tplSectionOpen);
}

function renderTemplateList() {
  const sec = document.getElementById('tpl-section');
  if (!canAdmin) { sec.style.display = 'none'; return; }
  sec.style.display = allTemplates.length || canAdmin ? '' : 'none';
  const list = document.getElementById('tpl-list');
  if (!allTemplates.length) {
    list.innerHTML = '<div style="font-size:11px;color:var(--tx3);padding:4px 8px 6px">No templates yet.</div>';
  } else {
    list.innerHTML = allTemplates.map(t => `
      <div class="tpl-item">
        <span class="tpl-name" title="${escH(t.scope_title||t.subcontractor_name)}">
          ${escH(t.subcontractor_name)}
        </span>
        <span class="tpl-count" id="tpl-count-${t.id}">…</span>
        <button class="tpl-del" title="Edit activities" onclick="openConfigTemplate(allTemplates.find(x=>x.id===${t.id}))" style="color:var(--tx3)">✏️</button>
        <button class="tpl-del" title="Delete template" onclick="deleteTemplate(${t.id})">🗑</button>
      </div>`).join('');
    // Async: load activity counts for display
    allTemplates.forEach(async t => {
      const grps = await fa(`qs_scope_activity_groups?scope_id=eq.${t.id}&select=id`);
      const el = document.getElementById('tpl-count-' + t.id);
      if (el) el.textContent = grps.length + (grps.length === 1 ? ' group' : ' groups');
    });
  }
  // Populate the template dropdown in the Activities tab
  _refreshTplSelect();
}

function _refreshTplSelect() {
  const sel = document.getElementById('acts-tpl-select');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— choose a template —</option>' +
    allTemplates.map(t => `<option value="${t.id}">${escH(t.subcontractor_name)}</option>`).join('');
  if (cur) sel.value = cur;
}

async function applyTemplate() {
  const sel = document.getElementById('acts-tpl-select');
  const tplId = parseInt(sel.value);
  if (!tplId) { showMsg(document.getElementById('cfg-acts-msg'), 'err', 'Pick a template first.'); return; }
  const tpl = allTemplates.find(t => t.id === tplId);
  if (!tpl) return;
  if (cfgActGroups.length > 0) {
    if (!confirm(`Replace current activities with template "${tpl.subcontractor_name}"?\nThis won't save until you click "Save Changes".`)) return;
  }
  // Load template's groups + activities
  const grps = await fa(`qs_scope_activity_groups?scope_id=eq.${tplId}&order=sort_order.asc`);
  const grpIds = grps.map(g => g.id);
  const acts = grpIds.length
    ? await fa(`qs_scope_activities?group_id=in.(${grpIds.join(',')})&order=sort_order.asc`)
    : [];
  // Strip DB ids — these will become new records for this scope
  cfgActGroups = grps.map(g => ({ ...g, id: undefined, scope_id: selectedScope.id }));
  cfgActivities = acts.map(a => {
    const gi = grps.findIndex(g => g.id === a.group_id);
    return { ...a, id: undefined, group_id: undefined, _gi: gi };
  });
  renderCfgActs();
  showMsg(document.getElementById('cfg-acts-msg'), 'ok', `Loaded template "${tpl.subcontractor_name}". Click Save Changes to apply.`);
}

async function saveAsTemplate() {
  if (!cfgActGroups.length) {
    showMsg(document.getElementById('cfg-acts-msg'), 'err', 'Add activity groups first before saving as a template.');
    return;
  }
  const name = prompt('Template name:', selectedScope.subcontractor_name + ' (template)');
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  const btn = document.querySelector('[onclick="saveAsTemplate()"]');
  if (btn) { btn.disabled = true; btn.textContent = '…Saving'; }
  try {
    // Create template scope record
    const tplScope = await fp('qs_scopes', {
      subcontractor_name: trimmed,
      scope_title: trimmed,
      is_template: true,
      project: selectedScope.project || ''
    });
    // Clone groups + activities
    for (let gi = 0; gi < cfgActGroups.length; gi++) {
      const grp = cfgActGroups[gi];
      const grpRes = await fp('qs_scope_activity_groups', {
        scope_id: tplScope.id, group_name: grp.group_name, group_weight: grp.group_weight, sort_order: gi
      });
      const grpActs = cfgActivities.filter(a => a._gi === gi);
      if (grpRes?.id && grpActs.length) {
        await fp('qs_scope_activities', grpActs.map((a, ai) => ({
          group_id: grpRes.id,
          activity_code: a.activity_code, activity_name: a.activity_name,
          activity_weight: a.activity_weight, base_code: a.base_code || a.activity_code,
          part_label: (a.part_label && String(a.part_label).trim()) ? String(a.part_label).trim().toUpperCase() : null,
          sort_order: ai
        })));
      }
    }
    allTemplates.push({ ...tplScope, subcontractor_name: trimmed });
    allTemplates.sort((a, b) => a.subcontractor_name.localeCompare(b.subcontractor_name));
    renderTemplateList();
    showMsg(document.getElementById('cfg-acts-msg'), 'ok', `Template "${trimmed}" saved! You can now load it into any scope.`);
  } catch(e) {
    showMsg(document.getElementById('cfg-acts-msg'), 'err', 'Failed to save template: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save as template'; }
  }
}

async function deleteTemplate(tplId) {
  const tpl = allTemplates.find(t => t.id === tplId);
  if (!tpl) return;
  if (!confirm(`Delete template "${tpl.subcontractor_name}"?\nThis cannot be undone.`)) return;
  try {
    await fdel(`qs_scope_activity_groups?scope_id=eq.${tplId}`);
    await fdel(`qs_scopes?id=eq.${tplId}`);
    allTemplates = allTemplates.filter(t => t.id !== tplId);
    renderTemplateList();
  } catch(e) { alert('Delete failed: ' + e.message); }
}

async function openNewTemplate() {
  const name = prompt('Template name:');
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  try {
    const tplScope = await fp('qs_scopes', {
      subcontractor_name: trimmed, scope_title: trimmed, is_template: true, project: ''
    });
    allTemplates.push({ ...tplScope, subcontractor_name: trimmed });
    allTemplates.sort((a, b) => a.subcontractor_name.localeCompare(b.subcontractor_name));
    renderTemplateList();
    openConfigTemplate(tplScope);
  } catch(e) { alert('Failed: ' + e.message); }
}

async function openConfigTemplate(tplScope) {
  // Open the Configure modal but scoped to a template — only Activities tab shown
  const prevScope = selectedScope;
  selectedScope = tplScope;
  // Load template's groups/activities
  const grps = await fa(`qs_scope_activity_groups?scope_id=eq.${tplScope.id}&order=sort_order.asc`);
  const grpIds = grps.map(g => g.id);
  const acts = grpIds.length ? await fa(`qs_scope_activities?group_id=in.(${grpIds.join(',')})&order=sort_order.asc`) : [];
  cfgActGroups = JSON.parse(JSON.stringify(grps));
  cfgActivities = acts.map(a => ({ ...a, _gi: cfgActGroups.findIndex(g => g.id === a.group_id) }));
  // Show only the Activities tab — hide others
  ['types','villas','sigs','contract'].forEach(k => {
    const el = document.getElementById('cfg-tab-' + k);
    if (el) el.style.display = 'none';
  });
  document.getElementById('cfg-scope-name').textContent = '⭐ ' + tplScope.subcontractor_name + ' (template)';
  // Override save to write back to template scope
  _tplEditMode = true;
  _tplEditId = tplScope.id;
  _prevScopeBeforeTpl = prevScope;
  switchCfgTab('acts');
  _refreshTplSelect();
  renderCfgActs();
  document.getElementById('modal-config-scope').style.display = 'flex';
}

// ── Vars for template-edit mode ──
let _tplEditMode = false;
let _tplEditId = null;
let _prevScopeBeforeTpl = null;

// ══════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════
function renderDashboard() {
  const dash = document.getElementById('dash-view');
  if (!dash) return;

  if (!allScopes.length) {
    dash.innerHTML = `
      <div class="dash-hdr">
        <div><div class="dash-hdr-title">QS Overview</div><div class="dash-hdr-sub">All subcontractor scopes</div></div>
      </div>
      <div class="dash-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".3"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
        <span>No scopes yet. Add a scope to get started.</span>
      </div>`;
    return;
  }

  // ── Aggregate KPIs ──
  let totalContract = 0, totalCertified = 0, totalRetention = 0, totalAdvBalance = 0;
  let totalLockedCount = 0;

  allScopes.forEach(s => {
    const contract = parseFloat(s.contract_value_aed) || 0;
    const approvedVOs = allVOsGlobal
      .filter(v => v.scope_id === s.id && v.status === 'approved')
      .reduce((a, v) => a + (parseFloat(v.value_aed) || 0), 0);
    totalContract += contract + approvedVOs;

    const lk = scopeLockedTotals[s.id];   // this scope's share of every locked PC (incl. combined)
    totalCertified += lk ? lk.gross : 0;
    totalRetention += lk ? lk.retention : 0;

    const advPaid = parseFloat(s.advance_amount_aed) || 0;
    const advRec  = lk ? lk.advRec : 0;
    totalAdvBalance += Math.max(0, advPaid - advRec);
  });
  // Distinct locked PCs across the project (a combined PC counts once)
  totalLockedCount = allPCsGlobal.filter(p => p.status === 'locked').length;

  const overallPct = totalContract > 0 ? (totalCertified / totalContract * 100).toFixed(1) : null;

  // ── Per-scope cards ──
  const cards = allScopes.map(s => {
    const contract = parseFloat(s.contract_value_aed) || 0;
    const scopeVOs = allVOsGlobal.filter(v => v.scope_id === s.id);
    const approvedVOs = scopeVOs.filter(v => v.status === 'approved').reduce((a,v) => a + (parseFloat(v.value_aed)||0), 0);
    const pendingVOCount = scopeVOs.filter(v => v.status === 'pending').length;
    const adjContract = contract + approvedVOs;

    const scopePCs = allPCsGlobal.filter(p => p.scope_id === s.id);
    const lockedPCs    = scopePCs.filter(p => p.status === 'locked');
    const submittedPCs = scopePCs.filter(p => p.status === 'submitted');
    const draftPCs     = scopePCs.filter(p => p.status === 'draft');

    const lk = scopeLockedTotals[s.id];                 // this scope's share of every locked PC
    const lockedCount = lk ? lk.pcIds.size : 0;          // counts combined PCs this scope is part of
    const certified = lk ? lk.gross : 0;
    const certPct   = adjContract > 0 ? certified / adjContract : 0;
    const barPct    = Math.min(100, certPct * 100).toFixed(1);
    const barClass  = certPct >= 0.9 ? 'green' : certPct >= 0.5 ? '' : (certPct > 0 ? 'amber' : '');

    const retention = lk ? lk.retention : 0;
    const advPaid   = parseFloat(s.advance_amount_aed) || 0;
    const advRec    = lk ? lk.advRec : 0;
    const advBal    = Math.max(0, advPaid - advRec);

    const lp = s.latestPc;
    const statusBadge = lp
      ? `<span class="sc-badge ${lp.status}">PC#${lp.pc_number}</span>`
      : `<span class="sc-badge none">No PCs</span>`;

    const certLine = adjContract > 0
      ? `<div class="dash-stat-row">
           <span class="dash-stat-label">Certified to Date</span>
           <span class="dash-stat-val" style="color:var(--green)">${fmtAED(certified)}<span style="color:var(--tx3);font-weight:500;font-size:10px;margin-left:4px">${(certPct*100).toFixed(1)}%</span></span>
         </div>
         <div class="dash-progress-bar"><div class="dash-progress-fill ${barClass}" style="width:${barPct}%"></div></div>`
      : `<div style="font-size:11px;color:var(--tx3);padding:2px 0">Contract value not set</div>`;

    const retLine = retention > 0
      ? `<div class="dash-stat-row"><span class="dash-stat-label">Retention Held</span><span class="dash-stat-val" style="color:var(--amber)">${fmtAED(retention)}</span></div>`
      : '';
    const advLine = advBal > 0
      ? `<div class="dash-stat-row"><span class="dash-stat-label">Advance Balance</span><span class="dash-stat-val" style="color:var(--blue)">${fmtAED(advBal)}</span></div>`
      : '';

    const chips = [
      lockedCount         ? `<span class="sc-badge locked">${lockedCount} locked</span>` : '',
      submittedPCs.length ? `<span class="sc-badge submitted">${submittedPCs.length} submitted</span>` : '',
      draftPCs.length     ? `<span class="sc-badge draft">${draftPCs.length} draft</span>` : '',
      pendingVOCount      ? `<span class="vo-badge pending">${pendingVOCount} VO pending</span>` : ''
    ].filter(Boolean).join('');

    return `<div class="dash-card" onclick="selectScope(${s.id})">
      <div class="dash-card-hdr">
        <div style="min-width:0">
          <div class="dash-card-name">${escH(s.subcontractor_name)}</div>
          <div class="dash-card-scope">${escH(s.scope_title || '')}</div>
        </div>
        <div style="flex-shrink:0">${statusBadge}</div>
      </div>
      <div class="dash-card-stats">
        <div class="dash-stat-row">
          <span class="dash-stat-label">Contract Value</span>
          <span class="dash-stat-val">${adjContract > 0 ? fmtAED(adjContract) : '<span style="color:var(--tx3)">—</span>'}</span>
        </div>
        ${certLine}
        ${retLine}
        ${advLine}
        ${chips ? `<div class="dash-pc-chips">${chips}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  dash.innerHTML = `
    <div class="dash-hdr">
      <div>
        <div class="dash-hdr-title">QS Overview</div>
        <div class="dash-hdr-sub">${allScopes.length} scope${allScopes.length !== 1 ? 's' : ''}${overallPct !== null ? ' · ' + overallPct + '% certified overall' : ''}</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="loadScopes()">↻ Refresh</button>
    </div>
    <div class="dash-kpi-bar">
      <div class="dash-kpi">
        <div class="dash-kpi-label">Total Contract Value</div>
        <div class="dash-kpi-value accent">${fmtAED(totalContract)}</div>
      </div>
      <div class="dash-kpi">
        <div class="dash-kpi-label">Certified to Date</div>
        <div class="dash-kpi-value green">${fmtAED(totalCertified)}</div>
      </div>
      <div class="dash-kpi">
        <div class="dash-kpi-label">Retention Held</div>
        <div class="dash-kpi-value amber">${fmtAED(totalRetention)}</div>
      </div>
      <div class="dash-kpi">
        <div class="dash-kpi-label">Advance Balance</div>
        <div class="dash-kpi-value blue">${fmtAED(totalAdvBalance)}</div>
      </div>
      <div class="dash-kpi">
        <div class="dash-kpi-label">Locked PCs</div>
        <div class="dash-kpi-value">${totalLockedCount}</div>
      </div>
    </div>
    <div class="dash-section-title">Scopes</div>
    <div class="dash-grid">${cards}</div>`;
}

function backToDashboard() {
  selectedScope = null;
  selectedPC = null;
  renderScopeList();
  document.getElementById('no-scope-msg').style.display = 'flex';
  document.getElementById('scope-panel').style.display = 'none';
  document.getElementById('btn-dash-overview').style.display = 'none';
}

async function selectScope(id) {
  selectedScope = allScopes.find(s => s.id === id);
  selectedPC = null;
  renderScopeList();
  document.getElementById('no-scope-msg').style.display = 'none';
  document.getElementById('scope-panel').style.display = 'flex';
  document.getElementById('btn-dash-overview').style.display = '';
  document.getElementById('sh-title').textContent = selectedScope.subcontractor_name;
  document.getElementById('sh-sub').textContent = selectedScope.scope_title || '';
  document.getElementById('sh-meta').textContent = [selectedScope.sca_ref, selectedScope.package].filter(Boolean).join(' · ');
  document.getElementById('btn-delete-scope').style.display = isSuperAdmin ? '' : 'none';
  document.getElementById('btn-edit-scope').style.display = canAdmin ? '' : 'none';
  document.getElementById('btn-add-scope').style.display = (canManage||canAdmin) ? '' : 'none';
  document.getElementById('btn-variations').style.display = (canManage||canAdmin) ? '' : 'none';
  document.getElementById('btn-config-scope').style.display = canAdmin ? '' : 'none';
  document.getElementById('btn-new-pc').style.display = (canManage||canAdmin) ? '' : 'none';
  document.getElementById('pc-area').style.display = 'none';
  await loadScopeConfig();
  await loadPCs();
}

async function loadScopeConfig() {
  scopeVillaTypes = await fa(`qs_scope_villa_types?scope_id=eq.${selectedScope.id}&order=sort_order.asc`);
  scopeActivityGroups = await fa(`qs_scope_activity_groups?scope_id=eq.${selectedScope.id}&order=sort_order.asc`);
  const groupIds = scopeActivityGroups.map(g => g.id);
  scopeActivities = groupIds.length
    ? await fa(`qs_scope_activities?group_id=in.(${groupIds.join(',')})&order=sort_order.asc`)
    : [];
  // Auto-detect villas from WIR data — no manual assignment needed
  scopeVillas = await autoDetectScopeVillas();
  updateClusterFilter();
}

// ── Auto-detect villas from WIR data for this subcontractor ──
async function _detectWirVillas() {
  const subName = selectedScope.subcontractor_name;
  if (!subName) return [];
  // Collect all aliases (the raw_subcontractor strings) that map to this canonical name.
  // Also fetch canonical_name itself — it may be stored in a different case than subName,
  // and the raw WIR data uses the exact canonical_name casing (e.g. "HO RS TECHNICAL" ≠ "HO RS Technical").
  const aliases = await fa(`subcontractor_aliases?canonical_name=ilike.${encodeURIComponent(subName)}&select=alias,canonical_name`);
  let nameFilter;
  if (aliases.length) {
    const names = [...new Set([subName, ...aliases.map(a => a.alias), ...aliases.map(a => a.canonical_name).filter(Boolean)])];
    nameFilter = `raw_subcontractor=in.(${names.map(n => `"${n}"`).join(',')})`;
  } else {
    nameFilter = `raw_subcontractor=ilike.${encodeURIComponent(subName)}`;
  }
  // Activities MUST be configured first — without them we can't scope the detection
  // (omitting the filter would return every villa the sub has touched, which is wrong)
  // For split activities use base_code (the original WIR code, e.g. "3190") not the synthetic
  // split code ("3190-GF") — the raw WIR data never contains the split suffix.
  const actCodes = [...new Set(scopeActivities.map(a => (a.base_code || a.activity_code)).filter(Boolean))];
  if (!actCodes.length) return [];

  const actFilter = `&raw_activity_code=in.(${actCodes.map(c => `"${c}"`).join(',')})`;
  // Get distinct villa_ids that have WIR entries for this sub + these specific activities
  const wirRows = await fa(`v_latest_wir_status?${nameFilter}${actFilter}&select=villa_id`);
  const villaIds = [...new Set(wirRows.map(r => r.villa_id).filter(Boolean))];
  if (!villaIds.length) return [];
  // Fetch villa metadata (include cluster_id for cluster filtering)
  const villas = await fa(`villas?id=in.(${villaIds.join(',')})&select=id,villa_no,villa_type,cluster_id&is_active=eq.true&order=cluster_id.asc,villa_no.asc`);
  return villas.map(v => ({
    villa_id: v.id,
    villa_no: v.villa_no,
    villa_type_label: matchVillaType(v.villa_type),
    raw_villa_type: v.villa_type,
    cluster_id: v.cluster_id,
  }));
}

async function _villasByIds(ids) {
  if (!ids.length) return [];
  const v = await fa(`villas?id=in.(${ids.join(',')})&select=id,villa_no,villa_type,cluster_id&is_active=eq.true`);
  return v.map(x => ({ villa_id:x.id, villa_no:x.villa_no, villa_type_label: matchVillaType(x.villa_type), raw_villa_type:x.villa_type, cluster_id:x.cluster_id }))
          .sort((a,b) => ((a.cluster_id||0)-(b.cluster_id||0)) || ((a.villa_no||0)-(b.villa_no||0)));
}
// Villa universe for a scope:
//  • Once the scope has billing, its villas are exactly the ones it has billed (Excel/BOQ-driven).
//  • Before any billing: single-scope subs seed from WIR detection; multi-scope subs start empty
//    (WIR can't tell same-sub scopes apart — the Excel import defines them).
async function autoDetectScopeVillas() {
  let billedIds = [];
  try {
    const billed = await fa(`qs_billed_records?scope_id=eq.${selectedScope.id}&select=villa_id`);
    billedIds = [...new Set(billed.map(b => b.villa_id).filter(Boolean))];
  } catch(e) {}

  const siblings = allScopes.filter(s =>
    (selectedScope.subcontractor_id && s.subcontractor_id === selectedScope.subcontractor_id) ||
    (!selectedScope.subcontractor_id && s.subcontractor_name === selectedScope.subcontractor_name)
  ).length;

  // Multi-scope sub: WIR can't distinguish scopes → billing-only once billed, else empty
  if (siblings > 1) return billedIds.length ? await _villasByIds(billedIds) : [];

  // Single-scope sub: union of billed villas + WIR-detected so new approvals always appear
  const wirVillas = await _detectWirVillas();
  if (!billedIds.length) return wirVillas;
  const allIds = [...new Set([...billedIds, ...wirVillas.map(v => v.villa_id)])];
  return await _villasByIds(allIds);
}

// Map a raw villa_type string from the villas table to a configured qs_scope_villa_types label
// Uses bedroom count extraction so "4 BEDROOM VILLA" matches "4 Bedroom Villa"
function matchVillaType(rawType) {
  const beds = extractBedrooms(rawType);
  if (beds && scopeVillaTypes.length) {
    const match = scopeVillaTypes.find(t => extractBedrooms(t.villa_type_label) === beds);
    if (match) return match.villa_type_label;
  }
  // Fall back to first type or raw value
  return scopeVillaTypes[0]?.villa_type_label || rawType || 'Unknown';
}

function extractBedrooms(typeStr) {
  const m = (typeStr || '').match(/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

// ══════════════════════════════════════════════
// PAYMENT CERTIFICATES
// ══════════════════════════════════════════════
async function loadPCs() {
  const pcs = await fa(`qs_payment_certificates?scope_id=eq.${selectedScope.id}&order=pc_number.asc`);
  allScopePCs = pcs; // cache for running totals in financial section
  // Also load variations so payment summary has them ready
  scopeVariations = await fa(`qs_variation_orders?scope_id=eq.${selectedScope.id}&order=created_at.asc`);
  const bar = document.getElementById('pc-bar');
  const addBtn = (canManage||canAdmin) ? `<button class="pc-new-btn" onclick="openNewPC()">+ New PC</button>` : '';
  if (!pcs.length) {
    bar.innerHTML = `<span class="pc-none">No payment certificates yet</span>${addBtn}`;
    document.getElementById('pc-area').style.display = 'none';
    return;
  }
  bar.innerHTML = pcs.map(p =>
    `<div class="pc-chip${selectedPC?.id===p.id?' active':''}" onclick="selectPC(${p.id})">
      <span class="pc-status ${p.status}"></span>PC #${p.pc_number} · ${escH(p.period_label)}
    </div>`
  ).join('') + addBtn;
  // Auto-select latest
  if (!selectedPC) { selectPC(pcs[pcs.length - 1].id, pcs); }
}

async function selectPC(id, pcsCache) {
  const pcs = pcsCache || await fa(`qs_payment_certificates?scope_id=eq.${selectedScope.id}&order=pc_number.asc`);
  selectedPC = pcs.find(p => p.id === id);
  // Re-render bar
  const bar = document.getElementById('pc-bar');
  const addBtn = (canManage||canAdmin) ? `<button class="pc-new-btn" onclick="openNewPC()">+ New PC</button>` : '';
  bar.innerHTML = pcs.map(p =>
    `<div class="pc-chip${selectedPC?.id===p.id?' active':''}" onclick="selectPC(${p.id})">
      <span class="pc-status ${p.status}"></span>PC #${p.pc_number} · ${escH(p.period_label)}
    </div>`
  ).join('') + addBtn;
  document.getElementById('pc-area').style.display = 'flex';
  await loadPCData();
}

async function loadPCData() {
  showTab('progress');
  document.getElementById('ps-wrap').innerHTML = '<div class="loading-row"><span class="spin"></span></div>';
  document.getElementById('psum-inner').innerHTML = '<div class="loading-row"><span class="spin"></span></div>';

  // Status strip
  const isLocked = selectedPC.status === 'locked';
  const strip = document.getElementById('ps-status-strip');
  if (isLocked) {
    strip.innerHTML = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <div class="ps-locked-banner">🔒 Locked · ${escH(selectedPC.period_label)} · This PC is read-only</div>
      ${canAdmin ? `<button class="btn btn-ghost btn-sm" onclick="openReopen()" title="Reset to Draft and remove billed records">🔓 Reopen</button>` : ''}
      ${canAdmin ? '<button class="btn btn-danger btn-sm" onclick="openDeletePC()">🗑 Delete PC</button>' : ''}
    </div>`;
  } else {
    const canLock = canManage || canAdmin;
    const canSubmit = canManage || canAdmin;
    strip.innerHTML = `
      <span style="font-size:11px;font-weight:700;color:var(--tx3);text-transform:uppercase;letter-spacing:.06em">${selectedPC.status.toUpperCase()}</span>
      ${canSubmit && selectedPC.status==='draft' ? '<button class="btn btn-ghost btn-sm" onclick="submitPC()">Submit</button>' : ''}
      ${canLock && selectedPC.status==='submitted' ? '<button class="btn btn-danger btn-sm" onclick="openLock()">🔒 Lock PC</button>' : ''}
      ${canAdmin ? '<button class="btn btn-danger btn-sm" onclick="openDeletePC()">🗑 Delete PC</button>' : ''}
    `;
  }

  // Load WIRs, overrides, billed records in parallel
  const villaIds = scopeVillas.map(v => v.villa_id);
  const actCodes = scopeActivities.map(a => a.activity_code);

  if (!villaIds.length || !actCodes.length) {
    document.getElementById('ps-wrap').innerHTML = '<div class="loading-row">No villas or activities configured for this scope.<br><small>Use ⚙ Configure to set up the scope.</small></div>';
    renderPaymentSummary();
    return;
  }

  const villaIdsStr = villaIds.join(',');
  // For split activities use base_code for the WIR query — raw_activity_code in WIR data
  // only has the base code (e.g. "3190"), never the synthetic split code ("3190-GF").
  const baseCodes = [...new Set(scopeActivities.map(a => a.base_code || a.activity_code))];
  const baseCodesStr = baseCodes.map(c => `"${c}"`).join(',');
  // Map base_code → [activity_codes] so each WIR row fans out to all its split parts
  const baseToSplits = {};
  scopeActivities.forEach(a => {
    const base = a.base_code || a.activity_code;
    if (!baseToSplits[base]) baseToSplits[base] = [];
    baseToSplits[base].push(a.activity_code);
  });

  const [wirRows, overrideRows, billedRows, pcSigs] = await Promise.all([
    fa(`v_latest_wir_status?villa_id=in.(${villaIdsStr})&raw_activity_code=in.(${baseCodesStr})&select=villa_id,raw_activity_code,normalised_status,response_date`),
    fa(`qs_pc_overrides?pc_id=eq.${selectedPC.id}&select=villa_id,activity_code,is_complete,override_reason`),
    fa(`qs_billed_records?scope_id=eq.${selectedScope.id}&villa_id=in.(${villaIdsStr})&select=villa_id,activity_code,locked_pc_id`),
    fa(`qs_pc_signatories?pc_id=eq.${selectedPC.id}&order=sort_order.asc`),
  ]);

  // Index WIR data — fan each base-code WIR row out to all its split activity_codes.
  // Period-date gate: a WIR only counts as approved if its response_date falls on or
  // before the PC's period_date. If the PC has no period_date, no date restriction applies.
  const periodDate = selectedPC.period_date || null; // "YYYY-MM-DD" or null
  wirData = {};
  wirRows.forEach(w => {
    const splits = baseToSplits[w.raw_activity_code] || [w.raw_activity_code];
    splits.forEach(actCode => {
      const key = w.villa_id + ':' + actCode;
      const existing = wirData[key];
      // Only count as approved if: status is approved AND (no period gate OR response_date ≤ period)
      const withinPeriod = !periodDate || (w.response_date && w.response_date <= periodDate);
      const approved = w.normalised_status === 'approved' && withinPeriod;
      if (!existing || approved) {
        wirData[key] = { approved, response_date: w.response_date };
      }
    });
  });

  // Index overrides
  pcOverrides = {};
  overrideRows.forEach(o => { pcOverrides[o.villa_id + ':' + o.activity_code] = o; });

  // Index billed records + map each PC id to its number (for prev/current/later ordering)
  billedRecords = {};
  billedRows.forEach(b => { billedRecords[b.villa_id + ':' + b.activity_code] = b.locked_pc_id; });
  pcNumById = {};
  (allScopePCs || []).forEach(p => { pcNumById[p.id] = p.pc_number; });
  if (selectedPC) pcNumById[selectedPC.id] = selectedPC.pc_number;

  // PC signatories
  pcSigsList = pcSigs;

  // ── Multi-scope: build a section context for every scope merged into this PC ──
  const pcScopeRows = await fa(`qs_pc_scopes?pc_id=eq.${selectedPC.id}&order=sort_order.asc&select=scope_id`);
  let scopeIds = pcScopeRows.map(r => r.scope_id).filter(Boolean);
  if (!scopeIds.includes(selectedScope.id)) scopeIds = [selectedScope.id, ...scopeIds];
  isMultiPC = scopeIds.length > 1;
  pcSections = [];
  progressSectionIdx = 0;
  if (isMultiPC) {
    const ordered = [selectedScope.id, ...scopeIds.filter(id => id !== selectedScope.id)];
    const scopeObjs = await fa(`qs_scopes?id=in.(${ordered.join(',')})&select=*`);
    const byId = {}; scopeObjs.forEach(s => byId[s.id] = s);
    for (const id of ordered) {
      const sc = byId[id]; if (!sc) continue;
      const ctx = await buildScopeCtx(sc);
      pcSections.push({ scope: sc, ctx });
    }
  }

  renderProgressSection();
  renderPaymentSummary();
}

// Progress tab. The grid edits the primary scope (globals stay primary — safe for Config).
// Other merged scopes auto-feed the combined Summary + locking from WIR data.
function renderProgressSection() {
  const host = document.getElementById('ps-section-bar');
  if (isMultiPC && pcSections.length > 1 && host) {
    host.style.display = 'flex';
    const chips = pcSections.map((s,i) => {
      const nm = escH(s.scope.sca_ref || s.scope.scope_title || ('Scope '+s.scope.id));
      const primaryStyle = 'background:var(--accent-soft,rgba(79,140,255,.14));color:var(--accent-text,#93b6ff);border-color:transparent';
      return `<span style="font-size:11px;padding:2px 9px;border:1px solid var(--bdr);border-radius:20px;${i===0?primaryStyle:'color:var(--tx2)'}">${nm}${i===0?' · editing':''}</span>`;
    }).join(' ');
    host.innerHTML = `<span style="font-size:11px;color:var(--tx3);font-weight:600">MERGED SCOPES:</span> ${chips}
      <span style="font-size:11px;color:var(--tx3);margin-left:auto">Overrides on this grid apply to the first scope. All scopes auto-feed the Payment Summary &amp; locking.</span>`;
  } else if (host) {
    host.style.display = 'none'; host.innerHTML = '';
  }
  renderProgressSheet();
}

// ══════════════════════════════════════════════
// CALCULATION ENGINE
// ══════════════════════════════════════════════
function getActivityStatus(villa_id, activity_code) {
  const key = villa_id + ':' + activity_code;
  const billedPcId = billedRecords[key];
  const override = pcOverrides[key];
  const wir = wirData[key];

  // Determine if approved to-date
  let isCompleteToDate;
  let source; // 'wir' | 'override-on' | 'override-off' | 'prev-billed'
  if (override !== undefined) {
    isCompleteToDate = override.is_complete;
    source = override.is_complete ? 'override-on' : 'override-off';
  } else {
    isCompleteToDate = wir?.approved === true;
    source = isCompleteToDate ? 'approved' : 'not-approved';
  }

  // Order by PC number: billed earlier = PREV, this PC = NOW, later = ignore for this PC
  const curNum   = selectedPC ? selectedPC.pc_number : Infinity;
  const billedNum = (billedPcId !== undefined) ? (pcNumById[billedPcId] ?? null) : null;
  const isBilledNow   = billedPcId !== undefined && billedPcId === selectedPC.id;
  const wasBilledPrev = billedPcId !== undefined && !isBilledNow && billedNum !== null && billedNum < curNum;
  const billedLater   = billedPcId !== undefined && !isBilledNow && billedNum !== null && billedNum > curNum;

  return { isCompleteToDate, wasBilledPrev, isBilledNow, billedLater, source, override, wir };
}

function calcVillaWorkdone(villa_id) {
  let prev = 0, current = 0, toDate = 0;
  // A locked PC's "current" = only what was billed IN THIS PC; a draft's "current" = approvable now.
  const locked = selectedPC && selectedPC.status === 'locked';
  scopeActivityGroups.forEach(grp => {
    const grpActs = scopeActivities.filter(a => a.group_id === grp.id);
    grpActs.forEach(act => {
      const { isCompleteToDate, wasBilledPrev, isBilledNow, billedLater } = getActivityStatus(villa_id, act.activity_code);
      if (billedLater) return;  // billed in a later PC → not part of this PC's history
      const contrib = grp.group_weight * act.activity_weight;
      if (wasBilledPrev) { prev += contrib; toDate += contrib; }
      else if (locked ? isBilledNow : isCompleteToDate) { current += contrib; toDate += contrib; }
    });
  });
  return { prev, current, toDate };
}

function getVillaRate(villa_type_label) {
  const vt = scopeVillaTypes.find(t => t.villa_type_label === villa_type_label);
  return vt ? parseFloat(vt.rate_aed) : 0;
}

// ══════════════════════════════════════════════
// MULTI-SCOPE SECTION ENGINE (parallel, context-based — does not touch the globals path)
// ══════════════════════════════════════════════
function ctxMatchVillaType(rawType, villaTypes) {
  const beds = extractBedrooms(rawType);
  if (beds && villaTypes.length) {
    const match = villaTypes.find(t => extractBedrooms(t.villa_type_label) === beds);
    if (match) return match.villa_type_label;
  }
  return villaTypes[0]?.villa_type_label || rawType || 'Unknown';
}
async function ctxDetectVillas(scope, villaTypes, activities) {
  const subName = scope.subcontractor_name;
  if (!subName) return [];
  const aliases = await fa(`subcontractor_aliases?canonical_name=ilike.${encodeURIComponent(subName)}&select=alias,canonical_name`);
  let nameFilter = aliases.length
    ? `raw_subcontractor=in.(${[...new Set([subName, ...aliases.map(a=>a.alias), ...aliases.map(a=>a.canonical_name).filter(Boolean)])].map(n=>`"${n}"`).join(',')})`
    : `raw_subcontractor=ilike.${encodeURIComponent(subName)}`;
  const actCodes = [...new Set(activities.map(a => (a.base_code || a.activity_code)).filter(Boolean))];
  if (!actCodes.length) return [];
  const actFilter = `&raw_activity_code=in.(${actCodes.map(c => `"${c}"`).join(',')})`;
  const wirRows = await fa(`v_latest_wir_status?${nameFilter}${actFilter}&select=villa_id`);
  const villaIds = [...new Set(wirRows.map(r => r.villa_id).filter(Boolean))];
  if (!villaIds.length) return [];
  const villas = await fa(`villas?id=in.(${villaIds.join(',')})&select=id,villa_no,villa_type,cluster_id&is_active=eq.true&order=cluster_id.asc,villa_no.asc`);
  return villas.map(v => ({ villa_id:v.id, villa_no:v.villa_no, villa_type_label:ctxMatchVillaType(v.villa_type, villaTypes), raw_villa_type:v.villa_type, cluster_id:v.cluster_id }));
}
// Build a self-contained data context for one scope within the current PC
async function buildScopeCtx(scope) {
  const villaTypes = await fa(`qs_scope_villa_types?scope_id=eq.${scope.id}&order=sort_order.asc`);
  const activityGroups = await fa(`qs_scope_activity_groups?scope_id=eq.${scope.id}&order=sort_order.asc`);
  const groupIds = activityGroups.map(g => g.id);
  const activities = groupIds.length ? await fa(`qs_scope_activities?group_id=in.(${groupIds.join(',')})&order=sort_order.asc`) : [];
  const villas = await ctxDetectVillas(scope, villaTypes, activities);
  const variations = await fa(`qs_variation_orders?scope_id=eq.${scope.id}&order=created_at.asc`);
  const wir = {}, overrides = {}, billed = {};
  const villaIds = villas.map(v => v.villa_id);
  const actCodes = activities.map(a => a.activity_code);
  if (villaIds.length && actCodes.length) {
    const vStr = villaIds.join(','), aStr = actCodes.map(c => `"${c}"`).join(',');
    const [wirRows, ovRows, bRows] = await Promise.all([
      fa(`v_latest_wir_status?villa_id=in.(${vStr})&raw_activity_code=in.(${aStr})&select=villa_id,raw_activity_code,normalised_status,response_date`),
      fa(`qs_pc_overrides?pc_id=eq.${selectedPC.id}&select=villa_id,activity_code,is_complete`),
      fa(`qs_billed_records?scope_id=eq.${scope.id}&villa_id=in.(${vStr})&select=villa_id,activity_code,locked_pc_id`),
    ]);
    wirRows.forEach(w => { const k=w.villa_id+':'+w.raw_activity_code; if(!wir[k]||w.normalised_status==='approved') wir[k]={approved:w.normalised_status==='approved',response_date:w.response_date}; });
    ovRows.forEach(o => { overrides[o.villa_id+':'+o.activity_code]=o; });
    bRows.forEach(b => { billed[b.villa_id+':'+b.activity_code]=b.locked_pc_id; });
  }
  return { scope, villaTypes, activityGroups, activities, villas, variations, wir, overrides, billed };
}
function ctxActStatus(ctx, villa_id, activity_code) {
  const key = villa_id+':'+activity_code;
  const billedPcId = ctx.billed[key];
  const override = ctx.overrides[key];
  const wir = ctx.wir[key];
  const isCompleteToDate = (override !== undefined) ? override.is_complete : (wir?.approved === true);
  const curNum   = selectedPC ? selectedPC.pc_number : Infinity;
  const billedNum = (billedPcId !== undefined) ? (pcNumById[billedPcId] ?? null) : null;
  const isBilledNow   = billedPcId !== undefined && billedPcId === selectedPC.id;
  const wasBilledPrev = billedPcId !== undefined && !isBilledNow && billedNum !== null && billedNum < curNum;
  const billedLater   = billedPcId !== undefined && !isBilledNow && billedNum !== null && billedNum > curNum;
  const source = override!==undefined ? (override.is_complete?'override-on':'override-off') : (isCompleteToDate?'approved':'not-approved');
  return { isCompleteToDate, wasBilledPrev, isBilledNow, billedLater, source };
}
function ctxWorkdone(ctx, villa_id) {
  let prev=0, current=0, toDate=0;
  const locked = selectedPC && selectedPC.status === 'locked';
  ctx.activityGroups.forEach(grp => {
    ctx.activities.filter(a => a.group_id === grp.id).forEach(act => {
      const { isCompleteToDate, wasBilledPrev, isBilledNow, billedLater } = ctxActStatus(ctx, villa_id, act.activity_code);
      if (billedLater) return;
      const contrib = (grp.group_weight||0) * (act.activity_weight||0);
      if (wasBilledPrev) { prev += contrib; toDate += contrib; }
      else if (locked ? isBilledNow : isCompleteToDate) { current += contrib; toDate += contrib; }
    });
  });
  return { prev, current, toDate };
}
// Aggregate a scope context into per-villa-type rows + section totals
function ctxSection(ctx) {
  const typeMap = {};
  ctx.villaTypes.forEach(t => { typeMap[t.villa_type_label] = { type:t, prev:0, current:0, toDate:0, rate:parseFloat(t.rate_aed)||0, qty:parseInt(t.qty_contracted)||0, detectedQty:0 }; });
  ctx.villas.forEach(sv => {
    const tm = typeMap[sv.villa_type_label]; if (!tm) return;
    tm.detectedQty++;
    const w = ctxWorkdone(ctx, sv.villa_id);
    tm.prev += w.prev; tm.current += w.current; tm.toDate += w.toDate;
  });
  const entries = Object.values(typeMap);
  // subContract uses detectedQty per scope so sibling scopes don't double-count qty_contracted
  const subContract = entries.reduce((a,t)=>a+t.detectedQty*t.rate, 0);
  const subPrev = entries.reduce((a,t)=>a+t.prev*t.rate, 0);
  const subCur  = entries.reduce((a,t)=>a+t.current*t.rate, 0);
  const subTod  = entries.reduce((a,t)=>a+t.toDate*t.rate, 0);
  const approvedVOs = (ctx.variations||[]).filter(v=>v.status==='approved').reduce((a,v)=>a+(parseFloat(v.value_aed)||0),0);
  return { scope: ctx.scope, entries, subContract, subPrev, subCur, subTod, approvedVOs };
}

// ══════════════════════════════════════════════
// PROGRESS SHEET RENDER
// ══════════════════════════════════════════════
function renderProgressSheet() {
  if (!scopeVillas.length || !scopeActivities.length) {
    document.getElementById('ps-wrap').innerHTML = '<div class="loading-row">No villas or activities configured.<br><small>Use ⚙ Configure to set up the scope.</small></div>';
    return;
  }

  const isLocked = selectedPC.status === 'locked';
  const canEdit = !isLocked && (canManage || canAdmin);

  // Build column headers
  let thGroups = '<th class="sticky col-sr" rowspan="2">Sr.</th><th class="sticky col-villa" rowspan="2">Villa</th><th class="sticky col-type" rowspan="2">Type</th><th class="sticky col-cluster" rowspan="2">Cluster</th>';
  let thActs = ''; // Sr/Villa/Type/Cluster are rowspan=2 in thGroups — no placeholder cells needed in row 2
  scopeActivityGroups.forEach(grp => {
    const grpActs = scopeActivities.filter(a => a.group_id === grp.id);
    thGroups += `<th class="group-hdr" colspan="${grpActs.length}">${escH(grp.group_name)} (${(grp.group_weight*100).toFixed(0)}%)</th>`;
    grpActs.forEach(act => {
      thActs += `<th style="white-space:normal;min-width:70px;vertical-align:top;padding:7px 10px;text-align:center"><div style="font-size:12px;font-weight:600;color:var(--tx);line-height:1.3;margin-bottom:3px">${escH(act.activity_name)}${act.part_label?' <span style="color:var(--accent,#4f8cff)">('+escH(act.part_label)+')</span>':''}</div><div style="font-size:11px;font-weight:700;color:var(--tx2);white-space:nowrap">${escH(act.activity_code)}</div><div style="font-size:11px;color:var(--gold);margin-top:2px">${(act.activity_weight*100).toFixed(0)}%</div></th>`;
    });
  });
  thGroups += '<th rowspan="2">Rate (AED)</th><th colspan="3">Amount (AED)</th>';
  thActs += '<th class="aed-prev">PREV</th><th class="aed-cur">CURRENT</th><th class="aed-date">TO DATE</th>';

  // A villa belongs to this PC only if it has work billed in this or an earlier PC
  // (or, for a draft, work that's approvable now). Villas billed only in LATER PCs are hidden.
  const villaInThisPc = sv => scopeActivities.some(a => {
    const st = getActivityStatus(sv.villa_id, a.activity_code);
    return st.wasBilledPrev || st.isBilledNow || (!isLocked && st.isCompleteToDate && !st.billedLater);
  });

  // Apply cluster filter + PC relevance
  const visibleVillas = scopeVillas.filter(v =>
    (psClusterFilter === 'all' || String(v.cluster_id) === String(psClusterFilter)) && villaInThisPc(v)
  );

  // Build rows
  let rows = '';
  if (!visibleVillas.length) {
    rows = `<tr><td colspan="100" style="text-align:center;color:var(--tx3);padding:24px;font-size:12px">No villas in Cluster ${psClusterFilter}.</td></tr>`;
  }
  visibleVillas.forEach((sv, idx) => {
    const { prev, current, toDate } = calcVillaWorkdone(sv.villa_id);
    const rate = getVillaRate(sv.villa_type_label);
    const prevAed = prev * rate;
    const curAed = current * rate;
    const todAed = toDate * rate;

    let actCells = '';
    scopeActivityGroups.forEach(grp => {
      const grpActs = scopeActivities.filter(a => a.group_id === grp.id);
      grpActs.forEach(act => {
        const { isCompleteToDate, wasBilledPrev, isBilledNow, source } = getActivityStatus(sv.villa_id, act.activity_code);
        let cls = 'act-cell';
        let label = '—';
        if (wasBilledPrev) { cls += ' prev-billed readonly'; label = '✓ₚ'; }
        else if (isBilledNow) { cls += ' approved readonly'; label = '✓ₗ'; }
        else if (source === 'override-on') { cls += ' override-on'; label = '✓ᵒ'; }
        else if (source === 'override-off') { cls += ' override-off'; label = '✗ᵒ'; }
        else if (source === 'approved') { cls += ' approved'; label = '✓'; }
        else { cls += ' not-approved'; label = '—'; }
        if (!wasBilledPrev && canEdit) cls += '';
        const click = (!wasBilledPrev && canEdit) ? `onclick="openOverride(${sv.villa_id},'${escH(act.activity_code)}','${escH(sv.villa_no)}','${escH(act.activity_name)}')"` : '';
        actCells += `<td style="text-align:center;vertical-align:middle;padding:5px 8px"><div class="${cls}" ${click} title="${escH(act.activity_name)}">${label}</div></td>`;
      });
    });

    rows += `<tr>
      <td class="left sticky col-sr" style="font-size:12px">${idx+1}</td>
      <td class="left sticky col-villa" style="font-weight:700;font-size:13px;padding:6px 10px">VI-${escH(sv.villa_no)}</td>
      <td class="left sticky col-type" style="font-size:12px;padding:6px 10px">${escH(sv.villa_type_label)}</td>
      <td class="sticky col-cluster" style="font-size:12px;font-weight:600;color:var(--tx2)">${sv.cluster_id != null ? 'C'+sv.cluster_id : '—'}</td>
      ${actCells}
      <td class="rate-cell">${fmtAED(rate)}</td>
      <td class="aed-cell aed-prev">${fmtAED(prevAed)}</td>
      <td class="aed-cell aed-cur">${fmtAED(curAed)}</td>
      <td class="aed-cell aed-date">${fmtAED(todAed)}</td>
    </tr>`;
  });

  document.getElementById('ps-wrap').innerHTML = `
    <table class="ps-table">
      <thead><tr>${thGroups}</tr><tr>${thActs}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function refreshProgress() { await loadPCData(); }

// ══════════════════════════════════════════════
// PRINT
// ══════════════════════════════════════════════
function _buildPrintHeader() {
  const ph = document.getElementById('print-cert-header');
  if (!ph || !selectedScope || !selectedPC) return;
  const project = selectedScope.project || 'RA4104 — Baghaiylum Villas Development';
  const printDate = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'long', year:'numeric' });
  const statusLabel = selectedPC.status.charAt(0).toUpperCase() + selectedPC.status.slice(1);
  const _hdrScopes = (isMultiPC && pcSections.length>1) ? pcSections.map(s=>s.scope) : [selectedScope];
  const scaRefCombined = _hdrScopes.map(s=>s.sca_ref).filter(Boolean).join(' & ') || '—';
  const scopeTitleCombined = _hdrScopes.map(s=>s.scope_title).filter(Boolean).join('  &  ') || '—';
  const tdL = 'style="padding:3px 10px 3px 0;width:13%;color:#555;font-weight:700;font-size:8pt;white-space:nowrap;vertical-align:middle"';
  const tdV = 'style="padding:3px 16px 3px 0;font-size:8.5pt;color:#000;vertical-align:middle"';
  ph.innerHTML = `
    <!-- Top band: logo · title · PC info -->
    <table style="width:100%;border-collapse:collapse;margin-bottom:6px">
      <tr>
        <td style="width:64px;vertical-align:middle;padding-right:10px">
          <img src="data:image/png;base64,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" style="width:58px;height:auto;object-fit:contain;display:block" alt="Royal Advance">
        </td>
        <td style="vertical-align:middle;padding-right:10px">
          <div style="font-size:8pt;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#444;margin-bottom:2px">Royal Advance</div>
          <div style="font-size:17pt;font-weight:800;color:#000;letter-spacing:-.02em;line-height:1">Interim Payment Certificate</div>
        </td>
        <td style="vertical-align:top;text-align:right;white-space:nowrap;padding-left:20px">
          <div style="font-size:13pt;font-weight:800;color:#000">PC No. ${selectedPC.pc_number}</div>
          <div style="font-size:8.5pt;color:#444;margin-top:3px">Period: <b>${escH(selectedPC.period_label)}</b></div>
          <div style="font-size:7.5pt;color:#777;margin-top:2px">Status: ${statusLabel} &nbsp;·&nbsp; Printed: ${printDate}</div>
        </td>
      </tr>
    </table>
    <!-- Details band -->
    <table style="width:100%;border-collapse:collapse;border-top:2px solid #000;border-bottom:1px solid #bbb;font-family:inherit">
      <tr>
        <td ${tdL}>PROJECT:</td>
        <td ${tdV} colspan="3">${escH(project)}</td>
        <td ${tdL} style="padding:3px 10px 3px 12px;width:10%;color:#555;font-weight:700;font-size:8pt;white-space:nowrap;vertical-align:middle">SCA REF:</td>
        <td ${tdV} style="padding:3px 16px 3px 0;font-size:8.5pt;color:#000;vertical-align:middle;width:16%">${escH(scaRefCombined)}</td>
        <td ${tdL} style="padding:3px 10px 3px 12px;width:10%;color:#555;font-weight:700;font-size:8pt;white-space:nowrap;vertical-align:middle">PACKAGE:</td>
        <td ${tdV} style="padding:3px 0 3px 0;font-size:8.5pt;color:#000;vertical-align:middle">${escH(selectedScope.package||'—')}</td>
      </tr>
      <tr>
        <td ${tdL}>SUBCONTRACTOR:</td>
        <td ${tdV} colspan="3">${escH(scopeDisplayName(selectedScope))}</td>
        <td ${tdL} style="padding:3px 10px 3px 12px;color:#555;font-weight:700;font-size:8pt;white-space:nowrap;vertical-align:middle">PC NO:</td>
        <td ${tdV} style="padding:3px 16px 3px 0;font-size:8.5pt;color:#000;vertical-align:middle">${selectedPC.pc_number}</td>
        <td colspan="2"></td>
      </tr>
      <tr>
        <td ${tdL}>SCOPE:</td>
        <td ${tdV} colspan="7">${escH(scopeTitleCombined)}</td>
      </tr>
    </table>`;
  // Mirror to the summary page header too
  const ph2 = document.getElementById('print-cert-header-2');
  if (ph2) ph2.innerHTML = ph.innerHTML;
}

function printCertificate() {
  if (!selectedScope || !selectedPC) return;
  _buildPrintHeader();
  // Ensure the payment summary is rendered (it may not be if user never visited that tab)
  const summaryEmpty = (document.getElementById('psum-inner')?.children.length || 0) <= 1;
  if (summaryEmpty) renderPaymentSummary();
  window.print();
}

function printProgressSheet() {
  if (!selectedScope || !selectedPC) return;
  _buildPrintHeader();
  // Temporarily add a class to body so CSS can hide the summary tab
  document.body.classList.add('print-ps-only');
  setTimeout(() => {
    window.print();
    document.body.classList.remove('print-ps-only');
  }, 80);
}

// ── Excel export (uses the SheetJS already loaded for the BOQ import) ──
function _xlsxFileBase() {
  const sub = String(selectedScope?.subcontractor_name || 'PC').replace(/[^\w]+/g,'_').replace(/^_+|_+$/g,'');
  const per = String(selectedPC?.period_label || '').replace(/[^\w]+/g,'_').replace(/^_+|_+$/g,'');
  return 'PC' + (selectedPC?.pc_number ?? '') + '_' + sub + (per ? '_'+per : '');
}

function exportSummaryExcel() {
  if (typeof XLSX === 'undefined') { alert('Spreadsheet library not loaded — check your connection and retry.'); return; }
  if (!selectedPC || !selectedScope) return;
  const inner = document.getElementById('psum-inner');
  const itemTable = inner && inner.querySelector('.psum-table');
  if (!itemTable) { alert('Open the Payment Summary tab first.'); return; }
  // Faithful copy of the certificate items table
  const ws = XLSX.utils.table_to_sheet(itemTable, { raw:false });
  // Append the financial summary block (it's div-based, not a table)
  const _num = s => { const v = parseFloat(String(s).replace(/[^0-9.\-]/g,'')); return (String(s).trim()===''||isNaN(v)) ? (String(s).trim()) : v; };
  const fin = [[''], ['Financial Summary', 'Previous', 'Current', 'To Date']];
  inner.querySelectorAll('.fin-block .fin-row').forEach(r => {
    const label = (r.querySelector('.fin-label, .fin-toggle')?.textContent || '').replace(/\s+/g,' ').trim();
    const vals  = [...r.querySelectorAll('.fin-vals .fin-val')].map(v => (v.textContent||'').trim());
    if (label) fin.push([label, _num(vals[0]||''), _num(vals[1]||''), _num(vals[2]||'')]);
  });
  XLSX.utils.sheet_add_aoa(ws, fin, { origin: -1 });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Payment Summary');
  XLSX.writeFile(wb, _xlsxFileBase() + '_Summary.xlsx');
}

function exportProgressExcel() {
  if (typeof XLSX === 'undefined') { alert('Spreadsheet library not loaded — check your connection and retry.'); return; }
  if (!selectedPC || !selectedScope) return;
  const t = document.querySelector('#ps-wrap .ps-table');
  if (!t) { alert('No progress sheet to export — configure the scope first.'); return; }
  const ws = XLSX.utils.table_to_sheet(t, { raw:false });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Progress Sheet');
  XLSX.writeFile(wb, _xlsxFileBase() + '_Progress.xlsx');
}

// Populate the cluster filter dropdown based on clusters present in scopeVillas
function updateClusterFilter() {
  const sel = document.getElementById('ps-cluster-filter');
  const lbl = document.getElementById('ps-cluster-label');
  if (!sel) return;
  const clusters = [...new Set(scopeVillas.map(v => v.cluster_id).filter(c => c != null))].sort((a,b)=>a-b);
  sel.innerHTML = '<option value="all">All Clusters</option>' + clusters.map(c => `<option value="${c}">Cluster ${c}</option>`).join('');
  sel.value = 'all';
  psClusterFilter = 'all';
  const show = clusters.length > 1;
  sel.style.display = show ? '' : 'none';
  if (lbl) lbl.style.display = show ? '' : 'none';
}

// ══════════════════════════════════════════════
// PAYMENT SUMMARY RENDER
// ══════════════════════════════════════════════
// Dispatcher: multi-scope PCs render the merged certificate; single-scope keeps the original path.
function renderPaymentSummary() {
  if (isMultiPC && pcSections.length > 1) { renderPaymentSummaryMulti(); return; }
  renderPaymentSummarySingle();
}

function renderPaymentSummarySingle() {
  // Aggregate by villa type
  const typeMap = {};
  scopeVillaTypes.forEach(t => {
    typeMap[t.villa_type_label] = { type: t, prev:0, current:0, toDate:0, rate: parseFloat(t.rate_aed), qty: parseInt(t.qty_contracted) };
  });
  scopeVillas.forEach(sv => {
    const { prev, current, toDate } = calcVillaWorkdone(sv.villa_id);
    const tm = typeMap[sv.villa_type_label];
    if (!tm) return;
    tm.prev    += prev;
    tm.current += current;
    tm.toDate  += toDate;
  });

  const typeEntries = Object.values(typeMap);
  const totPrevQty  = typeEntries.reduce((a,t)=>a+t.prev, 0);
  const totCurQty   = typeEntries.reduce((a,t)=>a+t.current, 0);
  const totTodQty   = typeEntries.reduce((a,t)=>a+t.toDate, 0);
  const totSubconAmt = typeEntries.reduce((a,t)=>a+t.qty*t.rate, 0);
  const totPrevAmt  = typeEntries.reduce((a,t)=>a+t.prev*t.rate, 0);
  const totCurAmt   = typeEntries.reduce((a,t)=>a+t.current*t.rate, 0);
  const totTodAmt   = typeEntries.reduce((a,t)=>a+t.toDate*t.rate, 0);
  lastGrossAed = totTodAmt; // captured for confirmLock()

  // Financial calculations
  const ded   = parseFloat(selectedPC.deduction_aed)||0;
  const vr    = parseFloat(selectedPC.vat_rate)||0.05;

  // Advance recovery: stored per-PC override OR auto-calc from scope %
  const advPct  = parseFloat(selectedScope.advance_recovery_pct)||0;
  const advAuto = totTodAmt * advPct;
  const advStored = parseFloat(selectedPC.advance_recovery_aed)||0;
  const adv = advStored > 0 ? advStored : (advPct > 0 ? advAuto : 0);

  // Retention: per-PC % override OR scope default %, applied to (gross − advance).
  const scopeRetPct = parseFloat(selectedScope.retention_pct)||0;
  const retOvr  = (selectedPC.retention_pct_override===null||selectedPC.retention_pct_override===undefined||selectedPC.retention_pct_override==='')
                    ? null : parseFloat(selectedPC.retention_pct_override);
  const retPct  = retOvr!==null ? retOvr : scopeRetPct;   // effective rate (fraction)
  const retBase = totTodAmt - adv;
  const retAuto = retBase * retPct;
  const retStored = parseFloat(selectedPC.retention_aed)||0;
  // Locked PCs keep their stored snapshot; drafts compute live from the % rate.
  const ret = !selectedPC.retention_applicable ? 0
              : ((selectedPC.status==='locked' && retStored>0) ? retStored : retAuto);

  const certified = totTodAmt - adv - ded - ret;
  const vat   = certified * vr;
  const net   = certified + vat;

  // Prev PC calculations (use same deduction/adv/ret for simplicity)
  const advPrev   = totPrevAmt * advPct;
  const retPrev   = selectedPC.retention_applicable ? (totPrevAmt - advPrev) * retPct : 0;
  const certPrev  = totPrevAmt - advPrev - ded - retPrev;
  const vatPrev   = certPrev * vr;
  const netPrev   = certPrev + vatPrev;

  // Current PC calculations (derived from to-date minus previous)
  const advCur  = totCurAmt * advPct;
  const retCur  = selectedPC.retention_applicable ? (totCurAmt - advCur) * retPct : 0;
  const certCur = totCurAmt - advCur - retCur;   // ded already in both tod & prev, cancels
  const vatCur  = certCur * vr;
  const netCur  = certCur + vatCur;

  // Contract position (running totals from all scope PCs)
  const contractValue = parseFloat(selectedScope.contract_value_aed)||0;
  const approvedVOsTotal = scopeVariations
    .filter(v => v.status === 'approved')
    .reduce((a,v) => a + (parseFloat(v.value_aed)||0), 0);
  const adjustedContract = contractValue + approvedVOsTotal;

  // Cumulative retention + advance from locked PCs (excluding current PC, which uses live calcs)
  const otherLockedPCs = allScopePCs.filter(p => p.status === 'locked' && p.id !== selectedPC.id);
  const retHeldOther  = otherLockedPCs.reduce((a,p) => a + (parseFloat(p.retention_aed)||0), 0);
  const advRecOther   = otherLockedPCs.reduce((a,p) => a + (parseFloat(p.advance_recovery_aed)||0), 0);
  // Include current PC if locked or submitted
  const includeThis   = selectedPC.status === 'locked' || selectedPC.status === 'submitted';
  const retHeldTotal  = retHeldOther + (includeThis ? ret : 0);
  const advRecTotal   = advRecOther  + (includeThis ? adv : 0);
  const advanceBalance = Math.max(0, (parseFloat(selectedScope.advance_amount_aed)||0) - advRecTotal);

  const isLocked = selectedPC.status === 'locked';
  const canEditFin = !isLocked || canAdmin;
  const canEditSigs = canManage || canAdmin;

  // Items table rows
  let itemRows = typeEntries.map((t,i) => `
    <tr>
      <td class="center">${i+2}</td>
      <td>${escH(t.type.villa_type_label)}</td>
      <td class="center">${escH(t.type.unit||'Villa')}</td>
      <td class="center">${t.qty}</td>
      <td class="right">${fmtAED(t.rate)}</td>
      <td class="right bold">${fmtAED(t.qty*t.rate)}</td>
      <td class="center">${fmtQty(t.prev)}</td>
      <td class="center">${fmtQty(t.current)}</td>
      <td class="center bold">${fmtQty(t.toDate)}</td>
      <td class="center">${fmtPct(t.prev/Math.max(t.qty,1))}</td>
      <td class="right">${fmtAED(t.prev*t.rate)}</td>
      <td class="center">${fmtPct(t.current/Math.max(t.qty,1))}</td>
      <td class="right">${fmtAED(t.current*t.rate)}</td>
      <td class="center bold">${fmtPct(t.toDate/Math.max(t.qty,1))}</td>
      <td class="right bold">${fmtAED(t.toDate*t.rate)}</td>
    </tr>`).join('');

  // Summary table rows
  let sumRows = typeEntries.map(t => `
    <tr>
      <td>${escH(t.type.villa_type_label)}</td>
      <td class="center">${escH(t.type.unit||'Villa')}</td>
      <td class="center">${t.qty}</td>
      <td class="right">${fmtAED(t.rate)}</td>
      <td class="right">${fmtAED(t.qty*t.rate)}</td>
      <td class="center">${fmtQty(t.prev)}</td>
      <td class="center">${fmtQty(t.current)}</td>
      <td class="center bold">${fmtQty(t.toDate)}</td>
      <td class="center">${fmtPct(t.prev/Math.max(t.qty,1))}</td>
      <td class="right">${fmtAED(t.prev*t.rate)}</td>
      <td class="center">${fmtPct(t.current/Math.max(t.qty,1))}</td>
      <td class="right">${fmtAED(t.current*t.rate)}</td>
      <td class="center bold">${fmtPct(t.toDate/Math.max(t.qty,1))}</td>
      <td class="right bold">${fmtAED(t.toDate*t.rate)}</td>
    </tr>`).join('');

  // Signature block
  const sigItems = pcSigsList.map(s => `
    <div class="sig-item">
      <div class="sig-position">${escH(s.position_title)}</div>
      <div class="sig-line"></div>
      <div class="sig-name">${escH(s.full_name)}</div>
      <div class="sig-company">${escH(s.company||'')}</div>
    </div>`).join('');

  const finInputAttr = canEditFin ? '' : 'disabled';
  const retCheck = selectedPC.retention_applicable ? 'checked' : '';
  const advHint  = advPct > 0 ? `<span class="fin-auto-hint">auto: ${fmtAED(advAuto)}</span>${canEditFin && advStored > 0 ? `<button class="fin-auto-btn" onclick="resetAdvAuto()">↺ Auto</button>` : ''}` : '';
  const retHint  = `<span class="fin-auto-hint">${retOvr!==null ? 'scope default '+(scopeRetPct*100).toFixed(1)+'%' : (scopeRetPct>0 ? 'scope rate '+(scopeRetPct*100).toFixed(1)+'%' : 'no scope rate set')}${retPct>0 ? ' · = '+fmtAED(retAuto) : ''}</span>${canEditFin && retOvr!==null ? `<button class="fin-auto-btn" onclick="resetRetAuto()">↺ Default</button>` : ''}`;

  document.getElementById('psum-inner').innerHTML = `
    <!-- Actions -->
    <div class="psum-actions">
      <button class="btn btn-primary btn-sm" onclick="printCertificate()">🖨 Print Certificate</button>
      <button class="btn btn-ghost btn-sm" onclick="printProgressSheet()">📋 Print Progress Sheet</button>
      <button class="btn btn-ghost btn-sm" onclick="exportSummaryExcel()">⬇ Summary (Excel)</button>
      <button class="btn btn-ghost btn-sm" onclick="exportProgressExcel()">⬇ Progress (Excel)</button>
      ${canEditSigs ? `<button class="btn btn-ghost btn-sm" onclick="openPcSigs()">✍ Edit Signatories</button>` : ''}
    </div>

    <!-- Header block -->
    <div class="psum-hdr-block">
      <div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap">
        <!-- Logo placeholder -->
        <div id="psum-logo-box" style="width:72px;flex-shrink:0;display:flex;align-items:center"><img src="data:image/png;base64,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" style="width:72px;height:auto;object-fit:contain;display:block" alt="Royal Advance"></div>
        <!-- Project details -->
        <div style="flex:1;min-width:200px">
          <div class="psum-hdr-row"><span class="psum-hdr-label">PROJECT:</span><span class="psum-hdr-val">${escH(selectedScope.project||'RA4104- BAGHAIYLUM VILLAS DEVELOPMENT')}</span></div>
          <div class="psum-hdr-row"><span class="psum-hdr-label">SUBCONTRACTOR:</span><span class="psum-hdr-val">${escH(scopeDisplayName(selectedScope))}</span></div>
          <div class="psum-hdr-row"><span class="psum-hdr-label">SCOPE OF WORKS:</span><span class="psum-hdr-val">${escH(selectedScope.scope_title||'')}</span></div>
          <div class="psum-hdr-row"><span class="psum-hdr-label">SCA REF #:</span><span class="psum-hdr-val">${escH(selectedScope.sca_ref||'—')}</span></div>
        </div>
        <!-- PC info -->
        <div style="text-align:right;flex-shrink:0">
          <div class="psum-hdr-row"><span class="psum-hdr-label">PC NO:</span><span class="psum-hdr-val">${selectedPC.pc_number}</span></div>
          <div class="psum-hdr-row"><span class="psum-hdr-label">PERIOD:</span><span class="psum-hdr-val">${escH(selectedPC.period_label)}</span></div>
        </div>
      </div>
    </div>

    <div class="psum-section-title">Subcontractor Interim Payment Summary</div>

    <!-- Items table -->
    <table class="psum-table">
      <thead>
        <tr>
          <th rowspan="2">Item</th>
          <th rowspan="2">Description</th>
          <th rowspan="2">Unit</th>
          <th rowspan="2">QTY (No)</th>
          <th rowspan="2">Rate (AED)</th>
          <th rowspan="2">Subcontract Amount (AED)</th>
          <th colspan="3">Progress QTY</th>
          <th colspan="6">Amount (AED)</th>
        </tr>
        <tr>
          <th>Prev</th><th>Current</th><th>To Date</th>
          <th>% Prev</th><th>Prev</th><th>% Cur</th><th>Current</th><th>% ToDate</th><th>To Date</th>
        </tr>
      </thead>
      <tbody>
        <tr><td class="center">1</td><td colspan="14">${escH(selectedScope.scope_title||'')}</td></tr>
        ${itemRows}
        <tr class="total-row">
          <td colspan="2" class="bold">SUBTOTAL</td>
          <td></td>
          <td class="center bold">${typeEntries.reduce((a,t)=>a+t.qty,0)}</td>
          <td></td>
          <td class="right bold">${fmtAED(totSubconAmt)}</td>
          <td class="center">${fmtQty(totPrevQty)}</td>
          <td class="center">${fmtQty(totCurQty)}</td>
          <td class="center bold">${fmtQty(totTodQty)}</td>
          <td></td><td class="right">${fmtAED(totPrevAmt)}</td>
          <td></td><td class="right">${fmtAED(totCurAmt)}</td>
          <td></td><td class="right bold">${fmtAED(totTodAmt)}</td>
        </tr>
      </tbody>
    </table>

    <div class="psum-section-title">Summary</div>
    <table class="psum-table">
      <thead>
        <tr>
          <th>Description</th><th>Unit</th><th>QTY</th><th>Rate</th><th>Subcon Amt</th>
          <th>QTY-Prev</th><th>QTY-Cur</th><th>QTY-ToDate</th>
          <th>%-Prev</th><th>Amt-Prev</th>
          <th>%-Cur</th><th>Amt-Cur</th>
          <th>%-ToDate</th><th>Amt-ToDate</th>
        </tr>
      </thead>
      <tbody>
        ${sumRows}
        <tr class="total-row">
          <td colspan="2" class="bold">TOTAL — WORK DONE</td>
          <td class="center bold">${typeEntries.reduce((a,t)=>a+t.qty,0)}</td>
          <td></td>
          <td class="right bold">${fmtAED(totSubconAmt)}</td>
          <td class="center">${fmtQty(totPrevQty)}</td>
          <td class="center">${fmtQty(totCurQty)}</td>
          <td class="center bold">${fmtQty(totTodQty)}</td>
          <td></td><td class="right">${fmtAED(totPrevAmt)}</td>
          <td></td><td class="right">${fmtAED(totCurAmt)}</td>
          <td></td><td class="right bold">${fmtAED(totTodAmt)}</td>
        </tr>
      </tbody>
    </table>

    <!-- Financial Footer -->
    <div class="psum-section-title">Financial Summary</div>
    <div class="fin-block">
      <div class="fin-row">
        <span class="fin-label">Gross Total</span>
        <div class="fin-vals">
          <span class="fin-val prev">${fmtAED(totPrevAmt)}</span>
          <span class="fin-val cur">${fmtAED(totCurAmt)}</span>
          <span class="fin-val total">${fmtAED(totTodAmt)}</span>
        </div>
      </div>
      ${advPct > 0 || advStored > 0 ? `
      <div class="fin-row">
        <div class="fin-row-label-group">
          <span class="fin-label">Advance Recovery${advPct > 0 ? ` (${(advPct*100).toFixed(1)}%)` : ''}</span>
          ${canEditFin ? `<input class="fin-input" id="fin-adv" type="number" value="${advStored||''}" min="0" placeholder="${fmtAED(advAuto)}" onchange="saveFinancials()" ${finInputAttr}>` : `<span class="fin-val">${fmtAED(adv)}</span>`}
          ${advHint}
        </div>
        <div class="fin-vals">
          <span class="fin-val prev">${fmtAED(advPrev)}</span>
          <span class="fin-val cur">${fmtAED(advCur)}</span>
          <span class="fin-val total">${fmtAED(adv)}</span>
        </div>
      </div>` : ''}
      <div class="fin-row">
        <div class="fin-row-label-group">
          <span class="fin-label">Deductions</span>
          ${canEditFin ? `<input class="fin-input" id="fin-ded" type="number" value="${ded}" min="0" onchange="saveFinancials()" ${finInputAttr}>` : `<span class="fin-val">${fmtAED(ded)}</span>`}
        </div>
        <div class="fin-vals">
          <span class="fin-val prev">—</span>
          <span class="fin-val cur">${ded > 0 ? fmtAED(ded) : '—'}</span>
          <span class="fin-val total">${fmtAED(ded)}</span>
        </div>
      </div>
      <div class="fin-row">
        <div class="fin-row-label-group">
          <label class="fin-toggle"><input type="checkbox" id="fin-ret-toggle" ${retCheck} onchange="saveFinancials()" ${canEditFin?'':'disabled'}> Retention${retPct > 0 ? ` (${(retPct*100).toFixed(1)}%)` : ''}</label>
          ${canEditFin ? `<span style="display:inline-flex;align-items:center;gap:4px"><input class="fin-input" id="fin-ret" type="number" value="${retOvr!==null ? +(retOvr*100).toFixed(4) : ''}" min="0" max="100" step="0.1" placeholder="${(scopeRetPct*100).toFixed(1)}" ${retCheck?'':'disabled'} onchange="saveFinancials()" title="Retention rate (%) for this PC — leave blank to use the scope default"><span style="color:var(--tx3);font-size:12px">%</span></span>` : `<span class="fin-val">${fmtAED(ret)}</span>`}
          ${retHint}
        </div>
        <div class="fin-vals">
          <span class="fin-val prev">${fmtAED(retPrev)}</span>
          <span class="fin-val cur">${selectedPC.retention_applicable ? fmtAED(retCur) : '—'}</span>
          <span class="fin-val total">${selectedPC.retention_applicable ? fmtAED(ret) : 'Not Applicable'}</span>
        </div>
      </div>
      <div class="fin-row" style="border-top:2px solid var(--bdr2)">
        <span class="fin-label">Total Certified Amount</span>
        <div class="fin-vals">
          <span class="fin-val prev">${fmtAED(certPrev)}</span>
          <span class="fin-val cur">${fmtAED(certCur)}</span>
          <span class="fin-val total">${fmtAED(certified)}</span>
        </div>
      </div>
      <div class="fin-row">
        <div class="fin-row-label-group">
          <span class="fin-label">VAT</span>
          ${canEditFin ? `<input class="fin-input" id="fin-vat" type="number" value="${(vr*100).toFixed(1)}" min="0" max="100" step="0.1" onchange="saveFinancials()" ${finInputAttr}> %` : `<span class="fin-val">${(vr*100).toFixed(1)}%</span>`}
        </div>
        <div class="fin-vals">
          <span class="fin-val prev">${fmtAED(vatPrev)}</span>
          <span class="fin-val cur">${fmtAED(vatCur)}</span>
          <span class="fin-val total">${fmtAED(vat)}</span>
        </div>
      </div>
      <div class="fin-row" style="border-top:2px solid var(--bdr2)">
        <span class="fin-label" style="font-size:13px;color:var(--gold)">Net Total</span>
        <div class="fin-vals">
          <span class="fin-val prev grand">${fmtAED(netPrev)}</span>
          <span class="fin-val cur grand">${fmtAED(netCur)}</span>
          <span class="fin-val total grand">${fmtAED(net)}</span>
        </div>
      </div>
    </div>

    <!-- Contract Position (only if contract value is set) -->
    ${contractValue > 0 || approvedVOsTotal > 0 ? `
    <div class="psum-section-title">Contract Position</div>
    <div class="pos-block">
      <div class="pos-row">
        <span class="pos-label">Original Contract Value</span>
        <span class="pos-val">${fmtAED(contractValue)}</span>
      </div>
      ${approvedVOsTotal > 0 ? `
      ${scopeVariations.filter(v=>v.status==='approved').map(v=>`
      <div class="pos-row" style="padding-left:14px">
        <span class="pos-label" style="color:var(--tx3);font-size:11px">${escH(v.vo_ref||'VO')} · ${escH(v.description||'Variation')}</span>
        <span class="pos-val accent" style="font-size:11px">+ ${fmtAED(parseFloat(v.value_aed)||0)}</span>
      </div>`).join('')}
      <div class="pos-row">
        <span class="pos-label" style="font-weight:700">Total Approved Variations</span>
        <span class="pos-val accent">+ ${fmtAED(approvedVOsTotal)}</span>
      </div>
      <div class="pos-row">
        <span class="pos-label" style="font-weight:700;color:var(--tx)">Adjusted Contract Value</span>
        <span class="pos-val" style="font-size:13px">${fmtAED(adjustedContract)}</span>
      </div>` : ''}
      <div class="pos-divider"></div>
      <div class="pos-row">
        <span class="pos-label">Certified To Date (this PC)</span>
        <span class="pos-val green">${fmtAED(certified)}<span class="pos-pct">${adjustedContract > 0 ? ((certified/adjustedContract)*100).toFixed(1)+'%' : ''}</span></span>
      </div>
      ${adjustedContract > 0 ? `
      <div class="pos-row">
        <span class="pos-label">Remaining Contract</span>
        <span class="pos-val ${adjustedContract - certified < 0 ? 'red' : ''}">${fmtAED(adjustedContract - certified)}</span>
      </div>` : ''}
      ${retHeldTotal > 0 || (parseFloat(selectedScope.advance_amount_aed)||0) > 0 ? `<div class="pos-divider"></div>` : ''}
      ${retHeldTotal > 0 ? `
      <div class="pos-row">
        <span class="pos-label">Retention Held to Date</span>
        <span class="pos-val amber">${fmtAED(retHeldTotal)}</span>
      </div>` : ''}
      ${(parseFloat(selectedScope.advance_amount_aed)||0) > 0 ? `
      <div class="pos-row">
        <span class="pos-label">Advance Recovered to Date</span>
        <span class="pos-val">${fmtAED(advRecTotal)} <span class="pos-pct">of ${fmtAED(parseFloat(selectedScope.advance_amount_aed))}</span></span>
      </div>
      <div class="pos-row">
        <span class="pos-label">Advance Balance Outstanding</span>
        <span class="pos-val ${advanceBalance > 0 ? 'amber' : 'green'}">${fmtAED(advanceBalance)}</span>
      </div>` : ''}
    </div>` : ''}

    <!-- Pending VOs notice -->
    ${(()=>{ const pvos=scopeVariations.filter(v=>v.status==='pending'); if(!pvos.length) return '';
      const tot=pvos.reduce((a,v)=>a+(parseFloat(v.value_aed)||0),0);
      return `<div class="warn-strip" style="margin-bottom:16px">⏳ ${pvos.length} pending variation order${pvos.length!==1?'s':''} totalling ${fmtAED(tot)} — not yet approved, not included in contract value.
        ${pvos.map(v=>`<div style="font-size:11px;margin-top:3px;padding-left:10px;color:var(--amber)">· ${escH(v.vo_ref||'VO')} ${escH(v.description||'')} — ${fmtAED(parseFloat(v.value_aed)||0)}</div>`).join('')}
      </div>`; })()}

    <!-- Signature Block -->
    <div class="sig-block">
      <div class="sig-block-title">
        <span>Signatures</span>
        ${canEditSigs ? `<button class="btn btn-ghost btn-sm" onclick="openPcSigs()">✍ Edit</button>` : ''}
      </div>
      <div class="sig-grid">${sigItems || '<div style="color:var(--tx3);font-size:12px">No signatories configured. Click Edit to add.</div>'}</div>
    </div>
  `;

}

// ── Combined certificate for a PC that spans multiple scopes ──
function renderPaymentSummaryMulti() {
  const sections = pcSections.map(s => ctxSection(s.ctx));
  // qty_contracted is the TOTAL across all cluster scopes for the same sub — deduplicate
  // by villa type label so 50×rate is counted once, not once-per-scope.
  const mergedTypes = {};
  sections.forEach(sec => {
    sec.entries.forEach(t => { if (!mergedTypes[t.type.villa_type_label]) mergedTypes[t.type.villa_type_label] = t; });
  });
  const totSubcon = Object.values(mergedTypes).reduce((a,t)=>a+t.qty*t.rate, 0);
  const combPrev  = sections.reduce((a,s)=>a+s.subPrev,0);
  const combCur   = sections.reduce((a,s)=>a+s.subCur,0);
  const combTod   = sections.reduce((a,s)=>a+s.subTod,0);
  const combVOs   = sections.reduce((a,s)=>a+s.approvedVOs,0);
  lastGrossAed = combTod;

  // Advance recovery: each scope's own % applied to its section, then summed
  let advTod = 0, advPrev = 0, anyAdv = false;
  pcSections.forEach((s,i) => {
    const ap = parseFloat(s.scope.advance_recovery_pct)||0;
    if (ap>0 || (parseFloat(s.scope.advance_amount_aed)||0)>0) anyAdv = true;
    advTod  += sections[i].subTod * ap;
    advPrev += sections[i].subPrev * ap;
  });
  lastAdvAed = advTod;

  // Retention is PC-level: per-PC % override, else the primary scope's rate
  const scopeRetPct = parseFloat(selectedScope.retention_pct)||0;
  const retOvr = (selectedPC.retention_pct_override==null||selectedPC.retention_pct_override==='') ? null : parseFloat(selectedPC.retention_pct_override);
  const effRetPct = retOvr!==null ? retOvr : scopeRetPct;
  const retTod  = selectedPC.retention_applicable ? Math.max(0,(combTod-advTod)*effRetPct) : 0;
  const retPrev = selectedPC.retention_applicable ? Math.max(0,(combPrev-advPrev)*effRetPct) : 0;

  const ded = parseFloat(selectedPC.deduction_aed)||0;
  const vr  = parseFloat(selectedPC.vat_rate)||0.05;
  const certTod  = combTod - advTod - ded - retTod;
  const certPrev = combPrev - advPrev - ded - retPrev;
  const vatTod = certTod*vr, vatPrev = certPrev*vr;
  const netTod = certTod+vatTod, netPrev = certPrev+vatPrev;

  // Current period calculations (combined)
  const advCur  = advTod - advPrev;
  const retCur  = selectedPC.retention_applicable ? Math.max(0, retTod - retPrev) : 0;
  const certCur = certTod - certPrev;
  const vatCur  = vatTod - vatPrev;
  const netCur  = netTod - netPrev;

  const isLocked = selectedPC.status === 'locked';
  const canEditFin = !isLocked || canAdmin;
  const canEditSigs = canManage || canAdmin;
  const finInputAttr = canEditFin ? '' : 'disabled';
  const retCheck = selectedPC.retention_applicable ? 'checked' : '';

  let bodyRows = '';
  sections.forEach((sec, si) => {
    const sc = sec.scope;
    const label = (sc.sca_ref ? escH(sc.sca_ref)+': ' : '') + escH(sc.scope_title || sc.subcontractor_name || ('Scope '+(si+1)));
    bodyRows += `<tr class="section-row"><td class="center">${si+1}</td><td colspan="14">${label}</td></tr>`;
    sec.entries.forEach(t => {
      // Per cluster/scope: show detected villas in this scope (not total qty_contracted)
      const dq = t.detectedQty;
      bodyRows += `<tr>
        <td class="center"></td><td>${escH(t.type.villa_type_label)}</td><td class="center">${escH(t.type.unit||'Villa')}</td>
        <td class="center">${dq}</td><td class="right">${fmtAED(t.rate)}</td><td class="right bold">${fmtAED(dq*t.rate)}</td>
        <td class="center">${fmtQty(t.prev)}</td><td class="center">${fmtQty(t.current)}</td><td class="center bold">${fmtQty(t.toDate)}</td>
        <td class="center">${fmtPct(t.prev/Math.max(dq,1))}</td><td class="right">${fmtAED(t.prev*t.rate)}</td>
        <td class="center">${fmtPct(t.current/Math.max(dq,1))}</td><td class="right">${fmtAED(t.current*t.rate)}</td>
        <td class="center bold">${fmtPct(t.toDate/Math.max(dq,1))}</td><td class="right bold">${fmtAED(t.toDate*t.rate)}</td>
      </tr>`;
    });
    const sQty = sec.entries.reduce((a,t)=>a+t.detectedQty,0);
    const sContract = sec.entries.reduce((a,t)=>a+t.detectedQty*t.rate,0);
    bodyRows += `<tr class="total-row">
      <td colspan="2" class="bold">SUB TOTAL</td><td></td><td class="center bold">${sQty}</td><td></td>
      <td class="right bold">${fmtAED(sContract)}</td><td></td><td></td><td></td>
      <td></td><td class="right">${fmtAED(sec.subPrev)}</td><td></td><td class="right">${fmtAED(sec.subCur)}</td>
      <td></td><td class="right bold">${fmtAED(sec.subTod)}</td>
    </tr>`;
  });
  // GROSS TOTAL uses total qty_contracted (deduped across sibling scopes)
  const grossTotQty = Object.values(mergedTypes).reduce((a,t)=>a+t.qty, 0);
  bodyRows += `<tr class="total-row" style="border-top:3px double var(--bdr2)">
    <td colspan="2" class="bold gold">GROSS TOTAL</td><td></td><td class="center bold">${grossTotQty}</td><td></td>
    <td class="right bold">${fmtAED(totSubcon)}</td><td></td><td></td><td></td>
    <td></td><td class="right bold">${fmtAED(combPrev)}</td><td></td><td class="right bold">${fmtAED(combCur)}</td>
    <td></td><td class="right bold gold">${fmtAED(combTod)}</td>
  </tr>`;

  const sigItems = pcSigsList.map(s => `
    <div class="sig-item"><div class="sig-position">${escH(s.position_title)}</div><div class="sig-line"></div><div class="sig-name">${escH(s.full_name)}</div><div class="sig-company">${escH(s.company||'')}</div></div>`).join('');

  document.getElementById('psum-inner').innerHTML = `
    <div class="psum-actions">
      <button class="btn btn-primary btn-sm" onclick="printCertificate()">🖨 Print Certificate</button>
      <button class="btn btn-ghost btn-sm" onclick="printProgressSheet()">📋 Print Progress Sheet</button>
      <button class="btn btn-ghost btn-sm" onclick="exportSummaryExcel()">⬇ Summary (Excel)</button>
      <button class="btn btn-ghost btn-sm" onclick="exportProgressExcel()">⬇ Progress (Excel)</button>
      ${canEditSigs ? `<button class="btn btn-ghost btn-sm" onclick="openPcSigs()">✍ Edit Signatories</button>` : ''}
    </div>
    <div class="warn-strip" style="margin-bottom:12px">📑 Combined certificate — <strong>${sections.length} scopes</strong> merged. Each scope keeps its own rate table; totals merge below.</div>
    <div class="psum-section-title">Subcontractor Interim Payment Summary</div>
    <table class="psum-table">
      <thead>
        <tr>
          <th rowspan="2">Item</th><th rowspan="2">Description</th><th rowspan="2">Unit</th>
          <th rowspan="2">QTY (No)</th><th rowspan="2">Rate (AED)</th><th rowspan="2">Subcontract Amount (AED)</th>
          <th colspan="3">Progress QTY</th><th colspan="6">Amount (AED)</th>
        </tr>
        <tr><th>Prev</th><th>Current</th><th>To Date</th><th>% Prev</th><th>Prev</th><th>% Cur</th><th>Current</th><th>% ToDate</th><th>To Date</th></tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>

    <div class="psum-section-title">Financial Summary (Combined)</div>
    <div class="fin-block">
      <div class="fin-row">
        <span class="fin-label">Gross Total</span>
        <div class="fin-vals"><span class="fin-val prev">${fmtAED(combPrev)}</span><span class="fin-val cur">${fmtAED(combCur)}</span><span class="fin-val total">${fmtAED(combTod)}</span></div>
      </div>
      ${anyAdv ? `
      <div class="fin-row">
        <div class="fin-row-label-group"><span class="fin-label">Advance Recovery</span><span class="fin-auto-hint">auto · per scope</span></div>
        <div class="fin-vals"><span class="fin-val prev">${fmtAED(advPrev)}</span><span class="fin-val cur">${fmtAED(advCur)}</span><span class="fin-val total">${fmtAED(advTod)}</span></div>
      </div>` : ''}
      <div class="fin-row">
        <div class="fin-row-label-group"><span class="fin-label">Deductions</span>
          ${canEditFin ? `<input class="fin-input" id="fin-ded" type="number" value="${ded}" min="0" onchange="saveFinancials()" ${finInputAttr}>` : `<span class="fin-val">${fmtAED(ded)}</span>`}
        </div>
        <div class="fin-vals"><span class="fin-val prev">—</span><span class="fin-val cur">${ded > 0 ? fmtAED(ded) : '—'}</span><span class="fin-val total">${fmtAED(ded)}</span></div>
      </div>
      <div class="fin-row">
        <div class="fin-row-label-group">
          <label class="fin-toggle"><input type="checkbox" id="fin-ret-toggle" ${retCheck} onchange="saveFinancials()" ${canEditFin?'':'disabled'}> Retention${effRetPct>0?` (${(effRetPct*100).toFixed(1)}%)`:''}</label>
          ${canEditFin ? `<span style="display:inline-flex;align-items:center;gap:4px"><input class="fin-input" id="fin-ret" type="number" value="${retOvr!==null?+(retOvr*100).toFixed(4):''}" min="0" max="100" step="0.1" placeholder="${(scopeRetPct*100).toFixed(1)}" ${retCheck?'':'disabled'} onchange="saveFinancials()" title="Retention rate (%) — blank uses the primary scope default"><span style="color:var(--tx3);font-size:12px">%</span></span>` : `<span class="fin-val">${fmtAED(retTod)}</span>`}
        </div>
        <div class="fin-vals"><span class="fin-val prev">${fmtAED(retPrev)}</span><span class="fin-val cur">${selectedPC.retention_applicable ? fmtAED(retCur) : '—'}</span><span class="fin-val total">${selectedPC.retention_applicable?fmtAED(retTod):'Not Applicable'}</span></div>
      </div>
      <div class="fin-row" style="border-top:2px solid var(--bdr2)">
        <span class="fin-label">Total Certified Amount</span>
        <div class="fin-vals"><span class="fin-val prev">${fmtAED(certPrev)}</span><span class="fin-val cur">${fmtAED(certCur)}</span><span class="fin-val total">${fmtAED(certTod)}</span></div>
      </div>
      <div class="fin-row">
        <div class="fin-row-label-group"><span class="fin-label">VAT</span>
          ${canEditFin ? `<input class="fin-input" id="fin-vat" type="number" value="${(vr*100).toFixed(1)}" min="0" max="100" step="0.1" onchange="saveFinancials()" ${finInputAttr}> %` : `<span class="fin-val">${(vr*100).toFixed(1)}%</span>`}
        </div>
        <div class="fin-vals"><span class="fin-val prev">${fmtAED(vatPrev)}</span><span class="fin-val cur">${fmtAED(vatCur)}</span><span class="fin-val total">${fmtAED(vatTod)}</span></div>
      </div>
      <div class="fin-row" style="border-top:2px solid var(--bdr2)">
        <span class="fin-label" style="font-size:13px;color:var(--gold)">Net Total</span>
        <div class="fin-vals"><span class="fin-val prev grand">${fmtAED(netPrev)}</span><span class="fin-val cur grand">${fmtAED(netCur)}</span><span class="fin-val total grand">${fmtAED(netTod)}</span></div>
      </div>
    </div>

    ${(totSubcon>0||combVOs>0) ? `
    <div class="psum-section-title">Contract Position (Combined)</div>
    <div class="pos-block">
      <div class="pos-row"><span class="pos-label">Original Contract Value (all scopes)</span><span class="pos-val">${fmtAED(totSubcon)}</span></div>
      ${combVOs>0?`<div class="pos-row"><span class="pos-label" style="font-weight:700">Approved Variations</span><span class="pos-val accent">+ ${fmtAED(combVOs)}</span></div>
      <div class="pos-row"><span class="pos-label" style="font-weight:700;color:var(--tx)">Adjusted Contract Value</span><span class="pos-val" style="font-size:13px">${fmtAED(totSubcon+combVOs)}</span></div>`:''}
      <div class="pos-divider"></div>
      <div class="pos-row"><span class="pos-label">Certified To Date (this PC)</span><span class="pos-val green">${fmtAED(certTod)}</span></div>
    </div>` : ''}

    <div class="sig-block">
      <div class="sig-block-title"><span>Signatures</span>${canEditSigs ? `<button class="btn btn-ghost btn-sm" onclick="openPcSigs()">✍ Edit</button>` : ''}</div>
      <div class="sig-grid">${sigItems || '<div style="color:var(--tx3);font-size:12px">No signatories configured. Click Edit to add.</div>'}</div>
    </div>
  `;

}

async function saveFinancials() {
  if (!selectedPC) return;
  // Sync the retention input's disabled state immediately so UI feels responsive
  const retToggle = document.getElementById('fin-ret-toggle');
  const retInput  = document.getElementById('fin-ret');
  if (retToggle && retInput) retInput.disabled = !retToggle.checked;

  const adv  = (isMultiPC && pcSections.length>1)
    ? (parseFloat(lastAdvAed)||0)
    : (parseFloat(document.getElementById('fin-adv')?.value)||0);
  const ded  = parseFloat(document.getElementById('fin-ded')?.value)||0;
  const retT = retToggle?.checked || false;
  const vatPct = parseFloat(document.getElementById('fin-vat')?.value)||5;
  // Retention is entered as a PERCENTAGE; blank = use the scope's default rate.
  const retRaw = retInput?.value;
  const scopeRetPct = parseFloat(selectedScope.retention_pct)||0;
  let retOverride = null, effRetPct = scopeRetPct;
  if (retRaw !== '' && retRaw != null) { effRetPct = (parseFloat(retRaw)||0)/100; retOverride = effRetPct; }
  const grossNow = parseFloat(lastGrossAed)||0;
  const ret = retT ? Math.max(0, (grossNow - adv) * effRetPct) : 0;
  try {
    await fpatch(`qs_payment_certificates?id=eq.${selectedPC.id}`, {
      advance_recovery_aed: adv, deduction_aed: ded,
      retention_applicable: retT, retention_pct_override: retOverride, retention_aed: ret, vat_rate: vatPct/100
    });
    audit('qs_payment_certificates', 'UPDATE_FINANCIALS', selectedPC.id, {
      scope: selectedScope.subcontractor_name, pc_number: selectedPC.pc_number,
      advance_recovery_aed: adv, deduction_aed: ded,
      retention_applicable: retT, retention_pct_override: retOverride, retention_aed: ret, vat_rate: vatPct/100
    });
    selectedPC.advance_recovery_aed = adv;
    selectedPC.deduction_aed = ded;
    selectedPC.retention_applicable = retT;
    selectedPC.retention_pct_override = retOverride;
    selectedPC.retention_aed = ret;
    selectedPC.vat_rate = vatPct/100;
    const idx = allScopePCs.findIndex(p => p.id === selectedPC.id);
    if (idx >= 0) Object.assign(allScopePCs[idx], selectedPC);
    renderPaymentSummary();
  } catch(e) {
    alert('Failed to save financials: ' + e.message + '\nCheck your connection and try again.');
  }
}

function resetAdvAuto() {
  const el = document.getElementById('fin-adv');
  if (el) { el.value = ''; saveFinancials(); }
}
function resetRetAuto() {
  const el = document.getElementById('fin-ret');
  if (el) { el.value = ''; saveFinancials(); }
}

// ══════════════════════════════════════════════
// TABS
// ══════════════════════════════════════════════
function switchTab(t) {
  document.querySelectorAll('.qs-tab').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.qs-tab-content').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-'+t).classList.add('active');
  document.getElementById('tc-'+t).classList.add('active');
}
function showTab(t) { switchTab(t); }

function switchCfgTab(t) {
  cfgTab = t;
  ['types','acts','villas','sigs','contract'].forEach(k => {
    document.getElementById('cfg-tab-'+k).classList.toggle('active', k===t);
    document.getElementById('cfg-panel-'+k).style.display = k===t ? '' : 'none';
  });
  // Detected Villas is read-only — hide Save button; also lazy-render when switching to it
  const saveBtn = document.getElementById('cfg-save-btn');
  if (saveBtn) saveBtn.style.display = t === 'villas' ? 'none' : '';
  if (t === 'villas') renderDetectedVillas();
}

// ══════════════════════════════════════════════
// OVERRIDE MODAL
// ══════════════════════════════════════════════
function openOverride(villa_id, activity_code, villa_no, act_name) {
  if (!canManage && !canAdmin) return;
  ovPending = { villa_id: parseInt(villa_id), activity_code, villa_no, act_name };
  const key = villa_id + ':' + activity_code;
  const billed = billedRecords[key];
  const ovExisting = pcOverrides[key];
  const wir = wirData[key];

  document.getElementById('ov-info').innerHTML = `
    <b>Villa:</b> VI-${escH(villa_no)} &nbsp;|&nbsp; <b>Activity:</b> ${escH(activity_code)} — ${escH(act_name)}<br>
    <b>WIR Status:</b> ${wir?.approved ? '✓ Approved' : '— Not approved'}<br>
    ${ovExisting ? `<b>Current Override:</b> ${ovExisting.is_complete ? '✓ Override: Complete' : '✗ Override: Not Complete'} — ${escH(ovExisting.override_reason||'')}` : '<b>Current Override:</b> None (using WIR data)'}`;

  document.getElementById('ov-warn').style.display = billed ? '' : 'none';
  document.getElementById('ov-complete').value = ovExisting ? (ovExisting.is_complete ? '1' : '0') : 'wir';
  document.getElementById('ov-reason').value = '';
  document.getElementById('ov-msg').className = 'form-msg';
  document.getElementById('modal-override').style.display = 'flex';
}

async function submitOverride() {
  if (!ovPending) return;
  const val = document.getElementById('ov-complete').value;
  const reason = document.getElementById('ov-reason').value.trim();
  const msg = document.getElementById('ov-msg');

  if (val !== 'wir' && !reason) { showMsg(msg, 'err', 'Reason is required for an override.'); return; }

  const key = ovPending.villa_id + ':' + ovPending.activity_code;
  try {
    if (val === 'wir') {
      // Remove override
      await fdel(`qs_pc_overrides?pc_id=eq.${selectedPC.id}&villa_id=eq.${ovPending.villa_id}&activity_code=eq.${ovPending.activity_code}`);
      audit('qs_pc_overrides', 'REMOVE_OVERRIDE', selectedPC.id, null, { villa_no: ovPending.villa_no, activity_code: ovPending.activity_code, pc_number: selectedPC.pc_number, scope: selectedScope.subcontractor_name });
      delete pcOverrides[key];
    } else {
      const isComplete = val === '1';
      const body = { pc_id: selectedPC.id, villa_id: ovPending.villa_id, activity_code: ovPending.activity_code, is_complete: isComplete, override_reason: reason, created_by: currentUser?.full_name || '' };
      const existing = pcOverrides[key];
      if (existing) {
        await fpatch(`qs_pc_overrides?pc_id=eq.${selectedPC.id}&villa_id=eq.${ovPending.villa_id}&activity_code=eq.${ovPending.activity_code}`, { is_complete: isComplete, override_reason: reason });
      } else {
        await fp('qs_pc_overrides', body);
      }
      audit('qs_pc_overrides', existing ? 'UPDATE_OVERRIDE' : 'CREATE_OVERRIDE', selectedPC.id, { villa_no: ovPending.villa_no, activity_code: ovPending.activity_code, is_complete: isComplete, reason, pc_number: selectedPC.pc_number, scope: selectedScope.subcontractor_name });
      pcOverrides[key] = { villa_id: ovPending.villa_id, activity_code: ovPending.activity_code, is_complete: isComplete, override_reason: reason };
    }
    closeModal('modal-override');
    renderProgressSheet();
    renderPaymentSummary();
  } catch(e) { showMsg(msg, 'err', 'Save failed: ' + e.message); }
}

// ══════════════════════════════════════════════
// PC STATUS ACTIONS
// ══════════════════════════════════════════════
async function submitPC() {
  if (!selectedPC || selectedPC.status !== 'draft') return;
  await fpatch(`qs_payment_certificates?id=eq.${selectedPC.id}`, { status:'submitted', submitted_at: new Date().toISOString() });
  audit('qs_payment_certificates', 'SUBMIT_PC', selectedPC.id, { scope: selectedScope.subcontractor_name, pc_number: selectedPC.pc_number, period_label: selectedPC.period_label });
  selectedPC.status = 'submitted';
  await loadPCs();
  await loadPCData();
}

// Billable items across all scopes in the PC (or the single scope)
function collectBillableItems() {
  const items = [];
  if (isMultiPC && pcSections.length > 1) {
    pcSections.forEach(s => {
      s.ctx.villas.forEach(sv => {
        s.ctx.activities.forEach(act => {
          const st = ctxActStatus(s.ctx, sv.villa_id, act.activity_code);
          if (st.isCompleteToDate && !st.wasBilledPrev)
            items.push({ scope_id: s.scope.id, villa_id: sv.villa_id, activity_code: act.activity_code, villa_no: sv.villa_no });
        });
      });
    });
  } else {
    scopeVillas.forEach(sv => {
      scopeActivities.forEach(act => {
        const st = getActivityStatus(sv.villa_id, act.activity_code);
        if (st.isCompleteToDate && !st.wasBilledPrev)
          items.push({ scope_id: selectedScope.id, villa_id: sv.villa_id, activity_code: act.activity_code, villa_no: sv.villa_no });
      });
    });
  }
  return items;
}

async function openLock() {
  if (!selectedPC) return;

  // ── Validation gate ──────────────────────────────────────────────────
  const errors = [], warnings = [];
  const multi = isMultiPC && pcSections.length > 1;
  const anyVillas = multi ? pcSections.some(s => s.ctx.villas.length) : scopeVillas.length;
  const anyActs   = multi ? pcSections.some(s => s.ctx.activities.length) : scopeActivities.length;

  if (!selectedPC.period_label?.trim())
    errors.push('Period label is not set — edit the PC to add one before locking.');
  if (!anyVillas)
    errors.push('No villas are configured for the scope(s) in this PC.');
  if (!anyActs)
    errors.push('No activities are configured for the scope(s) in this PC.');
  if (!pcSigsList.length)
    warnings.push('No signatories are configured on this PC.');
  else if (pcSigsList.some(s => !s.full_name?.trim()))
    warnings.push('One or more signatories have no name filled in.');

  if (errors.length) {
    // Surface blocking errors near the lock button without opening the modal
    const strip = document.getElementById('ps-status-strip');
    document.getElementById('lock-validation-msg')?.remove();
    const div = Object.assign(document.createElement('div'), {
      id: 'lock-validation-msg',
      className: 'warn-strip',
      innerHTML: errors.map(e => `<div>❌ ${e}</div>`).join('')
    });
    div.style.marginTop = '8px';
    strip.appendChild(div);
    setTimeout(() => div.remove(), 7000);
    return;
  }
  document.getElementById('lock-validation-msg')?.remove();

  // ── Build billing summary (across every scope in this PC) ─────────────
  const billItems = collectBillableItems();
  const count = billItems.length;
  const summary = billItems.map(it => `<div>VI-${escH(it.villa_no)} · ${escH(it.activity_code)}</div>`).join('');

  if (!count) warnings.push('No new billable items in this PC — it will be locked with zero new records.');

  const warnHtml = warnings.length
    ? `<div class="warn-strip" style="margin-bottom:8px">${warnings.map(w=>`<div>⚠ ${w}</div>`).join('')}</div>`
    : '';

  document.getElementById('lock-summary-list').innerHTML = warnHtml + (count
    ? `<div style="margin-bottom:4px;font-weight:700;color:var(--tx)">${count} new billing record${count!==1?'s':''} will be created:</div>${summary}`
    : '<div style="color:var(--tx3)">No new billable items in this PC.</div>');
  document.getElementById('lock-msg').className = 'form-msg';
  document.getElementById('modal-lock').style.display = 'flex';
}

async function confirmLock() {
  const msg = document.getElementById('lock-msg');
  try {
    // 1. Write billed records for every scope in the PC (ON CONFLICT DO NOTHING)
    const newBilledItems = collectBillableItems().map(it => ({ scope_id: it.scope_id, villa_id: it.villa_id, activity_code: it.activity_code, locked_pc_id: selectedPC.id }));
    if (newBilledItems.length) {
      await fetch(`${SB}/rest/v1/qs_billed_records?on_conflict=scope_id,villa_id,activity_code`, {
        method:'POST',
        headers: getH({'Prefer':'resolution=ignore-duplicates,return=minimal'}),
        body: JSON.stringify(newBilledItems)
      });
    }
    // 2. Update PC status (store combined gross_aed for reporting)
    await fpatch(`qs_payment_certificates?id=eq.${selectedPC.id}`, { status:'locked', locked_at: new Date().toISOString(), gross_aed: lastGrossAed });

    // 2b. Per-scope locked snapshots → correct dashboard roll-up of combined PCs
    const effRetPct = (selectedPC.retention_pct_override!=null && selectedPC.retention_pct_override!=='')
      ? parseFloat(selectedPC.retention_pct_override)
      : (parseFloat(selectedScope.retention_pct)||0);
    let snaps;
    if (isMultiPC && pcSections.length > 1) {
      snaps = pcSections.map(sObj => {
        const sec = ctxSection(sObj.ctx);
        const adv = sec.subTod * (parseFloat(sObj.scope.advance_recovery_pct)||0);
        const ret = selectedPC.retention_applicable ? Math.max(0, (sec.subTod - adv) * effRetPct) : 0;
        return { scope_id: sObj.scope.id, gross_aed: sec.subTod, retention_aed: ret, advance_recovery_aed: adv };
      });
    } else {
      snaps = [{ scope_id: selectedScope.id, gross_aed: parseFloat(lastGrossAed)||0, retention_aed: parseFloat(selectedPC.retention_aed)||0, advance_recovery_aed: parseFloat(selectedPC.advance_recovery_aed)||0 }];
    }
    for (const sn of snaps) {
      await fpatch(`qs_pc_scopes?pc_id=eq.${selectedPC.id}&scope_id=eq.${sn.scope_id}`, { gross_aed: sn.gross_aed, retention_aed: sn.retention_aed, advance_recovery_aed: sn.advance_recovery_aed });
    }
    audit('qs_payment_certificates', 'LOCK_PC', selectedPC.id, { scope: selectedScope.subcontractor_name, pc_number: selectedPC.pc_number, period_label: selectedPC.period_label, billed_count: newBilledItems.length });
    notifyTelegram('PC_LOCKED', { scope: selectedScope.subcontractor_name, pcNumber: selectedPC.pc_number, period: selectedPC.period_label, grossAed: lastGrossAed });
    selectedPC.status = 'locked';
    closeModal('modal-lock');
    await loadPCs();
    await loadPCData();
  } catch(e) { showMsg(msg, 'err', 'Lock failed: ' + e.message); }
}

// ══════════════════════════════════════════════
// REOPEN LOCKED PC
// ══════════════════════════════════════════════
function openReopen() {
  if (!selectedPC || selectedPC.status !== 'locked') return;
  document.getElementById('reopen-pc-num').textContent = selectedPC.pc_number;
  document.getElementById('reopen-reason').value = '';
  document.getElementById('reopen-msg').className = 'form-msg';
  document.getElementById('modal-reopen').style.display = 'flex';
}

async function confirmReopen() {
  const reason = document.getElementById('reopen-reason').value.trim();
  const msg    = document.getElementById('reopen-msg');
  if (!reason) { showMsg(msg, 'err', 'Please enter a reason for reopening.'); return; }
  try {
    // 1. Remove billed records created by this lock
    await fetch(`${SB}/rest/v1/qs_billed_records?locked_pc_id=eq.${selectedPC.id}`, {
      method: 'DELETE', headers: getH()
    });
    // 2. Reset PC to draft, clear locked snapshot fields
    await fpatch(`qs_payment_certificates?id=eq.${selectedPC.id}`, {
      status: 'draft', gross_aed: null, locked_at: null
    });
    audit('qs_payment_certificates', 'REOPEN_PC', selectedPC.id, {
      scope: selectedScope.subcontractor_name,
      pc_number: selectedPC.pc_number,
      reason
    });
    selectedPC.status = 'draft';
    closeModal('modal-reopen');
    await loadPCs();
    await loadPCData();
  } catch(e) { showMsg(msg, 'err', 'Reopen failed: ' + e.message); }
}

// ══════════════════════════════════════════════
// NEW SCOPE
// ══════════════════════════════════════════════
async function _loadSubsList() {
  // Load from the pre-deduped subcontractors table (58 entries), then resolve each name
  // through a case-insensitive alias map so aliases collapse to their canonical names.
  try {
    const [aliasRows, subRows] = await Promise.all([
      fa('subcontractor_aliases?select=alias,canonical_name'),
      fa('subcontractors?select=name&order=name.asc')
    ]);
    // Case-insensitive alias map: alias.toLowerCase() → canonical display name
    const aliasMap = {};
    aliasRows.forEach(r => { if (r.alias && r.canonical_name) aliasMap[r.alias.trim().toLowerCase()] = r.canonical_name.trim(); });
    const canon = s => { const t = String(s || '').trim(); return aliasMap[t.toLowerCase()] || t; };
    const seen = new Set();
    const names = [];
    const addName = n => { n = String(n || '').trim(); if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); names.push(n); } };
    subRows.forEach(r => addName(canon(r.name)));
    // Also add canonical names from the alias table — user-chosen canonicals may not exist
    // in the subcontractors table (e.g. chosen as a display name, never a raw WIR entry).
    aliasRows.forEach(r => { if (r.canonical_name) addName(r.canonical_name.trim()); });
    names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    subcontractorsList = names.map((n, i) => ({ id: -(i + 1), name: n }));
  } catch(e) {
    subcontractorsList = [];
  }
}

async function openNewScope(prefillSub) {
  await _loadSubsList();
  editScopeMode = false;
  document.getElementById('ns-modal-title').textContent = prefillSub ? ('Add Scope · ' + prefillSub) : 'New Subcontractor Scope';
  document.getElementById('ns-submit-btn').textContent = 'Create Scope';
  document.getElementById('ns-sub-search').value = prefillSub || '';
  document.getElementById('ns-sub-dropdown').style.display = 'none';
  document.getElementById('ns-display-name').value = '';
  document.getElementById('ns-scope').value = '';
  document.getElementById('ns-sca').value = '';
  document.getElementById('ns-package').value = '';
  document.getElementById('ns-msg').className = 'form-msg';
  document.getElementById('modal-new-scope').style.display = 'flex';
  setTimeout(() => {
    if (prefillSub) {
      document.getElementById('ns-scope').focus(); // subcontractor already chosen → go to Scope of Works
    } else {
      document.getElementById('ns-sub-search').focus();
      filterSubOptions(); // explicitly show full list on open
    }
  }, 80);
}

async function openEditScope() {
  if (!canAdmin) return;
  await _loadSubsList();
  editScopeMode = true;
  document.getElementById('ns-modal-title').textContent = 'Edit Scope';
  document.getElementById('ns-submit-btn').textContent = 'Save Changes';
  document.getElementById('ns-sub-search').value = selectedScope.subcontractor_name || '';
  document.getElementById('ns-sub-dropdown').style.display = 'none';
  document.getElementById('ns-display-name').value = selectedScope.display_name || '';
  document.getElementById('ns-scope').value = selectedScope.scope_title || '';
  document.getElementById('ns-sca').value = selectedScope.sca_ref || '';
  document.getElementById('ns-package').value = selectedScope.package || '';
  document.getElementById('ns-msg').className = 'form-msg';
  document.getElementById('modal-new-scope').style.display = 'flex';
}

function filterSubOptions() {
  const q = (document.getElementById('ns-sub-search').value || '').toLowerCase().trim();
  const dd = document.getElementById('ns-sub-dropdown');
  if (!subcontractorsList.length) {
    dd.innerHTML = `<div style="padding:8px 14px;font-size:12px;color:var(--tx3)">No subcontractors loaded — type the name directly and it will be saved as entered.</div>`;
    dd.style.display = '';
    return;
  }
  const matches = subcontractorsList.filter(s => !q || s.name.toLowerCase().includes(q)).slice(0, 40);
  if (!matches.length) {
    dd.innerHTML = `<div style="padding:8px 12px;font-size:12px;color:var(--tx3)">No match — name will be used as typed</div>`;
    dd.style.display = '';
    return;
  }
  dd.innerHTML = matches.map(s =>
    `<div style="padding:8px 14px;cursor:pointer;font-size:13px;color:var(--tx);border-bottom:1px solid var(--bdr)"
          onmousedown="selectSubcontractor('${escH(s.name).replace(/'/g,"\\'")}');"
          onmouseover="this.style.background='var(--bg4)'" onmouseout="this.style.background=''">
       ${escH(s.name)}
     </div>`
  ).join('');
  dd.style.display = '';
}

function selectSubcontractor(name) {
  document.getElementById('ns-sub-search').value = name;
  document.getElementById('ns-sub-dropdown').style.display = 'none';
}

async function submitScope() {
  const name = (document.getElementById('ns-sub-search').value || '').trim();
  const scope = (document.getElementById('ns-scope').value || '').trim();
  const msg = document.getElementById('ns-msg');
  if (!name) { showMsg(msg,'err','Subcontractor name is required.'); return; }
  if (!scope) { showMsg(msg,'err','Scope of Works is required.'); return; }
  const displayName = (document.getElementById('ns-display-name').value || '').trim();
  const body = {
    subcontractor_name: name,
    display_name: displayName || null,
    project: (document.getElementById('ns-project').value || '').trim() || 'RA4104- BAGHAIYLUM VILLAS DEVELOPMENT',
    scope_title: scope,
    sca_ref: (document.getElementById('ns-sca').value || '').trim(),
    package: (document.getElementById('ns-package').value || '').trim(),
  };
  const saveBtn = document.getElementById('ns-submit-btn');
  if (saveBtn) saveBtn.disabled = true;

  if (editScopeMode) {
    // ── EDIT existing scope ──
    const _oldScopeData = { subcontractor_name: selectedScope.subcontractor_name, scope_title: selectedScope.scope_title, sca_ref: selectedScope.sca_ref, package: selectedScope.package };
    const res = await fpatch(`qs_scopes?id=eq.${selectedScope.id}`, body);
    if (saveBtn) saveBtn.disabled = false;
    if (Array.isArray(res) && res.length > 0) {
      audit('qs_scopes', 'UPDATE_SCOPE', selectedScope.id, body, _oldScopeData);
      closeModal('modal-new-scope');
      // Update local state + header immediately
      Object.assign(selectedScope, body);
      document.getElementById('sh-title').textContent = selectedScope.subcontractor_name;
      document.getElementById('sh-sub').textContent = selectedScope.scope_title || '';
      document.getElementById('sh-meta').textContent = [selectedScope.sca_ref, selectedScope.package].filter(Boolean).join(' · ');
      await loadScopes(); // refresh sidebar list
    } else {
      const detail = (Array.isArray(res) && !res.length) ? 'No rows updated — check permissions.' : (res?.message || res?.hint || JSON.stringify(res));
      showMsg(msg, 'err', 'Save failed: ' + (detail || 'unknown error'));
    }
  } else {
    // ── CREATE new scope ──
    const res = await fp('qs_scopes', body);
    if (saveBtn) saveBtn.disabled = false;
    if (res?.id) {
      audit('qs_scopes', 'CREATE_SCOPE', res.id, { subcontractor_name: body.subcontractor_name, scope_title: body.scope_title, sca_ref: body.sca_ref, package: body.package });
      notifyTelegram('SCOPE_CREATED', { subcontractor: body.subcontractor_name, scopeTitle: body.scope_title, contractValue: parseFloat(body.contract_value_aed)||0 });
      closeModal('modal-new-scope');
      await loadScopes();
      selectScope(res.id);
    } else {
      const detail = res?.message || res?.hint || JSON.stringify(res);
      showMsg(msg, 'err', 'Save failed: ' + (detail || 'unknown error'));
    }
  }
}

// ══════════════════════════════════════════════
// DELETE SCOPE (super admin only)
// ══════════════════════════════════════════════
function openDeleteScope() {
  if (!isSuperAdmin) return;
  document.getElementById('del-scope-name').textContent = selectedScope.subcontractor_name;
  document.getElementById('del-scope-meta').textContent = [selectedScope.scope_title, selectedScope.sca_ref].filter(Boolean).join(' · ');
  document.getElementById('del-scope-confirm-input').value = '';
  document.getElementById('del-scope-btn').disabled = true;
  document.getElementById('del-scope-msg').className = 'form-msg';
  document.getElementById('modal-delete-scope').style.display = 'flex';
}

async function confirmDeleteScope() {
  if (!isSuperAdmin) return;
  if (document.getElementById('del-scope-confirm-input').value !== 'DELETE') return;
  const btn = document.getElementById('del-scope-btn');
  const msg = document.getElementById('del-scope-msg');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    const sid = selectedScope.id;
    // Cascade delete in safe order
    // 1. Get PC ids for this scope
    const pcs = await fa(`qs_payment_certificates?scope_id=eq.${sid}&select=id`);
    if (pcs.length) {
      const pcIds = pcs.map(p => p.id).join(',');
      await fdel(`qs_pc_signatories?pc_id=in.(${pcIds})`);
      // qs_pc_overrides links via pc_id (no scope_id column) — delete before the PCs
      await fdel(`qs_pc_overrides?pc_id=in.(${pcIds})`);
    }
    await fdel(`qs_billed_records?scope_id=eq.${sid}`);
    await fdel(`qs_payment_certificates?scope_id=eq.${sid}`);
    // Get group ids
    const grps = await fa(`qs_scope_activity_groups?scope_id=eq.${sid}&select=id`);
    if (grps.length) await fdel(`qs_scope_activities?group_id=in.(${grps.map(g=>g.id).join(',')})`);
    await fdel(`qs_scope_activity_groups?scope_id=eq.${sid}`);
    await fdel(`qs_scope_villa_types?scope_id=eq.${sid}`);
    await fdel(`qs_variation_orders?scope_id=eq.${sid}`);
    await fdel(`qs_scopes?id=eq.${sid}`);
    audit('qs_scopes', 'DELETE_SCOPE', sid, null, { subcontractor_name: selectedScope.subcontractor_name, scope_title: selectedScope.scope_title, sca_ref: selectedScope.sca_ref });
    closeModal('modal-delete-scope');
    // Reset to dashboard
    selectedScope = null;
    selectedPC = null;
    document.getElementById('scope-panel').style.display = 'none';
    document.getElementById('no-scope-msg').style.display = 'flex';
    document.getElementById('btn-dash-overview').style.display = 'none';
    await loadScopes();
  } catch(e) {
    btn.disabled = false;
    btn.textContent = 'Delete Everything';
    showMsg(msg, 'err', 'Delete failed: ' + e.message);
  }
}

// ══════════════════════════════════════════════
// DELETE PC (admin_qs)
// ══════════════════════════════════════════════
function openDeletePC() {
  if (!canAdmin) return;
  document.getElementById('del-pc-label').textContent = `PC #${selectedPC.pc_number} · ${selectedPC.period_label}`;
  document.getElementById('del-pc-sub').textContent =
    selectedScope.subcontractor_name + (selectedPC.status === 'locked' ? ' — Locked (billed records will be cleared)' : ` — ${selectedPC.status.charAt(0).toUpperCase()+selectedPC.status.slice(1)}`);
  document.getElementById('del-pc-msg').className = 'form-msg';
  const btn = document.getElementById('del-pc-btn');
  btn.disabled = false;
  btn.textContent = 'Delete PC';
  document.getElementById('modal-delete-pc').style.display = 'flex';
}

async function confirmDeletePC() {
  if (!canAdmin) return;
  const btn = document.getElementById('del-pc-btn');
  const msg = document.getElementById('del-pc-msg');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    const pid = selectedPC.id;
    // Cascade delete: signatories → billed records → overrides → PC
    await fdel(`qs_pc_signatories?pc_id=eq.${pid}`);
    await fdel(`qs_billed_records?locked_pc_id=eq.${pid}`);
    await fdel(`qs_pc_overrides?pc_id=eq.${pid}`);
    await fdel(`qs_payment_certificates?id=eq.${pid}`);
    audit('qs_payment_certificates', 'DELETE_PC', pid, null, { scope: selectedScope.subcontractor_name, pc_number: selectedPC.pc_number, period_label: selectedPC.period_label, status: selectedPC.status });
    closeModal('modal-delete-pc');
    selectedPC = null;
    document.getElementById('pc-area').style.display = 'none';
    await loadPCs();
  } catch(e) {
    btn.disabled = false;
    btn.textContent = 'Delete PC';
    showMsg(msg, 'err', 'Delete failed: ' + e.message);
  }
}

// ══════════════════════════════════════════════
// NEW PC
// ══════════════════════════════════════════════
function openNewPC() {
  document.getElementById('npc-date').value = new Date().toISOString().slice(0,7) + '-01';
  document.getElementById('npc-label').value = '';
  document.getElementById('npc-num').value = '';
  document.getElementById('npc-notes').value = '';
  document.getElementById('npc-msg').className = 'form-msg';
  document.getElementById('npc-historical').checked = false;
  document.getElementById('npc-submit-btn').textContent = 'Create PC';
  // Scope multi-select (sibling scopes of the same subcontractor)
  const sib = allScopes.filter(s => s.is_active !== false && (
    (selectedScope.subcontractor_id && s.subcontractor_id === selectedScope.subcontractor_id) ||
    (!selectedScope.subcontractor_id && s.subcontractor_name === selectedScope.subcontractor_name)
  ));
  newPcScopeIds = [selectedScope.id];
  const row = document.getElementById('npc-scopes-row');
  const list = document.getElementById('npc-scopes-list');
  if (sib.length > 1) {
    row.style.display = '';
    list.innerHTML = sib.map(s => {
      const isPrimary = s.id === selectedScope.id;
      return `<label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:${isPrimary?'default':'pointer'}">
        <input type="checkbox" value="${s.id}" ${isPrimary?'checked disabled':''} onchange="toggleNpcScope(${s.id},this.checked)" style="width:14px;height:14px">
        <span><strong>${escH(s.sca_ref||s.scope_title||('Scope '+s.id))}</strong>${(s.scope_title&&s.sca_ref)?' · '+escH(s.scope_title):''}${isPrimary?' <span style="color:var(--tx3)">(current)</span>':''}</span>
      </label>`;
    }).join('');
  } else {
    row.style.display = 'none';
    list.innerHTML = '';
  }
  document.getElementById('modal-new-pc').style.display = 'flex';
}
function toggleNpcScope(id, on) {
  id = +id;
  if (on) { if (!newPcScopeIds.includes(id)) newPcScopeIds.push(id); }
  else { newPcScopeIds = newPcScopeIds.filter(x => x !== id); }
}

async function submitNewPC() {
  const num   = parseInt(document.getElementById('npc-num').value);
  const date  = document.getElementById('npc-date').value;
  const label = document.getElementById('npc-label').value.trim();
  const msg   = document.getElementById('npc-msg');
  if (!num || !date || !label) { showMsg(msg,'err','PC number, date and label are required.'); return; }

  // Inherit retention from scope defaults so new PCs start with the right setting
  const scopeRetPct = parseFloat(selectedScope.retention_pct) || 0;
  const body = { scope_id: selectedScope.id, pc_number: num, period_date: date, period_label: label,
    notes: document.getElementById('npc-notes').value.trim(),
    created_by: currentUser?.full_name || '', status:'draft',
    retention_applicable: scopeRetPct > 0 };
  const res = await fp('qs_payment_certificates', body);
  if (!res?.id) { showMsg(msg,'err','Save failed — PC number may already exist.'); return; }

  // Record every scope merged into this PC (primary always included)
  const ids = [...new Set([selectedScope.id, ...(newPcScopeIds||[])])];
  const scopeRows = ids.map((sid,i) => ({ pc_id: res.id, scope_id: sid, sort_order: i }));
  if (scopeRows.length) await fp('qs_pc_scopes', scopeRows);

  // Copy global signatories to this PC
  const globalSigsCopy = await fa('qs_signatories?is_active=eq.true&order=sort_order.asc');
  if (globalSigsCopy.length) {
    const sigCopies = globalSigsCopy.map(s => ({ pc_id: res.id, position_title: s.position_title, full_name: s.full_name, company: s.company, sort_order: s.sort_order }));
    await fp('qs_pc_signatories', sigCopies);
  }

  audit('qs_payment_certificates', 'CREATE_PC', res.id, { scope: selectedScope.subcontractor_name, pc_number: num, period_label: label, status: 'draft' });
  notifyTelegram('PC_CREATED', { scope: selectedScope.subcontractor_name, pcNumber: num, period: label });
  closeModal('modal-new-pc');
  await loadPCs();
  selectPC(res.id, await fa(`qs_payment_certificates?scope_id=eq.${selectedScope.id}&order=pc_number.asc`));
}

function toggleHistMode(on) {
  const btn = document.getElementById('npc-submit-btn');
  btn.textContent = on ? 'Next: Import Excel →' : 'Create PC';
  // Multi-scope merging isn't supported for historical PCs
  const row = document.getElementById('npc-scopes-row');
  if (row) row.style.display = (on || !document.getElementById('npc-scopes-list').children.length) ? 'none' : '';
}

function handleNewPC() {
  if (document.getElementById('npc-historical').checked) {
    // validate first
    const num   = parseInt(document.getElementById('npc-num').value);
    const date  = document.getElementById('npc-date').value;
    const label = document.getElementById('npc-label').value.trim();
    const msg   = document.getElementById('npc-msg');
    if (!num || !date || !label) { showMsg(msg,'err','PC number, date and label are required.'); return; }
    histPCMeta = { num, date, label, notes: document.getElementById('npc-notes').value.trim() };
    openHistPCSetup();
  } else {
    submitNewPC();
  }
}

function openHistPCSetup() {
  histPCSelections = {};
  document.getElementById('hist-pc-info-bar').textContent =
    `PC #${histPCMeta.num} · ${histPCMeta.label} · ${selectedScope.subcontractor_name}`;
  const im = document.getElementById('hist-pc-import-msg'); if (im) im.style.display = 'none';
  const ss = document.getElementById('hist-sheet-sel'); if (ss) { ss.style.display='none'; ss.innerHTML=''; }
  const cb = document.querySelector('#modal-hist-pc .btn-amber'); if (cb) { cb.disabled = false; cb.textContent = 'Create Locked PC'; }
  histWB = null;
  renderHistGrid();
  document.getElementById('modal-hist-pc').style.display = 'flex';
}

function renderHistGrid() {
  const grid = document.getElementById('hist-pc-grid');
  if (!scopeVillas.length || !scopeActivities.length) {
    grid.innerHTML = '<div style="color:var(--tx3);padding:16px">No villas or activities configured for this scope. Set up the scope configuration first.</div>';
    return;
  }

  // Build column headers from activity groups + activities
  let headCols = '<th style="text-align:left;padding:6px 10px;position:sticky;left:0;background:var(--bg3);z-index:5;min-width:72px">Villa</th>' +
                 '<th style="text-align:center;padding:6px 8px;position:sticky;left:72px;background:var(--bg3);z-index:5;min-width:56px">Cluster</th>' +
                 '<th style="text-align:left;padding:6px 10px;min-width:100px;position:sticky;left:128px;background:var(--bg3);z-index:5">Type</th>';
  scopeActivityGroups.forEach(grp => {
    const grpActs = scopeActivities.filter(a => a.group_id === grp.id);
    grpActs.forEach(act => {
      headCols += `<th style="white-space:normal;min-width:72px;padding:5px 8px;text-align:center;vertical-align:top">
        <div style="font-size:11px;font-weight:600;color:var(--tx)">${escH(act.activity_name)}${act.part_label?' <span style="color:var(--accent,#4f8cff)">('+escH(act.part_label)+')</span>':''}</div>
        <div style="font-size:10px;color:var(--tx3)">${escH(act.activity_code)}</div>
        <div style="margin-top:4px">
          <button class="btn btn-ghost btn-sm" style="font-size:9px;padding:2px 6px"
            onclick="histSelectAllAct('${escH(act.activity_code)}', true)">All</button>
          <button class="btn btn-ghost btn-sm" style="font-size:9px;padding:2px 6px"
            onclick="histSelectAllAct('${escH(act.activity_code)}', false)">None</button>
        </div>
      </th>`;
    });
  });
  headCols += '<th style="padding:6px 8px;text-align:center;white-space:nowrap">Select<br>Row</th>';

  // Group villas by cluster for separator rows
  let lastCluster = null;
  let rows = scopeVillas.map(sv => {
    const totalCols = 3 + scopeActivities.length + 1;
    let separator = '';
    if (sv.cluster_id !== lastCluster) {
      lastCluster = sv.cluster_id;
      separator = `<tr><td colspan="${totalCols}" style="background:var(--bg4);padding:4px 12px;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--tx3);border-top:2px solid var(--bdr2)">Cluster ${sv.cluster_id ?? '—'}</td></tr>`;
    }
    const clusterBg = 'var(--bg2)';
    let cells = `<td style="font-weight:700;padding:5px 10px;white-space:nowrap;position:sticky;left:0;background:${clusterBg};z-index:2;font-size:13px">VI-${escH(sv.villa_no)}</td>` +
                `<td style="font-size:12px;font-weight:600;padding:5px 8px;text-align:center;white-space:nowrap;color:var(--accent);position:sticky;left:72px;background:${clusterBg};z-index:2">C${sv.cluster_id ?? '—'}</td>` +
                `<td style="font-size:11px;padding:5px 10px;white-space:nowrap;color:var(--tx2);position:sticky;left:128px;background:${clusterBg};z-index:2">${escH(sv.villa_type_label)}</td>`;
    scopeActivityGroups.forEach(grp => {
      scopeActivities.filter(a => a.group_id === grp.id).forEach(act => {
        const key = `${sv.villa_id}:${act.activity_code}`;
        const chk = histPCSelections[key] ? 'checked' : '';
        cells += `<td style="text-align:center;padding:4px">
          <input type="checkbox" ${chk} style="width:16px;height:16px;accent-color:var(--green);cursor:pointer"
            onchange="histToggle('${sv.villa_id}','${escH(act.activity_code)}',this.checked)"
            id="hpk_${sv.villa_id}_${escH(act.activity_code)}">
        </td>`;
      });
    });
    // Row toggle button
    cells += `<td style="text-align:center;padding:4px">
      <button class="btn btn-ghost btn-sm" style="font-size:9px;padding:2px 8px"
        onclick="histSelectRow(${sv.villa_id})">All</button>
    </td>`;
    return separator + `<tr>${cells}</tr>`;
  }).join('');

  grid.innerHTML = `
    <table style="border-collapse:collapse;width:max-content;min-width:100%">
      <thead><tr style="background:var(--bg3)">${headCols}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  updateHistCount();
}

function histToggle(villaId, actCode, val) {
  histPCSelections[`${villaId}:${actCode}`] = val;
  updateHistCount();
}

function histSelectAllAct(actCode, val) {
  scopeVillas.forEach(sv => {
    histPCSelections[`${sv.villa_id}:${actCode}`] = val;
    const el = document.getElementById(`hpk_${sv.villa_id}_${actCode}`);
    if (el) el.checked = val;
  });
  updateHistCount();
}

function histSelectRow(villaId) {
  const allOn = scopeActivities.every(act => histPCSelections[`${villaId}:${act.activity_code}`]);
  scopeActivities.forEach(act => {
    const val = !allOn;
    histPCSelections[`${villaId}:${act.activity_code}`] = val;
    const el = document.getElementById(`hpk_${villaId}_${act.activity_code}`);
    if (el) el.checked = val;
  });
  updateHistCount();
}

function updateHistCount() {
  const n = Object.values(histPCSelections).filter(Boolean).length;
  document.getElementById('hist-pc-count').textContent = `${n} activit${n===1?'y':'ies'} selected across ${scopeVillas.length} villas`;
}

// ── Historical PC: import the progress Excel and pre-tick the grid ──
function histClearAll() {
  histPCSelections = {};
  renderHistGrid();
  const m = document.getElementById('hist-pc-import-msg');
  if (m) m.style.display = 'none';
}
function _pctTo100(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v <= 1 ? v * 100 : v;     // 1→100, 0.92→92, 100→100
  const n = parseFloat(String(v).replace('%','').trim());
  if (isNaN(n)) return 0;
  return n <= 1 ? n * 100 : n;
}
function _digits(v) { const m = String(v==null?'':v).match(/(\d+)/); return m ? parseInt(m[1],10) : null; }
function showHistImportMsg(kind, html, isHtml) {
  const m = document.getElementById('hist-pc-import-msg');
  if (!m) return;
  m.style.display = 'block';
  const pal = kind==='err' ? ['rgba(239,68,68,.10)','var(--red)','var(--red)']
            : kind==='busy' ? ['var(--bg3)','var(--accent)','var(--tx)']
            : ['var(--bg3)','var(--bdr)','var(--tx2)'];
  m.style.background = pal[0]; m.style.border = '1px solid '+pal[1]; m.style.color = pal[2];
  if (kind==='busy') {
    m.innerHTML = `<div style="display:flex;align-items:center;gap:10px"><span class="spin" style="width:16px;height:16px;border-width:2px;flex:0 0 auto"></span><span>${html||'Working…'}</span></div>`;
    return;
  }
  m.innerHTML = isHtml ? html : ('<div style="font-weight:600">'+escH(html)+'</div>');
}

let histWB = null;  // workbook from the last historical import (for the sheet picker)
function _normTxt(s){ return String(s==null?'':s).toLowerCase().replace(/[^a-z]/g,''); }  // "DRAINAGE-40%" → "drainage"

async function handleHistExcel(file) {
  if (!file) return;
  if (typeof XLSX === 'undefined') { showHistImportMsg('err','Spreadsheet library failed to load — check your connection and retry.'); return; }
  if (!scopeActivities.length) { showHistImportMsg('err','Configure this scope’s activities before importing.'); return; }
  try {
    showHistImportMsg('busy', 'Reading <strong>'+escH(file.name)+'</strong>…');
    histWB = XLSX.read(await file.arrayBuffer(), { type:'array' });
    histWB._fileName = file.name;
    // Pick a BOQ sheet (prefer one without a "(2)" copy suffix); let the user switch via the picker
    const lc = n => String(n).trim().toLowerCase();
    const boq = histWB.SheetNames.filter(n => lc(n).includes('boq'));
    const def = boq.find(n => lc(n)==='boq')
             || boq.filter(n => !n.includes('(')).sort((a,b)=>a.length-b.length)[0]
             || boq[0] || histWB.SheetNames[0];
    const sel = document.getElementById('hist-sheet-sel');
    if (sel) {
      sel.innerHTML = histWB.SheetNames.map(n => `<option value="${escH(n)}"${n===def?' selected':''}>${escH(n)}</option>`).join('');
      sel.style.display = '';
    }
    await parseHistSheet(def);
  } catch(e) {
    showHistImportMsg('err', 'Failed to read the file: ' + e.message);
  }
}

// Parse one sheet: match activity columns by GROUP + NAME (the code comes from the scope config)
async function parseHistSheet(sheetName) {
  if (!histWB) return;
  const sheet = histWB.Sheets[sheetName];
  if (!sheet) { showHistImportMsg('err','Sheet not found: '+escH(sheetName)); return; }
  try {
    showHistImportMsg('busy', 'Reading sheet <strong>'+escH(sheetName)+'</strong>…');
    let _maxC=0,_maxR=0;
    Object.keys(sheet).forEach(k => { if(k[0]==='!')return; const cc=XLSX.utils.decode_cell(k); if(cc.c>_maxC)_maxC=cc.c; if(cc.r>_maxR)_maxR=cc.r; });
    const rows = XLSX.utils.sheet_to_json(sheet, { header:1, raw:true, defval:'', range: XLSX.utils.encode_range({s:{r:0,c:0},e:{r:_maxR,c:_maxC}}) });
    if (!rows.length) { showHistImportMsg('err',`Sheet "${escH(sheetName)}" looks empty.`); return; }

    // Group scope activities by BASE code → ordered parts. A normal activity is a base with one
    // part; a split activity (GF/FF) is a base whose parts sit in consecutive BOQ sub-columns.
    const grpName = {}; scopeActivityGroups.forEach(g => grpName[g.id] = g.group_name);
    const baseParts = new Map();  // base → [{code, sort}]
    const baseMeta  = new Map();  // base → {name, group}
    scopeActivities.forEach(a => {
      const base = String(a.base_code || a.activity_code).trim();
      if (!baseParts.has(base)) { baseParts.set(base, []); baseMeta.set(base, { name:a.activity_name, group:grpName[a.group_id] }); }
      baseParts.get(base).push({ code:String(a.activity_code).trim(), sort:(a.sort_order||0) });
    });
    baseParts.forEach(arr => arr.sort((x,y)=>x.sort-y.sort));

    // name/group lookups at the BASE level (parts share the base's name)
    const byGN = new Map(), byName = new Map();
    baseMeta.forEach((m, base) => {
      byGN.set(_normTxt(m.group)+'|'+_normTxt(m.name), base);
      const nk = _normTxt(m.name);
      if (!byName.has(nk)) byName.set(nk, []);
      byName.get(nk).push(base);
    });
    const groupNorms = new Set(scopeActivityGroups.map(g => _normTxt(g.group_name)).filter(Boolean));

    // Find the name row (has "Villa No"), the group row, + Villa/Cluster cols
    let nameRow=-1, groupRow=-1, villaCol=-1, clusterCol=-1;
    const scan = Math.min(rows.length, 30);
    for (let r=0; r<scan; r++){
      const row = rows[r]||[];
      for (let c=0;c<row.length;c++){
        const cell = String(row[c]==null?'':row[c]).trim(); if(!cell) continue;
        const low = cell.toLowerCase();
        if (/villa\s*no/.test(low)) { if(nameRow<0) nameRow=r; if(villaCol<0) villaCol=c; }
        if (clusterCol<0 && low==='cluster') clusterCol=c;
        if (groupRow<0 && groupNorms.has(_normTxt(cell))) groupRow=r;
      }
    }

    // Find the START column for each base. Pass 1 — exact base-code cell. Pass 2 — name(+group)/order.
    const baseStart = new Map();
    for (let r=0; r<scan && baseStart.size<baseParts.size; r++){
      const row = rows[r]||[];
      for (let c=0;c<row.length;c++){
        const cell = String(row[c]==null?'':row[c]).trim();
        if (cell && baseParts.has(cell) && !baseStart.has(cell)) baseStart.set(cell, c);
      }
    }
    if (nameRow>=0 && baseStart.size < baseParts.size) {
      const usedCols = new Set([...baseStart.values()]);
      const nrow = rows[nameRow]||[];
      const grow = groupRow>=0 ? (rows[groupRow]||[]) : [];
      const width = Math.max(nrow.length, grow.length);
      let curGroup=''; const nameUse={};
      for (let c=0;c<width;c++){
        const gcell = grow[c]!=null ? String(grow[c]).trim() : '';
        if (gcell && groupNorms.has(_normTxt(gcell))) curGroup = _normTxt(gcell);
        const nk = _normTxt(nrow[c]); if(!nk) continue;
        if (usedCols.has(c)) { nameUse[nk] = (nameUse[nk]||0)+1; continue; }
        let base = byGN.get(curGroup+'|'+nk);
        if (!base) { const arr = byName.get(nk); if (arr && arr.length) base = arr[nameUse[nk]||0] || arr[arr.length-1]; }
        if (base && !baseStart.has(base)) baseStart.set(base, c);
        if (byName.has(nk)) nameUse[nk] = (nameUse[nk]||0)+1;
      }
    }

    // Expand each base to its part columns: part[i] → startCol + i (consecutive sub-columns)
    const codeCol = new Map();
    baseParts.forEach((parts, base) => {
      const start = baseStart.get(base);
      if (start == null) return;
      parts.forEach((p, i) => { if(!codeCol.has(p.code)) codeCol.set(p.code, start + i); });
    });

    if (!codeCol.size || villaCol < 0) {
      let diag = `<div style="font-weight:700;color:var(--red)">Couldn’t read sheet “${escH(sheetName)}”.</div>`;
      diag += `<div style="color:var(--tx2);margin-top:4px">${villaCol<0?'<span style="color:var(--amber)">no “Villa No” column</span> · ':''}${!codeCol.size?'<span style="color:var(--amber)">no activity columns matched by name</span>':''}</div>`;
      diag += `<div style="color:var(--tx3)">Scope groups: ${scopeActivityGroups.map(g=>escH(g.group_name)).join(', ')||'(none)'}</div>`;
      diag += `<div style="color:var(--tx3)">Scope activities: ${scopeActivities.map(a=>escH(a.activity_name)).join(', ')}</div>`;
      diag += `<div style="margin-top:6px;color:var(--tx2)">Top rows seen:</div>`;
      for (let r=0;r<Math.min(rows.length,12);r++){ const vals=(rows[r]||[]).map(v=>String(v==null?'':v).trim()).filter(Boolean); if(vals.length) diag+=`<div style="font-family:monospace;font-size:10px;color:var(--tx3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">r${r+1}: ${escH(vals.slice(0,22).join(' | '))}</div>`; }
      diag += `<div style="margin-top:6px;color:var(--tx3)">Try a different sheet above, or send me this panel.</div>`;
      showHistImportMsg('err', diag, true);
      return;
    }

    // Collect billed rows (only those with at least one 100% activity)
    showHistImportMsg('busy', 'Matching villas…');
    const billRows=[]; const clusterSet=new Set();
    for (let r=(nameRow>=0?nameRow+1:0); r<rows.length; r++){
      const row = rows[r]||[];
      const villaRaw = String(row[villaCol]==null?'':row[villaCol]).trim();
      if (!/vi[-\s]?\d+/i.test(villaRaw) && !/^\d+$/.test(villaRaw)) continue;
      const villaNo = _digits(villaRaw); if (villaNo==null) continue;
      const clusterNo = clusterCol>=0 ? _digits(row[clusterCol]) : null;
      const codes=[];
      for (const [code,col] of codeCol) if (_pctTo100(row[col]) >= 99.5) codes.push(code);
      if (!codes.length) continue;
      billRows.push({ villaNo, clusterNo, codes });
      if (clusterNo!=null) clusterSet.add(clusterNo);
    }

    // Match villas against the PROJECT villa list
    const clusterFilter = clusterSet.size ? `cluster_id=in.(${[...clusterSet].join(',')})&` : '';
    const projVillas = await fa(`villas?${clusterFilter}select=id,villa_no,cluster_id,villa_type&is_active=eq.true&limit=20000`);
    const vKey={}, vNo={};
    projVillas.forEach(v => { vKey[(v.cluster_id ?? '')+':'+v.villa_no]=v; (vNo[v.villa_no]=vNo[v.villa_no]||[]).push(v); });

    histPCSelections = {};
    const importedVillas=[]; const seen=new Set(); const unmatched=[]; let cellsTicked=0;
    billRows.forEach(br => {
      let v = (br.clusterNo!=null) ? vKey[br.clusterNo+':'+br.villaNo] : undefined;
      if (!v) { const cand=vNo[br.villaNo]; if(cand&&cand.length===1) v=cand[0]; }
      if (!v) { unmatched.push('VI-'+br.villaNo+(br.clusterNo!=null?' (C'+br.clusterNo+')':'')); return; }
      if (!seen.has(v.id)){ seen.add(v.id); importedVillas.push({villa_id:v.id,villa_no:v.villa_no,cluster_id:v.cluster_id,villa_type_label:matchVillaType(v.villa_type),raw_villa_type:v.villa_type}); }
      br.codes.forEach(code => { histPCSelections[v.id+':'+code]=true; cellsTicked++; });
    });

    // The Excel defines this PC's villas — show ONLY those that have at least one billed activity
    scopeVillas = importedVillas.slice().sort((a,b)=>((a.cluster_id||0)-(b.cluster_id||0))||((a.villa_no||0)-(b.villa_no||0)));
    updateClusterFilter();
    renderHistGrid();

    const codeName = {}; scopeActivities.forEach(a=>codeName[String(a.activity_code).trim()]=a.activity_name);
    const lbl = c => escH((codeName[c]||'')+' ['+c+']');
    const missing = scopeActivities.map(a=>String(a.activity_code).trim()).filter(c=>!codeCol.has(c));
    let html = `<div style="font-weight:700;color:var(--green)">✓ Imported ${escH(histWB._fileName||'')} — sheet <strong>${escH(sheetName)}</strong></div>
      <div>Billed villas: <strong>${importedVillas.length}</strong> &middot; Activities ticked (100%): <strong>${cellsTicked}</strong></div>
      <div style="color:var(--tx3)">Matched activities: ${[...codeCol.keys()].map(lbl).join(', ')}</div>`;
    if (missing.length) html += `<div style="color:var(--amber)">⚠ Not matched to a column: ${missing.map(lbl).join(', ')}</div>`;
    if (unmatched.length) html += `<div style="color:var(--amber)">⚠ ${unmatched.length} villa(s) not found in the project (skipped): ${unmatched.slice(0,20).map(escH).join(', ')}${unmatched.length>20?' …':''}</div>`;
    html += `<div style="color:var(--tx3);margin-top:4px">Review the grid, then click <strong>Create Locked PC</strong>. Wrong sheet? Pick another above.</div>`;
    showHistImportMsg('ok', html, true);
  } catch(e) {
    showHistImportMsg('err', 'Failed to read the sheet: ' + e.message);
  }
}

async function submitHistPC() {
  const btn = document.querySelector('#modal-hist-pc .btn-amber');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    // 1. Create the PC as locked
    const body = {
      scope_id: selectedScope.id,
      pc_number: histPCMeta.num,
      period_date: histPCMeta.date,
      period_label: histPCMeta.label,
      notes: histPCMeta.notes,
      created_by: currentUser?.full_name || '',
      status: 'locked'
    };
    const res = await fp('qs_payment_certificates', body);
    if (!res?.id) throw new Error('PC was not created — PC number may already exist for this scope.');

    // Link the scope (historical PCs are single-scope)
    await fp('qs_pc_scopes', [{ pc_id: res.id, scope_id: selectedScope.id, sort_order: 0 }]);

    // Copy global signatories
    const globalSigsCopy = await fa('qs_signatories?is_active=eq.true&order=sort_order.asc');
    if (globalSigsCopy.length) {
      await fp('qs_pc_signatories', globalSigsCopy.map(s => ({
        pc_id: res.id, position_title: s.position_title,
        full_name: s.full_name, company: s.company, sort_order: s.sort_order
      })));
    }

    // 2. Insert billed records for all checked (villa, activity) pairs
    const billedItems = [];
    scopeVillas.forEach(sv => {
      scopeActivities.forEach(act => {
        if (histPCSelections[`${sv.villa_id}:${act.activity_code}`]) {
          billedItems.push({
            scope_id: selectedScope.id,
            locked_pc_id: res.id,
            villa_id: sv.villa_id,
            activity_code: act.activity_code
          });
        }
      });
    });
    if (billedItems.length) {
      const brRes = await fetch(`${SB}/rest/v1/qs_billed_records?on_conflict=scope_id,villa_id,activity_code`, {
        method: 'POST',
        headers: getH({'Prefer':'resolution=ignore-duplicates,return=minimal'}),
        body: JSON.stringify(billedItems)
      });
      if (!brRes.ok) {
        let errMsg = `HTTP ${brRes.status}`;
        try { const ed = await brRes.json(); if (ed && ed.message) errMsg = `[${brRes.status}] ${ed.message}`; } catch(_){}
        throw new Error(`PC created (id ${res.id}) but billed records failed to save: ${errMsg}. Delete this PC and try again.`);
      }
    }

    audit('qs_payment_certificates', 'CREATE_HISTORICAL_PC', res.id, { scope: selectedScope.subcontractor_name, pc_number: histPCMeta.num, period_label: histPCMeta.label, billed_activities: billedItems.length });
    btn.disabled = false; btn.textContent = 'Create Locked PC';
    closeModal('modal-hist-pc');
    closeModal('modal-new-pc');
    await loadPCs();
    selectPC(res.id, await fa(`qs_payment_certificates?scope_id=eq.${selectedScope.id}&order=pc_number.asc`));
  } catch(e) {
    btn.disabled = false; btn.textContent = 'Create Locked PC';
    alert('Error: ' + e.message);
  }
}

// ══════════════════════════════════════════════
// CONFIGURE SCOPE (admin_qs)
// ══════════════════════════════════════════════
async function openConfigScope() {
  if (!canAdmin) return;
  document.getElementById('cfg-scope-name').textContent = selectedScope.subcontractor_name;
  cfgVillaTypes = JSON.parse(JSON.stringify(scopeVillaTypes));
  cfgActGroups  = JSON.parse(JSON.stringify(scopeActivityGroups));
  // Build cfgActivities working copy with _gi = index into cfgActGroups
  cfgActivities = scopeActivities.map(a => {
    const gi = cfgActGroups.findIndex(g => g.id === a.group_id);
    return { ...a, _gi: gi };
  });
  // Populate contract tab fields
  updateCfgContractField();
  document.getElementById('cfg-retention-pct').value = selectedScope.retention_pct > 0 ? (parseFloat(selectedScope.retention_pct)*100).toFixed(1) : '';
  document.getElementById('cfg-advance-amount').value = parseFloat(selectedScope.advance_amount_aed)||'';
  document.getElementById('cfg-advance-pct').value = selectedScope.advance_recovery_pct > 0 ? (parseFloat(selectedScope.advance_recovery_pct)*100).toFixed(1) : '';
  switchCfgTab('types');
  renderCfgTypes();
  _refreshTplSelect();
  renderCfgActs();
  renderDetectedVillas();
  await loadGlobalSigs();
  renderCfgSigs();
  document.getElementById('modal-config-scope').style.display = 'flex';
}

function getVillaTypeOptions() {
  // Always include 4/5/6 Bedroom Villa as the standard base set
  const base = [4, 5, 6];
  const extra = new Set();
  // Add any additional bedroom counts found in scope villas or already-configured types
  scopeVillas.forEach(sv => { const b = extractBedrooms(sv.raw_villa_type); if (b && !base.includes(b)) extra.add(b); });
  cfgVillaTypes.forEach(t => { const b = extractBedrooms(t.villa_type_label); if (b && !base.includes(b)) extra.add(b); });
  return [...base, ...[...extra].sort((a, b) => a - b)].map(b => `${b} Bedroom Villa`);
}

// Contract value = sum of (qty contracted × rate) across all villa types in the scope
function cfgContractValue() {
  return (cfgVillaTypes||[]).reduce((a,t)=>a + (parseFloat(t.qty_contracted)||0)*(parseFloat(t.rate_aed)||0), 0);
}
function updateCfgContractField() {
  const el = document.getElementById('cfg-contract-value');
  if (el) el.value = cfgContractValue().toFixed(2);
}

function renderCfgTypes() {
  const list = document.getElementById('cfg-types-list');
  const opts = getVillaTypeOptions();
  const header = `
    <div style="display:grid;grid-template-columns:1fr 80px 100px 120px 28px;gap:6px;padding:0 10px 4px;font-size:10px;font-weight:700;color:var(--tx3);text-transform:uppercase;letter-spacing:.05em">
      <span>Villa Type</span>
      <span>Unit</span>
      <span>QTY Contracted</span>
      <span>Rate per Villa (AED)</span>
      <span></span>
    </div>`;
  const rows = cfgVillaTypes.map((t,i) => {
    const optHtml = opts.map(o => `<option value="${escH(o)}"${t.villa_type_label===o?' selected':''}>${escH(o)}</option>`).join('');
    return `
    <div style="display:grid;grid-template-columns:1fr 80px 100px 120px 28px;gap:6px;align-items:center;background:var(--bg3);border:1px solid var(--bdr);border-radius:6px;padding:8px 10px">
      <select onchange="cfgVillaTypes[${i}].villa_type_label=this.value" style="width:100%">${optHtml}</select>
      <input type="text" value="${escH(t.unit||'Villa')}" placeholder="Villa" title="Unit of measure printed on the certificate" onchange="cfgVillaTypes[${i}].unit=this.value">
      <input type="number" value="${t.qty_contracted}" placeholder="0" min="0" title="Total number of villas of this type in the subcontract" onchange="cfgVillaTypes[${i}].qty_contracted=+this.value;updateCfgContractField()">
      <input type="number" value="${t.rate_aed}" placeholder="0.00" min="0" step="0.01" title="Payment rate per villa (AED)" onchange="cfgVillaTypes[${i}].rate_aed=+this.value;updateCfgContractField()">
      <button class="icon-btn del" title="Remove this villa type" onclick="cfgVillaTypes.splice(${i},1);renderCfgTypes();updateCfgContractField()">🗑</button>
    </div>`;
  }).join('');
  list.innerHTML = cfgVillaTypes.length
    ? header + rows
    : '<div style="color:var(--tx3);font-size:12px;padding:8px">No villa types yet. Click "+ Add Villa Type" to add one.</div>';
}

function addVillaTypeRow() {
  const opts = getVillaTypeOptions();
  // Default to first option not already used, or first option
  const used = new Set(cfgVillaTypes.map(t => t.villa_type_label));
  const defaultLabel = opts.find(o => !used.has(o)) || opts[0];
  cfgVillaTypes.push({ scope_id: selectedScope.id, villa_type_label: defaultLabel, unit:'Villa', qty_contracted:0, rate_aed:0, sort_order: cfgVillaTypes.length });
  renderCfgTypes();
  updateCfgContractField();
}

function renderCfgActs() {
  const list = document.getElementById('cfg-acts-list');
  if (!cfgActGroups.length) {
    list.innerHTML = '<div style="color:var(--tx3);font-size:12px;padding:8px 4px">No activity groups yet. Click "+ Add Activity Group" to create one.</div>';
    return;
  }
  // Weight totals hint
  const grpTotal = cfgActGroups.reduce((s,g)=>s+g.group_weight,0);
  const grpPct   = (grpTotal*100).toFixed(1);
  const grpOk    = Math.abs(grpTotal-1)<0.005;
  const hintHtml = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;font-size:11px">
      <span style="color:var(--tx3)">Each group weight is its share of the total contract. Activities within a group share that group's weight.</span>
      <span style="font-weight:700;color:${grpOk?'var(--green)':'var(--amber)'}">Groups total: ${grpPct}% ${grpOk?'✓':'(should be 100%)'}</span>
    </div>`;
  list.innerHTML = hintHtml + cfgActGroups.map((grp, gi) => {
    const grpActs = cfgActivities.filter(a => a._gi === gi);
    const actTotal = grpActs.reduce((s,a)=>s+a.activity_weight,0);
    const actPct   = (actTotal*100).toFixed(1);
    const actOk    = !grpActs.length || Math.abs(actTotal-1)<0.005;
    return `<div class="ag-group">
      <div class="ag-group-hdr">
        <input type="text" value="${escH(grp.group_name)}" placeholder="Group name (e.g. High Level Drain)"
               style="flex:1;padding:4px 8px;font-size:12px"
               onchange="cfgActGroups[${gi}].group_name=this.value">
        <span style="font-size:11px;color:var(--tx3);white-space:nowrap">Group weight:</span>
        <input type="number" value="${(grp.group_weight*100).toFixed(1)}" min="0" max="100" step="0.1"
               style="width:64px;padding:4px 6px;font-size:12px;text-align:right"
               onchange="cfgActGroups[${gi}].group_weight=+this.value/100">
        <span style="font-size:11px;color:var(--tx2)">%</span>
        <button class="icon-btn del" title="Remove this group and all its activities" onclick="removeCfgGroup(${gi})">🗑</button>
      </div>
      <div class="ag-acts">
        <div style="display:grid;grid-template-columns:90px 1fr 80px 24px;gap:4px;padding:4px 2px;font-size:10px;font-weight:700;color:var(--tx3);text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--bdr);margin-bottom:4px">
          <span>WIR Code</span><span>Activity Name</span>
          <span style="text-align:right;padding-right:18px">Weight</span><span></span>
        </div>
        ${grpActs.map(act => {
          const ai = cfgActivities.indexOf(act);
          const isPart = !!(act.part_label && String(act.part_label).trim());
          if (isPart) {
            return `<div class="ag-act-row" style="border-left:3px solid var(--accent,#4f8cff)">
              <span style="font-size:9px;color:var(--tx3);font-family:monospace;white-space:nowrap" title="Shared BOQ code">↳ ${escH(act.base_code||'')}</span>
              <input type="text" value="${escH(act.part_label)}" placeholder="GF" title="Part label (e.g. GF / FF)"
                     style="width:46px;font-size:11px;text-transform:uppercase" onchange="setCfgPartLabel(${ai},this.value)">
              <input type="text" value="${escH(act.activity_name)}" placeholder="Activity description"
                     style="flex:1;font-size:11px" onchange="cfgActivities[${ai}].activity_name=this.value">
              <input type="number" value="${(act.activity_weight*100).toFixed(1)}" min="0" max="100" step="0.1"
                     style="width:64px;text-align:right;font-size:11px" onchange="cfgActivities[${ai}].activity_weight=+this.value/100">
              <span style="font-size:11px;color:var(--tx2)">%</span>
              <button class="icon-btn" title="Merge parts back into one activity" onclick="unsplitCfgActivity(${ai})">↩</button>
              <button class="icon-btn del" onclick="cfgActivities.splice(${ai},1);renderCfgActs()">🗑</button>
            </div>`;
          }
          return `<div class="ag-act-row">
            <input type="text" value="${escH(act.activity_code)}" placeholder="e.g. 3060"
                   style="width:90px;font-family:monospace;font-size:11px"
                   onchange="cfgActivities[${ai}].activity_code=this.value;cfgActivities[${ai}].base_code=this.value">
            <input type="text" value="${escH(act.activity_name)}" placeholder="Activity description"
                   style="flex:1;font-size:11px"
                   onchange="cfgActivities[${ai}].activity_name=this.value">
            <input type="number" value="${(act.activity_weight*100).toFixed(1)}" min="0" max="100" step="0.1"
                   style="width:64px;text-align:right;font-size:11px"
                   onchange="cfgActivities[${ai}].activity_weight=+this.value/100">
            <span style="font-size:11px;color:var(--tx2);align-self:center">%</span>
            <button class="icon-btn" title="Split into GF / FF parts (for old split BOQs)" onclick="splitCfgActivity(${ai})">⫶</button>
            <button class="icon-btn del" onclick="cfgActivities.splice(${ai},1);renderCfgActs()">🗑</button>
          </div>`;
        }).join('')}
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px">
          <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="addCfgActivity(${gi})">+ Add Activity</button>
          ${grpActs.length ? `<span style="font-size:10px;font-weight:700;color:${actOk?'var(--green)':'var(--amber)'}">${actPct}% ${actOk?'✓':'≠ 100%'}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

function addCfgActivity(gi) {
  cfgActivities.push({ _gi: gi, group_id: cfgActGroups[gi]?.id, activity_code:'', activity_name:'', base_code:'', activity_weight:0, sort_order: cfgActivities.filter(a=>a._gi===gi).length });
  renderCfgActs();
}
// ── Split an activity into weighted sub-parts (GF/FF) — for importing old split BOQs ──
function _cfgPartCode(base,label){ return (String(base||'').trim()||'ACT')+'-'+(String(label||'').trim().toUpperCase()||'P'); }
function setCfgPartLabel(ai,val){
  const a=cfgActivities[ai]; if(!a)return;
  a.part_label=String(val||'').trim().toUpperCase();
  a.activity_code=_cfgPartCode(a.base_code,a.part_label);
}
function splitCfgActivity(ai){
  const a=cfgActivities[ai]; if(!a||a.part_label)return;
  const base=(a.activity_code||'').trim()||('ACT'+(ai+1));
  const w=a.activity_weight||0;
  a.base_code=base; a.part_label='GF'; a.activity_weight=w/2; a.activity_code=_cfgPartCode(base,'GF');
  cfgActivities.splice(ai+1,0,{ _gi:a._gi, group_id:a.group_id, base_code:base, part_label:'FF', activity_code:_cfgPartCode(base,'FF'), activity_name:a.activity_name||'', activity_weight:w/2, sort_order:(a.sort_order||0) });
  renderCfgActs();
}
function unsplitCfgActivity(ai){
  const a=cfgActivities[ai]; if(!a||!a.part_label)return;
  const gi=a._gi, base=a.base_code;
  const parts=cfgActivities.filter(x=>x._gi===gi && x.base_code===base && x.part_label);
  const totalW=parts.reduce((s,x)=>s+(x.activity_weight||0),0);
  const name=parts[0]?.activity_name||a.activity_name||'';
  const pos=cfgActivities.indexOf(parts[0]);
  cfgActivities=cfgActivities.filter(x=>!(x._gi===gi && x.base_code===base && x.part_label));
  cfgActivities.splice(Math.max(0,pos),0,{ _gi:gi, group_id:a.group_id, base_code:base, part_label:'', activity_code:base, activity_name:name, activity_weight:totalW, sort_order:a.sort_order||0 });
  renderCfgActs();
}

function removeCfgGroup(gi) {
  // Remove all activities for this group and shift _gi for later groups
  cfgActivities = cfgActivities.filter(a => a._gi !== gi).map(a => ({ ...a, _gi: a._gi > gi ? a._gi - 1 : a._gi }));
  cfgActGroups.splice(gi, 1);
  renderCfgActs();
}

function addActivityGroup() {
  cfgActGroups.push({ scope_id: selectedScope.id, group_name:'New Group', group_weight:0, sort_order: cfgActGroups.length });
  renderCfgActs();
}

function renderCfgVillas() {
  const list = document.getElementById('va-list');
  const q = (document.getElementById('va-search')?.value||'').toLowerCase();
  const filtered = cfgScopeVillas.filter(v => String(v.villa_no).includes(q));
  document.getElementById('va-count').textContent = cfgScopeVillas.length;
  if (!filtered.length) { list.innerHTML = '<div class="va-row" style="color:var(--tx3);font-size:11px">No villas assigned</div>'; return; }
  list.innerHTML = filtered.map((v,i) => `
    <div class="va-row">
      <span class="va-villa-no">VI-${escH(v.villa_no)}</span>
      <select class="va-type-sel" onchange="cfgScopeVillas.find(x=>x.villa_id===${v.villa_id}).villa_type_label=this.value">
        ${['4 Bedroom Villa','5 Bedroom Villa','6 Bedroom Villa'].map(t=>`<option ${t===v.villa_type_label?'selected':''}>${t}</option>`).join('')}
      </select>
      <span class="va-remove" onclick="cfgScopeVillas.splice(cfgScopeVillas.findIndex(x=>x.villa_id===${v.villa_id}),1);renderCfgVillas()">✕</span>
    </div>`).join('');
}

function filterVillaAssign() { renderCfgVillas(); }

async function loadGlobalSigs() {
  globalSigs = await fa('qs_signatories?is_active=eq.true&order=sort_order.asc');
}

function renderCfgSigs() {
  const list = document.getElementById('cfg-sigs-list');
  list.innerHTML = globalSigs.map((s,i) => `
    <div class="sig-edit-row">
      <input type="text" value="${escH(s.position_title)}" placeholder="Position" onchange="globalSigs[${i}].position_title=this.value">
      <input type="text" value="${escH(s.full_name)}" placeholder="Full Name" onchange="globalSigs[${i}].full_name=this.value">
      <input type="text" value="${escH(s.company||'RA')}" placeholder="Company" onchange="globalSigs[${i}].company=this.value">
      <button class="icon-btn del" onclick="globalSigs.splice(${i},1);renderCfgSigs()">🗑</button>
    </div>`).join('') || '<div style="color:var(--tx3);font-size:12px">No signatories yet.</div>';
}

function addGlobalSig() {
  globalSigs.push({ position_title:'', full_name:'', company:'RA', sort_order: globalSigs.length, is_active:true });
  renderCfgSigs();
}

async function saveConfigScope() {
  const msg1 = document.getElementById('cfg-types-msg');
  const msg2 = document.getElementById('cfg-acts-msg');
  const msg3 = document.getElementById('cfg-sigs-msg');
  // In template-edit mode, save writes to the template scope, not the real selected scope
  const sid = _tplEditMode ? _tplEditId : selectedScope.id;

  try {
    if (cfgTab === 'types') {
      // Upsert villa types
      await fdel(`qs_scope_villa_types?scope_id=eq.${sid}`);
      if (cfgVillaTypes.length) {
        const rows = cfgVillaTypes.map((t,i) => ({ scope_id:sid, villa_type_label:t.villa_type_label, unit:t.unit||'Villa', qty_contracted:t.qty_contracted||0, rate_aed:t.rate_aed||0, sort_order:i }));
        await fp('qs_scope_villa_types', rows);
      }
      // Contract value is derived from villa types — keep it in sync
      const cv = cfgContractValue();
      await fpatch(`qs_scopes?id=eq.${sid}`, { contract_value_aed: cv });
      selectedScope.contract_value_aed = cv;
      const sc = allScopes.find(e => e.id === sid); if (sc) sc.contract_value_aed = cv;
      audit('qs_scope_villa_types', 'UPDATE_VILLA_TYPES', sid, { scope: selectedScope.subcontractor_name, types_count: cfgVillaTypes.length, contract_value_aed: cv });
      showMsg(msg1,'ok','Villa rates saved. Contract value set to '+fmtAED(cv)+'.');
      await loadScopeConfig(); renderCfgTypes(); cfgVillaTypes = JSON.parse(JSON.stringify(scopeVillaTypes));
    }
    else if (cfgTab === 'acts') {
      // Delete all existing groups (cascades to activities via FK)
      await fdel(`qs_scope_activity_groups?scope_id=eq.${sid}`);
      for (let gi = 0; gi < cfgActGroups.length; gi++) {
        const grp = cfgActGroups[gi];
        const grpRes = await fp('qs_scope_activity_groups', {
          scope_id: sid, group_name: grp.group_name, group_weight: grp.group_weight, sort_order: gi
        });
        const newGrpId = grpRes?.id;
        // Get activities that belong to this group by _gi index
        const grpActs = cfgActivities.filter(a => a._gi === gi);
        if (newGrpId && grpActs.length) {
          const actRows = grpActs.map((a, ai) => ({
            group_id: newGrpId,
            activity_code: a.activity_code,
            activity_name: a.activity_name,
            activity_weight: a.activity_weight,
            base_code: (a.base_code || a.activity_code),
            part_label: (a.part_label && String(a.part_label).trim()) ? String(a.part_label).trim().toUpperCase() : null,
            sort_order: ai
          }));
          await fp('qs_scope_activities', actRows);
        }
      }
      audit('qs_scope_activity_groups', 'UPDATE_ACTIVITIES', sid, { scope: (selectedScope||{}).subcontractor_name, groups_count: cfgActGroups.length, activities_count: cfgActivities.length });
      showMsg(msg2, 'ok', 'Activities saved.');
      if (_tplEditMode) {
        // Refresh template groups/activities in memory
        const grps = await fa(`qs_scope_activity_groups?scope_id=eq.${sid}&order=sort_order.asc`);
        const grpIds = grps.map(g => g.id);
        const acts = grpIds.length ? await fa(`qs_scope_activities?group_id=in.(${grpIds.join(',')})&order=sort_order.asc`) : [];
        cfgActGroups = JSON.parse(JSON.stringify(grps));
        cfgActivities = acts.map(a => ({ ...a, _gi: cfgActGroups.findIndex(g => g.id === a.group_id) }));
        renderTemplateList(); // refresh group count badges
      } else {
        await loadScopeConfig();
        cfgActGroups = JSON.parse(JSON.stringify(scopeActivityGroups));
        cfgActivities = scopeActivities.map(a => ({
          ...a, _gi: cfgActGroups.findIndex(g => g.id === a.group_id)
        }));
      }
      renderCfgActs();
    }
    else if (cfgTab === 'villas') {
      // Detected Villas tab is read-only — refresh from WIR data
      await loadScopeConfig();
      renderDetectedVillas();
    }
    else if (cfgTab === 'sigs') {
      // Upsert global sigs
      await fdel('qs_signatories?sort_order=gte.0');
      if (globalSigs.length) {
        const rows = globalSigs.map((s,i) => ({ position_title:s.position_title, full_name:s.full_name, company:s.company||'RA', sort_order:i, is_active:true }));
        await fp('qs_signatories', rows);
      }
      audit('qs_signatories', 'UPDATE_GLOBAL_SIGS', sid, { scope: selectedScope.subcontractor_name, sigs_count: globalSigs.length });
      showMsg(msg3,'ok','Global signatories saved.');
      await loadGlobalSigs(); renderCfgSigs();
    }
    else if (cfgTab === 'contract') {
      const msgC = document.getElementById('cfg-contract-msg');
      const contractVal = cfgContractValue();  // derived from villa types, not manually entered
      const retPct = parseFloat(document.getElementById('cfg-retention-pct').value)||0;
      const advAmt = parseFloat(document.getElementById('cfg-advance-amount').value)||0;
      const advPct = parseFloat(document.getElementById('cfg-advance-pct').value)||0;
      const body = {
        contract_value_aed: contractVal,
        retention_pct: retPct/100,
        advance_amount_aed: advAmt,
        advance_recovery_pct: advPct/100
      };
      await fpatch(`qs_scopes?id=eq.${sid}`, body);
      // Update local scope data
      Object.assign(selectedScope, body);
      // Refresh loadScopes so sidebar scope cards reflect new data
      const freshScopes = await fa('qs_scopes?select=id,subcontractor_name,display_name,scope_title,sca_ref,package,project,contract_value_aed,retention_pct,advance_amount_aed,advance_recovery_pct&order=subcontractor_name.asc');
      freshScopes.forEach(s => {
        const existing = allScopes.find(e => e.id === s.id);
        if (existing) Object.assign(existing, s);
      });
      audit('qs_scopes', 'UPDATE_CONTRACT_SETTINGS', sid, body, null);
      showMsg(msgC, 'ok', 'Contract settings saved.');
    }
  } catch(e) {
    const m = [msg1,msg2,msg3,document.getElementById('cfg-contract-msg')].find(Boolean);
    if(m) showMsg(m,'err','Save failed: '+e.message);
  }
}

// ── Detected Villas panel (read-only, auto from WIR) ──
function renderDetectedVillas() {
  const el = document.getElementById('cfg-villa-detect-content');
  if (!el) return;
  if (!scopeVillas.length) {
    el.innerHTML = `<div style="color:var(--tx3);font-size:12px;padding:12px 4px">
      No villas detected yet. This means no WIR submissions have been recorded for
      <strong>${escH(selectedScope.subcontractor_name)}</strong> in the system.
      Once WIR data is imported with this subcontractor's name, villas will appear here automatically.
    </div>`;
    return;
  }
  // Group by villa TYPE first (contracted QTY is per type, scope-wide), then by cluster.
  const byType = {};
  scopeVillas.forEach(v => {
    const t = v.villa_type_label || 'Unknown';
    const c = v.cluster_id != null ? String(v.cluster_id) : 'Unknown';
    if (!byType[t]) byType[t] = {};
    if (!byType[t][c]) byType[t][c] = [];
    byType[t][c].push(v);
  });
  const allClusters = new Set(scopeVillas.map(v => v.cluster_id != null ? String(v.cluster_id) : 'Unknown'));
  const hasMultipleClusters = allClusters.size > 1;
  // Preserve the configured villa-type order, then any extra detected types
  const typeOrder = scopeVillaTypes.map(t => t.villa_type_label);
  const typeKeys = Object.keys(byType).sort((a,b) => {
    const ia = typeOrder.indexOf(a), ib = typeOrder.indexOf(b);
    return (ia<0?999:ia) - (ib<0?999:ib) || a.localeCompare(b);
  });
  const rows = typeKeys.map(type => {
    const clusters = byType[type];
    const detectedTotal = Object.values(clusters).reduce((a,arr)=>a+arr.length, 0);
    const contracted = scopeVillaTypes.find(t => t.villa_type_label === type)?.qty_contracted || 0;
    const balance = contracted - detectedTotal;
    const clusterKeys = Object.keys(clusters).sort((a,b)=> isNaN(a)||isNaN(b) ? a.localeCompare(b) : +a - +b);
    const clusterRows = clusterKeys.map(ck => {
      const villas = clusters[ck];
      const villaList = villas.map(v => `<span style="display:inline-block;background:var(--bg4);border:1px solid var(--bdr);border-radius:4px;padding:1px 6px;font-size:10px;font-family:monospace;margin:1px">VI-${escH(v.villa_no)}</span>`).join('');
      const clusterLabel = hasMultipleClusters
        ? `<div style="font-size:10px;font-weight:600;color:var(--tx3);margin:6px 0 2px">Cluster ${escH(ck)} · ${villas.length}</div>`
        : '';
      return clusterLabel + `<div style="line-height:2">${villaList}</div>`;
    }).join('');
    return `
      <div style="background:var(--bg3);border:1px solid var(--bdr);border-radius:8px;padding:12px;margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:8px;flex-wrap:wrap">
          <span style="font-weight:700;font-size:13px;color:var(--tx)">${escH(type)}</span>
          <span style="font-size:11px;color:var(--tx2)">Detected: <strong style="color:var(--green)">${detectedTotal}</strong></span>
          <span style="font-size:11px;color:var(--tx2)">Contracted QTY: <strong>${contracted||'—'}</strong></span>
          <span style="font-size:11px;color:var(--tx2)">Balance: <strong style="color:${balance>0?'var(--amber)':balance<0?'var(--red)':'var(--green)'}">${contracted?balance:'—'}</strong></span>
        </div>
        ${clusterRows}
      </div>`;
  }).join('');
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <span style="font-size:12px;color:var(--tx2)">
        <strong style="color:var(--tx)">${scopeVillas.length}</strong> villas detected across
        <strong style="color:var(--tx)">${typeKeys.length}</strong> types
        ${hasMultipleClusters ? `in <strong style="color:var(--tx)">${allClusters.size}</strong> clusters` : ''}
      </span>
      <span style="font-size:10px;color:var(--tx3)">Source: WIR / scope activities</span>
    </div>
    ${rows}`;
}

async function refreshDetectedVillas() {
  const el = document.getElementById('cfg-villa-detect-content');
  if (el) el.innerHTML = '<div class="loading-row"><span class="spin"></span></div>';
  scopeVillas = await autoDetectScopeVillas();
  renderDetectedVillas();
}

// ══════════════════════════════════════════════
// VARIATION ORDERS
// ══════════════════════════════════════════════
async function openVariations() {
  if (!canManage && !canAdmin) return;
  document.getElementById('vo-scope-name').textContent = selectedScope.subcontractor_name;
  document.getElementById('btn-add-vo').style.display = (canManage||canAdmin) ? '' : 'none';
  document.getElementById('vo-msg').className = 'form-msg';
  scopeVariations = await fa(`qs_variation_orders?scope_id=eq.${selectedScope.id}&order=created_at.asc`);
  renderVOList();
  document.getElementById('modal-variations').style.display = 'flex';
}

function renderVOList() {
  const list = document.getElementById('vo-list');
  if (!list) return;
  if (!scopeVariations.length) {
    list.innerHTML = '<div style="color:var(--tx3);font-size:12px;padding:16px;text-align:center">No variation orders yet. Click "+ Add VO" to add one.</div>';
    return;
  }
  const totalApproved = scopeVariations.filter(v=>v.status==='approved').reduce((a,v)=>a+(parseFloat(v.value_aed)||0),0);
  list.innerHTML = `
    <div style="display:grid;grid-template-columns:100px 1fr auto 140px 100px;gap:10px;padding:4px 12px 8px;font-size:10px;font-weight:700;color:var(--tx3);text-transform:uppercase;letter-spacing:.05em">
      <span>Ref</span><span>Description</span><span>Status</span><span style="text-align:right">Value (AED)</span><span></span>
    </div>
    ${scopeVariations.map(v => `
    <div class="vo-row">
      <span style="font-weight:700;color:var(--accent);font-family:monospace">${escH(v.vo_ref)}</span>
      <span style="color:var(--tx)">${escH(v.description||'—')}</span>
      <span><span class="vo-badge ${v.status}">${v.status==='pending'?'⏳ Pending':v.status==='approved'?'✓ Approved':'✗ Rejected'}</span></span>
      <span style="text-align:right;font-weight:700;color:${v.status==='approved'?'var(--green)':v.status==='rejected'?'var(--tx3)':'var(--tx)'}">${fmtAED(parseFloat(v.value_aed)||0)}</span>
      <span style="display:flex;gap:4px;justify-content:flex-end">
        ${(canManage||canAdmin)?`<button class="btn btn-ghost btn-sm" onclick="editVO(${v.id})">✎</button><button class="btn btn-danger btn-sm" onclick="deleteVO(${v.id})">🗑</button>`:''}
      </span>
    </div>`).join('')}
    ${totalApproved > 0 ? `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;margin-top:4px;border-top:2px solid var(--bdr2);font-size:12px;font-weight:700">
      <span style="color:var(--tx2)">Total Approved Variations</span>
      <span style="color:var(--green)">${fmtAED(totalApproved)}</span>
    </div>` : ''}`;
}

function openAddVO() {
  document.getElementById('vo-form-title').textContent = 'Add Variation Order';
  document.getElementById('vo-form-id').value = '';
  document.getElementById('vo-ref').value = '';
  document.getElementById('vo-status').value = 'pending';
  document.getElementById('vo-desc').value = '';
  document.getElementById('vo-value').value = '';
  document.getElementById('vo-notes').value = '';
  document.getElementById('vo-form-msg').className = 'form-msg';
  document.getElementById('vo-form-btn').textContent = 'Add VO';
  document.getElementById('modal-vo-form').style.display = 'flex';
}

function editVO(id) {
  const vo = scopeVariations.find(v => v.id === id);
  if (!vo) return;
  document.getElementById('vo-form-title').textContent = 'Edit Variation Order';
  document.getElementById('vo-form-id').value = id;
  document.getElementById('vo-ref').value = vo.vo_ref || '';
  document.getElementById('vo-status').value = vo.status || 'pending';
  document.getElementById('vo-desc').value = vo.description || '';
  document.getElementById('vo-value').value = vo.value_aed || '';
  document.getElementById('vo-notes').value = vo.notes || '';
  document.getElementById('vo-form-msg').className = 'form-msg';
  document.getElementById('vo-form-btn').textContent = 'Save Changes';
  document.getElementById('modal-vo-form').style.display = 'flex';
}

async function submitVO() {
  const msg = document.getElementById('vo-form-msg');
  const voRef = document.getElementById('vo-ref').value.trim();
  const desc  = document.getElementById('vo-desc').value.trim();
  if (!voRef)  { showMsg(msg, 'err', 'VO Reference is required.'); return; }
  if (!desc)   { showMsg(msg, 'err', 'Description is required.'); return; }
  const btn = document.getElementById('vo-form-btn');
  btn.disabled = true;
  const body = {
    scope_id: selectedScope.id,
    vo_ref: voRef,
    status: document.getElementById('vo-status').value,
    description: desc,
    value_aed: parseFloat(document.getElementById('vo-value').value)||0,
    notes: document.getElementById('vo-notes').value.trim()||null,
    created_by: currentUser?.full_name||null,
    approved_at: document.getElementById('vo-status').value === 'approved' ? new Date().toISOString() : null,
    updated_at: new Date().toISOString()
  };
  try {
    const existingId = parseInt(document.getElementById('vo-form-id').value)||0;
    if (existingId) {
      await fpatch(`qs_variation_orders?id=eq.${existingId}`, body);
      audit('qs_variation_orders', 'UPDATE_VO', existingId, body, null);
    } else {
      const res = await fp('qs_variation_orders', body);
      audit('qs_variation_orders', 'CREATE_VO', res.id, body, null);
    }
    scopeVariations = await fa(`qs_variation_orders?scope_id=eq.${selectedScope.id}&order=created_at.asc`);
    renderVOList();
    closeModal('modal-vo-form');
    // Refresh payment summary if open so contract position updates
    if (selectedPC) renderPaymentSummary();
  } catch(e) {
    showMsg(msg, 'err', 'Save failed: ' + e.message);
  }
  btn.disabled = false;
}

async function deleteVO(id) {
  const vo = scopeVariations.find(v => v.id === id);
  if (!vo) return;
  if (!confirm(`Delete VO ${vo.vo_ref}? This cannot be undone.`)) return;
  await fdel(`qs_variation_orders?id=eq.${id}`);
  audit('qs_variation_orders', 'DELETE_VO', id, null, { vo_ref: vo.vo_ref, description: vo.description, value_aed: vo.value_aed });
  scopeVariations = scopeVariations.filter(v => v.id !== id);
  renderVOList();
  if (selectedPC) renderPaymentSummary();
}

// ══════════════════════════════════════════════
// PC SIGNATORIES
// ══════════════════════════════════════════════
function openPcSigs() {
  document.getElementById('pcsig-pc-label').textContent = `PC #${selectedPC.pc_number} · ${selectedPC.period_label}`;
  renderPcSigsList();
  document.getElementById('pcsig-msg').className = 'form-msg';
  document.getElementById('modal-pc-sigs').style.display = 'flex';
}

function renderPcSigsList() {
  const list = document.getElementById('pcsig-list');
  list.innerHTML = pcSigsList.map((s,i) => `
    <div class="sig-edit-row">
      <input type="text" value="${escH(s.position_title)}" placeholder="Position" onchange="pcSigsList[${i}].position_title=this.value">
      <input type="text" value="${escH(s.full_name)}" placeholder="Full Name" onchange="pcSigsList[${i}].full_name=this.value">
      <input type="text" value="${escH(s.company||'RA')}" placeholder="Company" onchange="pcSigsList[${i}].company=this.value">
      <button class="icon-btn del" onclick="pcSigsList.splice(${i},1);renderPcSigsList()">🗑</button>
    </div>`).join('') || '<div style="color:var(--tx3);font-size:12px">No signatories yet.</div>';
}

function addPcSig() {
  pcSigsList.push({ position_title:'', full_name:'', company:'RA', sort_order: pcSigsList.length });
  renderPcSigsList();
}

async function resetPcSigs() {
  const defaults = await fa('qs_signatories?is_active=eq.true&order=sort_order.asc');
  pcSigsList = defaults.map(s => ({ pc_id: selectedPC.id, position_title: s.position_title, full_name: s.full_name, company: s.company, sort_order: s.sort_order }));
  renderPcSigsList();
}

async function savePcSigs() {
  const msg = document.getElementById('pcsig-msg');
  try {
    await fdel(`qs_pc_signatories?pc_id=eq.${selectedPC.id}`);
    if (pcSigsList.length) {
      const rows = pcSigsList.map((s,i) => ({ pc_id: selectedPC.id, position_title: s.position_title, full_name: s.full_name, company: s.company||'RA', sort_order: i }));
      await fp('qs_pc_signatories', rows);
    }
    audit('qs_pc_signatories', 'UPDATE_PC_SIGS', selectedPC.id, { scope: selectedScope.subcontractor_name, pc_number: selectedPC.pc_number, sigs_count: pcSigsList.length });
    closeModal('modal-pc-sigs');
    renderPaymentSummary();
  } catch(e) { showMsg(msg,'err','Save failed: '+e.message); }
}

// ══════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
  // If we were editing a template, restore scope + tab visibility
  if (id === 'modal-config-scope' && _tplEditMode) {
    _tplEditMode = false;
    selectedScope = _prevScopeBeforeTpl;
    _prevScopeBeforeTpl = null;
    ['types','villas','sigs','contract'].forEach(k => {
      const tab = document.getElementById('cfg-tab-' + k);
      if (tab) tab.style.display = '';
    });
  }
}

function showMsg(el, type, txt) {
  el.textContent = txt;
  el.className = 'form-msg ' + type;
  setTimeout(() => { el.className = 'form-msg'; }, 5000);
}

// ══════════════════════════════════════════════
// AUDIT LOGGING
// ══════════════════════════════════════════════
function audit(tableName, action, recordId, newData, oldData) {
  // Fire-and-forget — never blocks the main action, fails silently
  fp('audit_log', {
    table_name: tableName,
    action: action,
    record_id: recordId != null ? String(recordId) : null,
    changed_by_name: currentUser?.full_name || null,
    changed_by_user_id: currentUser?.id || null,
    changed_by_auth_id: currentUser?.auth_id || null,
    new_data: newData || null,
    old_data: oldData || null,
  }).catch(() => {});
}

// ══════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ══════════════════════════════════════════════
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay').forEach(m => {
      if (m.style.display !== 'none') m.style.display = 'none';
    });
  }
});

// ══════════════════════════════════════════════
// SESSION BRIDGE
// ══════════════════════════════════════════════
var _initCalled = false;
function _tryInit() {
  if (_initCalled) return;
  // In the shell, do NOT initialise until the session (user + permissions) has
  // actually arrived — otherwise a slow session postMessage causes a false
  // "Access Denied" that sticks even after the real session shows up.
  if (window.self !== window.top && !window.__MEP_USER__) return;
  _initCalled = true;
  init();
}
window.addEventListener('message', function(e) {
  if (!e.data || typeof e.data !== 'object') return;
  if (e.data.type === 'theme') applyTheme(e.data.theme);
  if (e.data.type === 'session') { window.__MEP_TOKEN__ = e.data.token; window.__MEP_USER__ = e.data.user; _tryInit(); }
});
if (window.self !== window.top) {
  document.body.classList.add('in-shell');
  try { window.parent.postMessage({ type:'child_ready' }, '*'); } catch(e) {}
  // Re-request the session periodically in case the first push was missed
  // (the shell re-sends it on child_ready). Hard fallback after ~12s so the
  // page never hangs if a session genuinely never comes.
  var _sessTries = 0;
  var _sessPoll = setInterval(function() {
    if (_initCalled || window.__MEP_USER__) { clearInterval(_sessPoll); return; }
    if (++_sessTries >= 24) { clearInterval(_sessPoll); _initCalled = true; init(); return; }
    try { window.parent.postMessage({ type:'child_ready' }, '*'); } catch(e) {}
  }, 500);
} else { _tryInit(); }

// ══════════════════════════════════════════════
// TELEGRAM NOTIFICATIONS
// ══════════════════════════════════════════════
function notifyTelegram(event, data) {
  // Fire-and-forget — never throws or blocks the caller
  fetch(`${SB}/functions/v1/telegram-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: JSON.stringify({ event, data })
  }).catch(() => {});
}

// ── PRINT: force group-header borders via inline styles (bypasses border-collapse quirks) ──
window.addEventListener('beforeprint', () => {
  document.querySelectorAll('.ps-table th.group-hdr').forEach(th => {
    th.style.setProperty('border', '2px solid #333', 'important');
    th.style.setProperty('border-top', '2.5px solid #000', 'important');
    th.style.setProperty('border-bottom', '2.5px solid #000', 'important');
    th.style.setProperty('background', '#e0e0e0', 'important');
    th.style.setProperty('position', 'static', 'important');
  });
});
window.addEventListener('afterprint', () => {
  document.querySelectorAll('.ps-table th.group-hdr').forEach(th => {
    th.style.removeProperty('border');
    th.style.removeProperty('border-top');
    th.style.removeProperty('border-bottom');
    th.style.removeProperty('background');
    th.style.removeProperty('position');
  });
});
