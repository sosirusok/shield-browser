'use strict';

/*
 * Shield Browser — main process
 *
 * 구조
 *  - 창의 메인 webContents = 브라우저 "크롬"(상단 툴바/탭바)  →  ui/index.html
 *  - 각 탭 = WebContentsView (win.contentView 위에 겹쳐 올림). 활성 탭만 보임.
 *  - 광고/트래커 차단 = @ghostery/adblocker-electron (EasyList + EasyPrivacy 프리빌트)
 *  - 프라이버시 하드닝 = 권한 기본거부, DNT/GPC 헤더, WebRTC IP 누출 차단,
 *    텔레메트리/구글서비스 비활성화, 깨끗한 UA로 핑거프린트 표면 축소
 *  - http/https 둘 다 지원. 베어 도메인은 https 우선 시도 후 실패하면 http 자동 폴백
 *    (선생님들의 http 수업 사이트도 열림). 명시적 http:// 링크는 그대로 http 로 로드.
 *
 * ※ 이 앱은 "웹사이트/광고사로부터의" 프라이버시를 보호합니다.
 *   기기 소유자(학교 등)가 OS 관리자 권한으로 설치한 모니터링은 우회하지 않습니다 — 원리상 불가하며 의도하지도 않음.
 */

const { app, BrowserWindow, WebContentsView, session, ipcMain, shell, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// ───────────────────────────── 저메모리 / 프라이버시 런타임 플래그 (app ready 이전 필수) ─────────────────────────────
app.commandLine.appendSwitch('disable-features', [
  'OptimizationGuideModelDownloading',
  'OptimizationHints',
  'Translate',
  'MediaRouter',
  'DialMediaRouteProvider',
  'AutofillServerCommunication',
  'CalculateNativeWinOcclusion',
].join(','));
app.commandLine.appendSwitch('disable-domain-reliability');     // 구글 도메인 신뢰성 텔레메트리 끄기
app.commandLine.appendSwitch('disable-breakpad');               // 크래시 리포트 전송 끄기
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512'); // 저RAM 보호

const TOOLBAR_HEIGHT = 88;          // 탭바(36) + 내비/주소창(52)
const PARTITION = 'persist:web';    // 웹 콘텐츠용 영속 파티션(쿠키/로그인 유지)
const USERDATA = () => app.getPath('userData');
const SETTINGS_PATH = () => path.join(USERDATA(), 'settings.json');

// 깨끗한(흔한) UA — 핑거프린트로 튀지 않게. Electron/앱 토큰 제거.
const CLEAN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ───────────────────────────── 설정 ─────────────────────────────
const DEFAULT_SETTINGS = {
  blockAds: true,
  denyPermissions: true,
  eraseOnExit: false,
};
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH(), 'utf8');
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* 최초 실행 */ }
}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(settings, null, 2)); } catch {}
}

// ───────────────────────────── 광고/트래커 차단 ─────────────────────────────
let blocker = null;
let blockedTotal = 0;
let blockedDirty = false;

// 필터는 로컬 번들(filters/)에서 읽는다.
// 학교망이 raw.githubusercontent.com 을 차단하므로 런타임 CDN 의존을 없앰.
const FILTER_FILES = ['easylist.txt', 'easyprivacy.txt'];
const FILTER_MIRRORS = [
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
];

function filtersDir() {
  const packaged = path.join(process.resourcesPath || '', 'filters');
  if (fs.existsSync(packaged)) return packaged;        // 패키징(asar 외부) 시
  return path.join(__dirname, '..', 'filters');        // 개발 시
}

async function setupAdblock(sess) {
  const { ElectronBlocker } = require('@ghostery/adblocker-electron');
  const dir = filtersDir();
  const files = FILTER_FILES.map((f) => path.join(dir, f));
  const cachePath = path.join(USERDATA(), 'adblock-engine.bin');
  const keyPath = path.join(USERDATA(), 'adblock-engine.key');

  // 캐시 키 = 필터 파일 크기 조합 (바뀌면 재파싱)
  let key = '';
  try { key = files.map((f) => fs.statSync(f).size).join('-'); } catch {}

  // 1) 직렬화 캐시가 유효하면 빠르게 복원
  if (key) {
    try {
      if (fs.readFileSync(keyPath, 'utf8') === key) {
        blocker = ElectronBlocker.deserialize(fs.readFileSync(cachePath));
      }
    } catch { blocker = null; }
  }

  // 2) 캐시 없으면 로컬 번들 파싱, 그래도 없으면 미러에서 1회 fetch(Chromium 스택)
  if (!blocker) {
    let text = '';
    try {
      text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    } catch {
      const { net } = require('electron');
      const parts = [];
      for (const u of FILTER_MIRRORS) { const r = await net.fetch(u); parts.push(await r.text()); }
      text = parts.join('\n');
    }
    blocker = ElectronBlocker.parse(text);
    try {
      if (key) {                          // bin 과 key 는 항상 함께 저장(정합성)
        fs.writeFileSync(cachePath, Buffer.from(blocker.serialize()));
        fs.writeFileSync(keyPath, key);
      }
    } catch {}
  }

  // 차단 카운터는 즉시 증가시키되, 렌더러 통지는 스로틀(저RAM에서 IPC 폭주 방지)
  blocker.on('request-blocked', () => { blockedTotal++; blockedDirty = true; });
  setAdblockEnabled(sess, settings.blockAds);
}

