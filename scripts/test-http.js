'use strict';
/* http/https 라우팅 실측 — 광고차단 ON 상태에서:
 *   - 명시적 http:// 링크는 http 로 그대로 로드되어야(선생님 사이트)
 *   - https 사이트는 정상
 * 결과를 _httpresult.json 에 기록(전자 stdout 버퍼링 회피). 실행: electron scripts/test-http.js */
const { app, BrowserWindow, session } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', '_httpresult.json');

app.on('window-all-closed', () => {});   // 테스트: 창 destroy 시 앱 자동종료 방지

app.whenReady().then(async () => {
  const sess = session.fromPartition('test:http');
  sess.webRequest.onBeforeSendHeaders((d, cb) => { const h = { ...d.requestHeaders }; h.DNT = '1'; h['Sec-GPC'] = '1'; cb({ requestHeaders: h }); });

  const dir = path.join(__dirname, '..', 'filters');
  const text = ['easylist.txt', 'easyprivacy.txt'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const blocker = ElectronBlocker.parse(text);
  let blocked = 0;
  blocker.on('request-blocked', () => { blocked++; });
  blocker.enableBlockingInSession(sess);   // 광고차단 ON → onBeforeRequest 등록(HTTPS 업그레이드와 충돌하던 그 지점)

  async function load(url) {
    const w = new BrowserWindow({ show: false, webPreferences: { partition: 'test:http', sandbox: true } });
    w.webContents.loadURL(url).catch(() => {});
    await new Promise((r) => setTimeout(r, 6000));
    const final = w.webContents.getURL();
    const title = w.webContents.getTitle();
    w.destroy();
    return { input: url, final, title };
  }

  const results = [];
  results.push(await load('http://httpforever.com'));   // 명시 http
  results.push(await load('https://example.com'));       // https 정상
  results.push({ blockedTotal: blocked });

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  app.quit();
});
