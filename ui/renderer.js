'use strict';
/* 브라우저 크롬(렌더러). window.shield = preload 브리지 */
const S = window.shield;

const $ = (id) => document.getElementById(id);
const tabsEl = $('tabs');
const urlInput = $('url');
const lockEl = $('lock');
const blockedEl = $('blocked');

const tabState = new Map();   // id -> {url,title,loading,canGoBack,canGoForward}
let activeId = null;
const tabNodes = new Map();   // id -> element

// ───────── 탭 DOM ─────────
function renderTab(id) {
  let el = tabNodes.get(id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'tab';
    el.innerHTML = `<span class="t-ico"></span><span class="t-title"></span><span class="t-close">✕</span>`;
    el.addEventListener('mouseup', (e) => {
      if (e.target.classList.contains('t-close')) { S.closeTab(id); }
      else if (e.button === 0) { S.activateTab(id); }
      else if (e.button === 1) { S.closeTab(id); }  // 가운데 클릭 닫기
    });
    tabNodes.set(id, el);
    tabsEl.appendChild(el);
  }
  const st = tabState.get(id) || {};
  el.classList.toggle('active', id === activeId);
  const titleEl = el.querySelector('.t-title');
  const icoEl = el.querySelector('.t-ico');
  titleEl.textContent = st.title || '새 탭';
  icoEl.innerHTML = st.loading ? '<span class="spin"></span>' : '';
}

function removeTab(id) {
  const el = tabNodes.get(id);
  if (el) el.remove();
  tabNodes.delete(id);
  tabState.delete(id);
}

function reflectActive() {
  const st = tabState.get(activeId) || {};
  const showUrl = st.url && st.url !== 'about:blank' ? st.url : '';
  if (document.activeElement !== urlInput) urlInput.value = showUrl;
  $('back').disabled = !st.canGoBack;
  $('forward').disabled = !st.canGoForward;
  lockEl.textContent = showUrl.startsWith('https://') ? '🔒' : (showUrl.startsWith('http://') ? '⚠' : '🔍');
  for (const id of tabNodes.keys()) renderTab(id);
}

// ───────── 메인 → 렌더러 이벤트 ─────────
S.on('tab:created', ({ id }) => { tabState.set(id, { title: '새 탭' }); renderTab(id); });
S.on('tab:updated', (meta) => { tabState.set(meta.id, { ...tabState.get(meta.id), ...meta }); renderTab(meta.id); if (meta.id === activeId) reflectActive(); });
S.on('tab:activated', (id) => {
  activeId = id; reflectActive();
  const st = tabState.get(id) || {};
  if (!st.url || st.url === 'about:blank') urlInput.focus();   // 새 탭/스피드다이얼이면 주소창에 바로 입력 가능
});
S.on('tab:closed', (id) => { removeTab(id); });
S.on('stats:blocked', (n) => { blockedEl.textContent = n; });

// ───────── 내비 동작 ─────────
function go() {
  const v = urlInput.value.trim();
  if (!v) return;
  S.navigate(activeId, v).then((ok) => { if (!ok) flashUrl(); });
  urlInput.blur();
}
function flashUrl() {
  urlInput.style.color = 'var(--danger)';
  setTimeout(() => urlInput.style.color = '', 600);
}

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') go();
  if (e.key === 'Escape') { reflectActive(); urlInput.blur(); }
});
urlInput.addEventListener('focus', () => urlInput.select());

$('back').onclick = () => S.back(activeId);
$('forward').onclick = () => S.forward(activeId);
$('reload').onclick = () => S.reload(activeId);
$('newtab').onclick = () => S.newTab();

// ───────── 오버레이(설정/기록) ─────────
const panel = $('panel');
const histpanel = $('histpanel');
const histlist = $('histlist');
let overlayOpen = false;

function showOverlay(el) { el.classList.remove('hidden'); overlayOpen = true; S.setPanel(true); }   // 페이지뷰 숨김
function closeOverlays() {
  panel.classList.add('hidden'); histpanel.classList.add('hidden');
  if (overlayOpen) { overlayOpen = false; S.setPanel(false); }
}

async function openPanel() {
  const s = await S.getSettings();
  $('opt-blockAds').checked = !!s.blockAds;
  $('opt-denyPermissions').checked = !!s.denyPermissions;
  histpanel.classList.add('hidden');
  showOverlay(panel);
}

function fmtTime(t) {
  const d = new Date(t);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
async function openHist() {
  const items = await S.getHistory();
  histlist.innerHTML = '';
  if (!items.length) {
    histlist.innerHTML = '<div class="hist-empty">아직 방문 기록이 없어요</div>';
  } else {
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'hist-row';
      row.dataset.url = it.url;
      row.innerHTML = '<span class="h-title"></span><span class="h-url"></span><span class="h-time"></span>';
      row.querySelector('.h-title').textContent = (it.title && it.title !== it.url) ? it.title : it.url;
      row.querySelector('.h-url').textContent = it.url;
      row.querySelector('.h-time').textContent = fmtTime(it.t);
      histlist.appendChild(row);
    }
  }
  panel.classList.add('hidden');
  showOverlay(histpanel);
}

$('menu').onclick = openPanel;
$('panel-close').onclick = closeOverlays;
$('hist-close').onclick = closeOverlays;
panel.addEventListener('mousedown', (e) => { if (e.target === panel) closeOverlays(); });
histpanel.addEventListener('mousedown', (e) => { if (e.target === histpanel) closeOverlays(); });
histlist.addEventListener('click', (e) => {
  const row = e.target.closest('.hist-row');
  if (!row) return;
  S.navigate(activeId, row.dataset.url);
  closeOverlays();
});
$('hist-clear').onclick = async () => { await S.clearHistory(); openHist(); };

const bind = (optId, key) => $(optId).addEventListener('change', (e) => S.setSettings({ [key]: e.target.checked }));
bind('opt-blockAds', 'blockAds');
bind('opt-denyPermissions', 'denyPermissions');

$('clear').onclick = async () => {
  await S.clearData();
  $('clear').textContent = '✓ 삭제됨';
  setTimeout(() => $('clear').textContent = '🧹 지금 바로 데이터 지우기', 1400);
};

// ───────── 키보드 단축키 ─────────
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (e.key === 'h' || e.key === 'H')) {   // 방문 기록 토글
    e.preventDefault();
    if (!histpanel.classList.contains('hidden')) closeOverlays(); else openHist();
    return;
  }
  // 오버레이가 열린 채 탭/뷰를 건드리면 페이지뷰가 덮어버리므로 먼저 닫는다
  if (overlayOpen && ((ctrl && (e.key === 't' || e.key === 'w' || e.key === 'l' || e.key === 'r')) || e.key === 'F5' || e.key === 'Escape')) {
    closeOverlays();
    if (e.key === 'Escape') { e.preventDefault(); return; }
  }
  if (ctrl && e.key === 't') { e.preventDefault(); S.newTab(); }
  else if (ctrl && e.key === 'w') { e.preventDefault(); if (activeId != null) S.closeTab(activeId); }
  else if (ctrl && e.key === 'l') { e.preventDefault(); urlInput.focus(); }
  else if (ctrl && e.key === 'r') { e.preventDefault(); S.reload(activeId); }
  else if (e.key === 'F5') { e.preventDefault(); S.reload(activeId); }
});

// 시작 시 차단 카운터 동기화
S.getStats().then((n) => blockedEl.textContent = n);