function setAdblockEnabled(sess, enabled) {
  if (!blocker) return;
  try {
    if (enabled) blocker.enableBlockingInSession(sess);
    else blocker.disableBlockingInSession(sess);   // 미활성 상태면 throw → 무시
  } catch {}
}

// ───────────────────────────── 프라이버시 하드닝 ─────────────────────────────
// https 우선→실패 시 http 폴백 상태 (광고차단 onBeforeRequest 와 충돌하지 않도록 내비게이션 단에서만 처리)
const noUpgradeHosts = new Set();   // https 가 안 돼 http 로 고정한 호스트(세션 내 재시도 생략)
const upgradedFrom = new Map();     // 자동 https URL -> 폴백할 http URL

function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }

function hardenSession(sess) {
  sess.setUserAgent(CLEAN_UA);

  // DNT + Global Privacy Control 헤더 추가 (onBeforeSendHeaders — 광고차단과 다른 이벤트라 충돌 없음)
  sess.webRequest.onBeforeSendHeaders((details, cb) => {
    const headers = { ...details.requestHeaders };
    headers['DNT'] = '1';
    headers['Sec-GPC'] = '1';
    cb({ requestHeaders: headers });
  });

  // 권한 기본 거부(위치/알림/카메라/마이크 등). 전체화면만 허용.
  sess.setPermissionRequestHandler((wc, permission, callback) => {
    if (!settings.denyPermissions) return callback(true);
    callback(permission === 'fullscreen');
  });
  sess.setPermissionCheckHandler((wc, permission) => {
    if (!settings.denyPermissions) return true;
    return permission === 'fullscreen';
  });
}

async function clearAllData(sess) {
  await sess.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage', 'shadercache'],
  });
  await sess.clearCache();
  blockedTotal = 0;
  if (win && !win.isDestroyed()) win.webContents.send('stats:blocked', blockedTotal);
}

// ───────────────────────────── 탭 관리 ─────────────────────────────
let win = null;
const tabs = new Map();   // id -> { id, view }
let activeId = null;
let nextId = 1;

function pageBounds() {
  if (!win) return { x: 0, y: TOOLBAR_HEIGHT, width: 800, height: 600 };
  const [w, h] = win.getContentSize();
  return { x: 0, y: TOOLBAR_HEIGHT, width: w, height: Math.max(0, h - TOOLBAR_HEIGHT) };
}

function relayout() {
  const t = tabs.get(activeId);
  if (t) t.view.setBounds(pageBounds());
}

function sendTabUpdate(id) {
  const t = tabs.get(id);
  if (!t || !win || win.isDestroyed()) return;
  const wc = t.view.webContents;
  let url = wc.getURL();
  if (url.startsWith('data:')) url = t.errURL || '';   // 에러페이지 data:URL 은 감추고 실패한 원래 URL 표시
  win.webContents.send('tab:updated', {
    id,
    url,
    title: wc.getTitle() || url,
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  });
}

