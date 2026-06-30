'use strict';
/* QUIC 비활성 상태에서 사이트 로드 실측. 실행: electron scripts/test-quic.js --disable-quic */
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

app.on('window-all-closed', () => {});

async function load(url, i) {
  const part = 'test:q' + i;
  const sess = session.fromPartition(part);
  sess.setUserAgent(UA);
  const w = new BrowserWindow({ show: false, webPreferences: { partition: part, sandbox: true } });
  let lastFail = 0, finished = false;
  w.webContents.on('did-fail-load', (e, code, desc, u, main) => { if (main) lastFail = code + ' ' + desc; });
  w.webContents.on('did-finish-load', () => { finished = true; });
  w.webContents.loadURL(url).catch(() => {});
  await new Promise((r) => setTimeout(r, 5000));
  if (!finished) { lastFail = lastFail + ' (재시도)'; w.webContents.reload(); }   // 첫 실패면 한 번 재시도
  await new Promise((r) => setTimeout(r, 8000));
  const res = { url, final: w.webContents.getURL(), title: w.webContents.getTitle(), finished, lastFail };
  w.destroy();
  return res;
}

app.whenReady().then(async () => {
  const out = { mode: app.commandLine.hasSwitch('disable-quic') ? 'QUIC OFF' : 'QUIC ON', results: [] };
  out.results.push(await load('https://www.naver.com/', 1));   // 대조군
  out.results.push(await load('https://www.chess.com/', 2));
  out.results.push(await load('https://www.youtube.com/', 3));
  fs.writeFileSync(path.join(__dirname, '..', '_quic.json'), JSON.stringify(out, null, 2));
  app.quit();
});
