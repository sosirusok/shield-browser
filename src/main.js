'use strict';

/*
 * Shield Browser — main process
 *
 * 구조
 *  - 창의 메인 webContents = 브라우저 "크롬"(상단 툴바/탭바)  →  ui/index.html (제목표시줄 없음)
 *  - 각 탭 = WebContentsView (win.contentView 위에 겹쳐 올림). 활성 탭만 보임.
 *  - 광고/트래커 차단 = @ghostery/adblocker-electron (EasyList + EasyPrivacy 프리빌트)
 *  - 새 탭/첫 화면 = ui/newtab.html (바로가기 스피드다이얼). 흰 화면 대신.
 *
 * 프라이버시(이 노트북에 대한):
 *  - 세션은 메모리 전용(비영속) — 쿠키/스토리지/캐시를 디스크에 남기지 않음. 종료하면 전부 사라짐.
 *    → 자동 로그인/방문 흔적이 노트북에 안 남음(매번 새 시작). 광고차단·DNT/GPC·권한 기본거부 유지.
 *  - 깨끗한 UA(실제 Chromium 버전과 일치)로 핑거프린트 표면 축소, 텔레메트리/구글서비스 off.
 *
 * 접속성:
 *  - http/https 둘 다. 베어 도메인은 기본 http 로 엶(선생님 http 사이트 등). https 사이트는 서버가 알아서 https 로 리다이렉트.
 *  - QUIC(HTTP/3) 비활성 — 학교망이 UDP/QUIC 을 막아 생기는 접속 실패(chess.com 등) 회피, TCP 로만 연결.
 *  - 메인프레임 연결 실패는 1회 자동 재시도(학교망의 일시적 TLS 끊김 흡수).
 *
 * ※ "웹사이트/광고사로부터의" 프라이버시 + 노트북 디스크 흔적 최소화용.
 *   기기 소유자(학교)가 OS 관리자 권한으로 설치한 모니터링이나 통신사/기관의 망 차단은 우회하지 않음 — 원리상 불가하며 의도하지도 않음.
 */

const { app, BrowserWindow, WebContentsView, session, ipcMain, shell, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// ───────────────────────────── 저메모리 / 프라이버시 / 접속성 런타임 플래그 (app ready 이전 필수) ─────────────────────────────
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
app.commandLine.appendSwitch('disable-quic');                   // QUIC(HTTP/3) 끄기 — 학교망 UDP 차단으로 인한 접속 실패 회피
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512'); // 저RAM 보호

const TOOLBAR_HEIGHT = 88;          // 탭바(36) + 내비/주소창(52)
const PARTITION = 'shieldweb';      // 비영속(메모리 전용) 파티션 — 디스크에 흔적 안 남김
const USERDATA = () => app.getPath('userData');
const SETTINGS_PATH = () => path.join(USERDATA(), 'settings.json');
const NEWTAB = path.join(__dirname, '..', 'ui', 'newtab.html');   // 스피드다이얼(새 탭)

// 깨끗한 UA — 실제 Chromium(Electron 35 = Chrome 134)과 버전 일치 → 봇 차단/핑거프린트 튐 방지, 크롬 사용자와 블렌딩.
const CLEAN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

// ───────────────────────────── 설정 ─────────────────────────────
const DEFAULT_SETTINGS = {
  blockAds: true,
  denyPermissions: true,
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
const tabs = new Map();   // id -> { id, view, errURL, retry }
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
  if (url.startsWith('data:')) url = t.errURL || '';                  // 에러페이지 data:URL → 실패한 원래 URL
  else if (url === 'about:blank' || url.includes('newtab.html')) url = '';  // 스피드다이얼/빈 탭 → 주소창 빈칸
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
  const tab = { id, view, errURL: '', retry: {} };
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
  wc.on('did-navigate', () => { const u = wc.getURL(); if (!u.startsWith('data:')) { tab.errURL = ''; tab.retry = {}; } update(); });
  wc.on('did-navigate-in-page', update);
  wc.on('page-title-updated', update);
  wc.on('did-fail-load', (e, code, desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return;          // -3 = ERR_ABORTED(무시)
    const isCert = code <= -200 && code > -300;        // 인증서 오류(-2xx)는 보안상 재시도 안 함
    const tries = tab.retry[validatedURL] || 0;
    if (!isCert && tries < 1 && validatedURL && !validatedURL.startsWith('data:')) {
      tab.retry[validatedURL] = tries + 1;             // 학교망 일시적 끊김(SSL/연결) 흡수: 1회 자동 재시도
      setTimeout(() => { if (!wc.isDestroyed()) wc.loadURL(validatedURL); }, 500);
      return;
    }
    tab.errURL = validatedURL;                         // 주소창엔 data:URL 대신 실패한 원래 URL 표시
    wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorPage(validatedURL, desc, code)));
  });

  tabs.set(id, tab);
  win.contentView.addChildView(view);
  view.setVisible(false);

  win.webContents.send('tab:created', { id });
  activateTab(id);
  if (!input || input === 'about:blank' || !loadResolved(wc, input)) wc.loadFile(NEWTAB);  // 빈 입력 → 스피드다이얼
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
    else { activeId = null; createTab(); }
  }
}

