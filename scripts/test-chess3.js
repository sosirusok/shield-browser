'use strict';
/* main.js 와 동일한 3회 재시도 로직으로 chess.com 로드 안정성 측정. 실행: electron scripts/test-chess3.js --disable-quic */
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'); const path = require('node:path');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
app.on('window-all-closed', () => {});

async function attempt(url, i) {
  const part = 'test:c3_' + i;
  const sess = session.fromPartition(part);
  sess.setUserAgent(UA);
  const w = new BrowserWindow({ show: false, webPreferences: { partition: part, sandbox: true } });
  const retry = {}; let finished = false; let lastFail = 0;
  w.webContents.on('did-finish-load', () => { finished = true; });
  w.webContents.on('did-fail-load', (e, code, desc, u, main) => {
    if (!main || code === -3) return;
    lastFail = code + ' ' + desc;
    const isCert = code <= -200 && code > -300;
    const tries = retry[u] || 0;
    if (!isCert && tries < 3 && u && !u.startsWith('data:')) {
      retry[u] = tries + 1;
      const delay = [500, 1200, 2400][tries] || 2400;
      setTimeout(() => { if (!w.webContents.isDestroyed()) w.webContents.loadURL(u); }, delay);
    }
  });
  w.webContents.loadURL(url).catch(() => {});
  await new Promise((r) => setTimeout(r, 16000));
  const res = { run: i, finished, retries: retry[url] || 0, lastFail, title: w.webContents.getTitle() };
  w.destroy();
  return res;
}

app.whenReady().then(async () => {
  const out = [];
  for (let i = 1; i <= 2; i++) out.push(await attempt('https://www.chess.com/', i));
  fs.writeFileSync(path.join(__dirname, '..', '_c3.json'), JSON.stringify(out, null, 2));
  app.quit();
});