function createTab(input) {
  if (!win || win.isDestroyed()) return;
  const id = nextId++;
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webSecurity: true,
      backgroundThrottling: true,   // 비활성 탭 자원 절약
    },
  });
  const tab = { id, view, errURL: '' };
  const wc = view.webContents;
  wc.setWebRTCIPHandlingPolicy('default_public_interface_only'); // 로컬 IP 누출 차단

  // target=_blank / window.open — http(s)만 새 탭, 안전 스킴만 OS로, 그 외(file:/ms-*/임의)는 무시
  wc.setWindowOpenHandler(({ url }) => {
    try {
      const proto = new URL(url).protocol;
      if (proto === 'http:' || proto === 'https:') createTab(url);
      else if (proto === 'mailto:' || proto === 'tel:') shell.openExternal(url);
      // file:, smb:, ms-*:, 기타 임의 스킴은 무시(OS 핸들러 실행 차단)
    } catch { /* 잘못된 URL 무시 */ }
    return { action: 'deny' };
  });

  const update = () => sendTabUpdate(id);
  wc.on('did-start-loading', update);
  wc.on('did-stop-loading', update);
  wc.on('did-navigate', () => { if (!wc.getURL().startsWith('data:')) tab.errURL = ''; update(); });
  wc.on('did-navigate-in-page', update);
  wc.on('page-title-updated', update);
  wc.on('did-fail-load', (e, code, desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = ERR_ABORTED(무시)
    // 자동 https 가 실패한 거면 원래 http 로 자동 폴백 (선생님 http 사이트 등)
    if (validatedURL.startsWith('https://') && upgradedFrom.has(validatedURL)) {
      const orig = upgradedFrom.get(validatedURL);
      upgradedFrom.delete(validatedURL);
      const h = hostOf(orig); if (h) noUpgradeHosts.add(h);
      wc.loadURL(orig);
      return;
    }
    tab.errURL = validatedURL;   // 주소창엔 data:URL 대신 실패한 원래 URL 표시
    wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorPage(validatedURL, desc, code)));
  });

  tabs.set(id, tab);
  win.contentView.addChildView(view);
  view.setVisible(false);

  win.webContents.send('tab:created', { id });
  activateTab(id);
  if (!input || input === 'about:blank' || !loadResolved(wc, input)) wc.loadURL('about:blank');
  return id;
}

function activateTab(id) {
  if (!win || win.isDestroyed() || !tabs.has(id)) return;
  for (const [tid, t] of tabs) t.view.setVisible(tid === id);
  activeId = id;
  relayout();
  win.webContents.send('tab:activated', id);
  sendTabUpdate(id);
}

function closeTab(id) {
  if (!win || win.isDestroyed()) return;
  const t = tabs.get(id);
  if (!t) return;
  win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  tabs.delete(id);
  win.webContents.send('tab:closed', id);
  if (activeId === id) {
    const remaining = [...tabs.keys()];
    if (remaining.length) activateTab(remaining[remaining.length - 1]);
    else { activeId = null; createTab('about:blank'); }
  }
}

// URL 정규화 — 검색 엔진 없음. URL 같으면 이동, 아니면 null.
function normalizeURL(input) {
  const s = (input || '').trim();
  if (!s) return null;
  if (/^(https?|file|about):/i.test(s)) return s;                 // 명시 스킴 그대로 (http 는 http!)
  if (/^[a-z][a-z0-9+.\-]*:/i.test(s)) return null;              // 그 외 스킴(ftp:/javascript:/chrome:/data: 등) 거부
  // 로컬호스트 / 루프백(IPv4·IPv6) → http
  if (/^(localhost|127(\.\d{1,3}){3}|\[[0-9a-f:]+\])([:/]|$)/i.test(s)) return 'http://' + s;
  if (/^[^\s/]+\.[^\s/]{2,}/.test(s)) return 'https://' + s;      // 도메인.tld → https 우선
  return null;                                                    // 검색어로 보이면 이동 안 함
}

// 내비게이션 해석 — https 우선 + http 폴백 등록. 입력에 스킴이 있으면 폴백 없음.
function resolveNavigation(input) {
  const url = normalizeURL(input);
  if (!url) return null;
  const hadScheme = /^[a-z][a-z0-9+.\-]*:/i.test(String(input).trim());
  if (url.startsWith('https://') && !hadScheme) {
    const host = hostOf(url);
    if (host && noUpgradeHosts.has(host)) {                       // 이번 세션에 https 실패한 호스트면 바로 http
      return { url: 'http://' + url.slice('https://'.length), fallback: null };
    }
    return { url, fallback: 'http://' + url.slice('https://'.length) };
  }
  return { url, fallback: null };
}

