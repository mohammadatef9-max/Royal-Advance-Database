/* =====================================================================
   shared.js - common globals for every dashboard page   (v1, Jun 2026)

   Load FIRST in <head>, before any page script:
     <script src="shared.js?v=1"></script>

   Pages with their OWN Esc-to-close block (qs.html, obs.html,
   obs_entry.html) must add data-no-esc to the tag:
     <script src="shared.js?v=1" data-no-esc></script>

   Provides:
     SB           - Supabase project URL
     KEY          - public anon key (safe to publish; RLS enforces access)
     sharedGetH() - canonical auth-headers helper for NEW pages
   ===================================================================== */
var SB  = 'https://tactslhsxglzcbsteokf.supabase.co';
var KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRhY3RzbGhzeGdsemNic3Rlb2tmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4MDY1MDgsImV4cCI6MjA5MjM4MjUwOH0.-L21MGuRx_CvcpPP9bAv415nIgPvXDaVXtRhTo1UZ1o';

/* Canonical auth-headers helper for new pages. Existing pages keep their
   own getH() on purpose - several differ deliberately (qs.html: no
   localStorage fallback; audit_log: page-managed token; keyplans: extra
   Prefer header). Do not "unify" them without testing each page. */
function sharedGetH(extra) {
  var token = window.__MEP_TOKEN__;
  if (!token) {
    try {
      var s = localStorage.getItem('mep_session');
      if (s) {
        var j = JSON.parse(s);
        if (j && j.access_token && j.expires_at && Date.now() < j.expires_at - 30000) token = j.access_token;
      }
    } catch (e) {}
  }
  return Object.assign(
    { 'apikey': KEY, 'Authorization': 'Bearer ' + (token || KEY), 'Content-Type': 'application/json' },
    extra || {}
  );
}

var __SHARED_NO_ESC = !!(document.currentScript && document.currentScript.hasAttribute('data-no-esc'));
if (!__SHARED_NO_ESC) {
/* ===== Global ESC-to-close for modals & popups — v6.4 ===== */
(function(){
  function vis(el){
    if(!el||el.nodeType!==1)return false;
    var cs=getComputedStyle(el);
    if(cs.display==='none'||cs.visibility==='hidden'||cs.visibility==='collapse'||parseFloat(cs.opacity)===0)return false;
    return el.getClientRects().length>0;
  }
  function clsOf(n){var c=n.className;if(c&&typeof c!=='string'&&'baseVal'in c)c=c.baseVal;return(c||'').toString().toLowerCase();}
  function dismisser(modal){
    var nodes=modal.querySelectorAll('button,a,span,div,i,[onclick],[data-close]'),i,n,cl,tx;
    for(i=0;i<nodes.length;i++){n=nodes[i];if(!vis(n))continue;cl=clsOf(n);tx=(n.textContent||'').trim().toLowerCase();
      if(/(^|[\s_-])close([\s_-]|$)/.test(cl)||n.hasAttribute('data-close')||tx==='cancel'||tx==='close'||tx==='✕'||tx==='×'||tx==='✖')return n;}
    for(i=0;i<nodes.length;i++){n=nodes[i];if(!vis(n))continue;
      if(/close|cancel|dismiss|hide/.test((n.getAttribute('onclick')||'').toLowerCase()))return n;}
    return null;
  }
  document.addEventListener('keydown',function(e){
    if(e.key!=='Escape'&&e.keyCode!==27&&e.which!==27)return;
    var sel='.modal-overlay,.modal-bg,.modal,.popup,.overlay,[class*="modal"],[id*="modal"],[id*="popup"],[id*="overlay"]';
    var all=document.querySelectorAll(sel),open=[],i;
    for(i=0;i<all.length;i++){if(vis(all[i]))open.push(all[i]);}
    if(!open.length)return;
    var outer=open.filter(function(el){return!open.some(function(o){return o!==el&&o.contains(el);});});
    var top=outer[outer.length-1]||open[open.length-1];
    e.preventDefault();e.stopPropagation();
    var btn=dismisser(top);
    if(btn){btn.click();return;}
    var toc=(top.getAttribute('onclick')||'').toLowerCase();
    if(/close|cancel|dismiss|hide/.test(toc)){top.click();if(!vis(top))return;}
    ['open','on','active','show','visible','shown','show-modal','is-open'].forEach(function(c){top.classList.remove(c);});
    if(vis(top))top.style.display='none';
  },true);
})();
}

