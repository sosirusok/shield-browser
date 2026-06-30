'use strict';
/* 최종 확인: 스피드다이얼 렌더 + chess.com(QUIC off+재시도+UA134) 로드. 실행: electron scripts/test-final.js --disable-quic */
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const NEWTAB = path.join(__dirname, '..', 'ui', 'newtab.html');
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const out = {};

  const w1 = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await w1.loadFile(NEWTAB);
  out.newtab = {
    title: w1.webContents.getTitle(),
    tiles: await w1.webContents.executeJavaScript("document.querySelectorAll('.tile').length"),
    names: await w1.webContents.executeJavaScript("[...document.querySelectorAll('.label')].map(e=>e.textContent).join(', ')"),
  };
  w1.destroy();

  const sess = session.fromPartition('test:final');
  sess.setUserAgent(UA);
  const w2 = new BrowserWindow({ show: false, webPreferences: { partition: 'test:final', sandbox: true } });
  let finished = false, retried = false; const retry = {};
  w2.webContents.on('did-finish-load', () => { finished = true; });
  w2.webContents.on('did-fail-load', (e, code, desc, u, main) => {
    if (!main || code === -3) return;
    const isCert = code <= -200 && code > -300;
    if (!isCert && !retry[u]) { retry[u] = 1; retried = true; setTimeout(() => { if (!w2.webContents.isDestroyed()) w2.webContents.loadURL(u); }, 500); }
  });
  w2.webContents.loadURL('https://www.chess.com/').catch(() => {});
  await new Promise((r) => setTimeout(r, 13000));
  out.chess = { final: w2.webContents.getURL(), title: w2.webContents.getTitle(), finished, retried };
  w2.destroy();

  fs.writeFileSync(path.join(__dirname, '..', '_final.json'), JSON.stringify(out, null, 2));
  app.quit();
});