function loadResolved(wc, input) {
  const r = resolveNavigation(input);
  if (!r) return false;
  if (r.fallback) upgradedFrom.set(r.url, r.fallback);
  wc.loadURL(r.url);
  return true;
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function errorPage(url, desc, code) {
  const safe = escHtml(url);
  const httpAlt = url && url.startsWith('https://') ? 'http://' + url.slice('https://'.length) : '';
  return `<!doctype html><meta charset="utf-8"><title>열 수 없음</title>
  <style>body{font:15px system-ui;background:#0f1115;color:#cdd3de;display:grid;place-items:center;height:100vh;margin:0}
  .b{max-width:460px;text-align:center}.u{color:#7aa2f7;word-break:break-all;margin:6px 0}
  small{color:#6b7280}a{display:inline-block;margin:14px 8px 0;color:#9ece6a;text-decoration:none;
  border:1px solid #2b3a22;padding:8px 16px;border-radius:8px}a:hover{background:#9ece6a1a}</style>
  <div class="b"><h2>페이지를 열 수 없어요</h2><p class="u">${safe}</p>
  <small>${escHtml(desc)}${code ? ' (' + code + ')' : ''}</small><br>
  <a href="${safe}">↻ 다시 시도</a>${httpAlt ? `<a href="${escHtml(httpAlt)}">http로 열기</a>` : ''}</div>`;
}

// ───────────────────────────── IPC ─────────────────────────────
function registerIPC(sess) {
  ipcMain.handle('tab:new', (e, url) => createTab(url || 'about:blank'));
  ipcMain.handle('tab:close', (e, id) => closeTab(id));
  ipcMain.handle('tab:activate', (e, id) => activateTab(id));
  ipcMain.handle('tab:navigate', (e, { id, url }) => {
    const t = tabs.get(id); if (!t) return false;
    return loadResolved(t.view.webContents, url);
  });
  ipcMain.handle('tab:back', (e, id) => { const t = tabs.get(id); if (t && t.view.webContents.navigationHistory.canGoBack()) t.view.webContents.navigationHistory.goBack(); });
  ipcMain.handle('tab:forward', (e, id) => { const t = tabs.get(id); if (t && t.view.webContents.navigationHistory.canGoForward()) t.view.webContents.navigationHistory.goForward(); });
  ipcMain.handle('tab:reload', (e, id) => { const t = tabs.get(id); if (t) t.view.webContents.reload(); });
  ipcMain.handle('tab:stop', (e, id) => { const t = tabs.get(id); if (t) t.view.webContents.stop(); });

  // 설정 패널/메뉴 열릴 때 활성 페이지뷰 숨김(크롬 오버레이가 보이도록)
  ipcMain.handle('ui:panel', (e, open) => { const t = tabs.get(activeId); if (t) t.view.setVisible(!open); });

  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (e, patch) => {
    settings = { ...settings, ...patch };
    saveSettings();
    if ('blockAds' in patch) setAdblockEnabled(sess, settings.blockAds);
    return settings;
  });
  ipcMain.handle('privacy:clear', async () => { await clearAllData(sess); return true; });
  ipcMain.handle('privacy:stats', () => blockedTotal);
}

// ───────────────────────────── 앱 부팅 ─────────────────────────────
async function boot() {
  loadSettings();
  app.userAgentFallback = CLEAN_UA;
  nativeTheme.themeSource = 'dark';

  const sess = session.fromPartition(PARTITION);
  hardenSession(sess);
  try { await setupAdblock(sess); }
  catch (err) { console.error('[adblock] 초기화 실패(차단 없이 계속):', err.message); }

  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 680, minHeight: 480,
    backgroundColor: '#0f1115',
    title: 'Shield',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();

  // 크롬(메인) 창은 ui/index.html 밖으로 못 나가게 고정(심층방어)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, u) => { if (!u.startsWith('file://')) e.preventDefault(); });

  registerIPC(sess);

  // 차단 카운터를 주기적으로만 렌더러에 통지(스로틀)
  const statsTimer = setInterval(() => {
    if (blockedDirty && win && !win.isDestroyed()) {
      win.webContents.send('stats:blocked', blockedTotal);
      blockedDirty = false;
    }
  }, 300);

  win.webContents.on('did-finish-load', () => createTab('about:blank'));
  win.on('resize', relayout);
  win.on('closed', () => { clearInterval(statsTimer); win = null; });

  await win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
}

app.whenReady().then(boot);

app.on('before-quit', async (e) => {
  if (settings.eraseOnExit) {
    e.preventDefault();
    try { await clearAllData(session.fromPartition(PARTITION)); } catch {}
    app.exit(0);
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) boot(); });

// 보안: 외부에서 새 webContents가 비정상 생성되지 않도록
app.on('web-contents-created', (e, wc) => {
  wc.on('will-attach-webview', (evt) => evt.preventDefault()); // <webview> 비활성
});