/* =====================================================================
   Client error reporter - uncaught JS errors land in the client_errors
   table (authenticated sessions only; anon inserts are rejected by RLS).
   Fire-and-forget, capped at 5 reports per page load.
   View errors:  SELECT * FROM client_errors ORDER BY occurred_at DESC;
   ===================================================================== */
var __errReports = 0;
function __reportClientError(msg, stack) {
  try {
    if (__errReports >= 5) return;
    __errReports++;
    var u = window.__MEP_USER__ || {};
    fetch(SB + '/rest/v1/client_errors', {
      method: 'POST',
      headers: sharedGetH({ 'Prefer': 'return=minimal' }),
      keepalive: true,
      body: JSON.stringify({
        page: (location.pathname.split('/').pop() || 'index.html'),
        message: String(msg || 'unknown').slice(0, 500),
        stack: String(stack || '').slice(0, 2000),
        user_name: u.full_name || u.display_name || null,
        ua: navigator.userAgent.slice(0, 200)
      })
    }).catch(function () {});
  } catch (e) {}
}
window.addEventListener('error', function (e) {
  __reportClientError(e.message, e.error && e.error.stack);
});
window.addEventListener('unhandledrejection', function (e) {
  var r = e.reason || {};
  __reportClientError(r.message || String(r), r.stack);
});


/* =====================================================================
   Searchable combobox for long <select> dropdowns (activity/code lists).
   mepCombo('sel-id') hides the select and adds a type-to-search input
   backed by a <datalist>. Picking or fully typing an entry applies it
   (fires the select's change handlers); Enter applies the first
   substring match; clearing the box resets the filter.
   mepComboReset('sel-id') re-syncs the input text after code changes
   the select value programmatically (e.g. Clear filters).
   ===================================================================== */
function mepCombo(selId, opts) {
  opts = opts || {};
  var sel = document.getElementById(selId);
  if (!sel || sel._combo) return;
  sel._combo = true;
  var inp = document.createElement('input');
  var dl = document.createElement('datalist');
  dl.id = selId + '-dl';
  inp.id = selId + '-combo';
  inp.type = 'text';
  inp.setAttribute('list', dl.id);
  inp.autocomplete = 'off';
  inp.placeholder = opts.placeholder || (sel.options[0] ? sel.options[0].textContent : 'Type to search...');
  inp.className = sel.className;
  if (!inp.className) inp.style.cssText = 'background:var(--bg-elev,#11151c);color:var(--text,#e6e9ef);border:1px solid var(--border,#1e2531);border-radius:7px;padding:6px 10px;font-size:12px;font-family:inherit;outline:none;';
  inp.style.minWidth = opts.width || '210px';
  sel.style.display = 'none';
  sel.parentNode.insertBefore(inp, sel);
  sel.parentNode.insertBefore(dl, sel);
  sel._comboInput = inp;
  function fill() {
    var h = '';
    for (var i = 0; i < sel.options.length; i++) {
      var o = sel.options[i];
      if (o.value !== '') h += '<option value="' + String(o.textContent).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"></option>';
    }
    dl.innerHTML = h;
  }
  function apply(v) {
    if (sel.value !== v) { sel.value = v; try { sel.dispatchEvent(new Event('change')); } catch (e) {} }
  }
  inp.addEventListener('focus', function () {
    fill();
    if (sel.value) {
      var cur = sel.options[sel.selectedIndex];
      if (cur && inp.value !== cur.textContent) inp.value = cur.textContent;
    }
  });
  inp.addEventListener('input', function () {
    var v = (inp.value || '').trim().toLowerCase();
    if (!v) { apply(''); return; }
    for (var i = 0; i < sel.options.length; i++) {
      var o = sel.options[i];
      if (o.value !== '' && o.textContent.trim().toLowerCase() === v) { apply(o.value); return; }
    }
  });
  inp.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var q = (inp.value || '').trim().toLowerCase();
    if (!q) return;
    for (var i = 0; i < sel.options.length; i++) {
      var o = sel.options[i];
      if (o.value !== '' && o.textContent.toLowerCase().indexOf(q) >= 0) {
        inp.value = o.textContent.trim();
        apply(o.value);
        break;
      }
    }
  });
}
function mepComboReset(selId) {
  var sel = document.getElementById(selId);
  if (!sel || !sel._comboInput) return;
  var cur = sel.value ? sel.options[sel.selectedIndex] : null;
  sel._comboInput.value = cur ? cur.textContent.trim() : '';
}