// URL 정규화 — 검색 엔진 없음. URL 같으면 이동, 아니면 null. 베어 도메인은 기본 http.
function normalizeURL(input) {
  const s = (input || '').trim();
  if (!s) return null;
  if (/^(https?|file|about):/i.test(s)) return s;                 // 명시 스킴 그대로
  if (/^[a-z][a-z0-9+.\-]*:/i.test(s)) return null;              // 그 외 스킴(ftp:/javascript:/chrome:/data: 등) 거부
  if (/^(localhost|127(\.\d{1,3}){3}|\[[0-9a-f:]+\])([:/]|$)/i.test(s)) return 'http://' + s;  // 로컬/루프백
  if (/^[^\s/]+\.[^\s/]{2,}/.test(s)) return 'http://' + s;       // 도메인.tld → 기본 http (https 사이트는 서버가 리다이렉트)
  return null;                                                    // 검색어로 보이면 이동 안 함
}

function loadResolved(wc, input) {
  const url = normalizeURL(input);
  if (!url) return false;
  wc.loadURL(url);
  return true;
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function errorPage(url, desc, code) {
  const safe = escHtml(url);
  let alt = '';
  if (url && url.startsWith('https://')) alt = 'http://' + url.slice('https://'.length);
  else if (url && url.startsWith('http://')) alt = 'https://' + url.slice('http://'.length);
  const altLabel = alt.startsWith('https://') ? 'https로 열기' : 'http로 열기';
  return `<!doctype html><meta charset="utf-8"><title>열 수 없음</title>
  <style>body{font:15px system-ui;background:#0f1115;color:#cdd3de;display:grid;place-items:center;height:100vh;margin:0}
  .b{max-width:460px;text-align:center}.u{color:#7aa2f7;word-break:break-all;margin:6px 0}
  small{color:#6b7280}a{display:inline-block;margin:14px 8px 0;color:#9ece6a;text-decoration:none;
  border:1px solid #2b3a22;padding:8px 16px;border-radius:8px}a:hover{background:#9ece6a1a}</style>
  <div class="b"><h2>페이지를 열 수 없어요</h2><p class="u">${safe}</p>
  <small>${escHtml(desc)}${code ? ' (' + code + ')' : ''}</small><br>
  <a href="${safe}">↻ 다시 시도</a>${alt ? `<a href="${escHtml(alt)}">${altLabel}</a>` : ''}</div>`;
}

// ───────────────────────────── IPC ─────────────────────────────
function registerIPC(sess) {
  ipcMain.handle('tab:new', (e, url) => createTab(url));
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

  const sess = session.fromPartition(PARTITION);   // 메모리 전용(비영속)
  hardenSession(sess);
  try { await setupAdblock(sess); }
  catch (err) { console.error('[adblock] 초기화 실패(차단 없이 계속):', err.message); }

  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 680, minHeight: 480,
    backgroundColor: '#0f1115',
    title: 'Shield',
    icon: path.join(__dirname, '..', 'assets', 'shield.ico'),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',                                        // OS 제목표시줄 제거 → 화면 공간 회복
    titleBarOverlay: { color: '#171a21', symbolColor: '#cdd3de', height: 36 }, // 최소/최대/닫기 버튼은 탭바에 겹쳐 유지
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

  win.webContents.on('did-finish-load', () => createTab());   // 첫 탭 = 스피드다이얼
  win.on('resize', relayout);
  win.on('closed', () => { clearInterval(statsTimer); win = null; });

  await win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
}

app.whenReady().then(boot);

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) boot(); });

// 보안: 외부에서 새 webContents가 비정상 생성되지 않도록
app.on('web-contents-created', (e, wc) => {
  wc.on('will-attach-webview', (evt) => evt.preventDefault()); // <webview> 비활성
});
