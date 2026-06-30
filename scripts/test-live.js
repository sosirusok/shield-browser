'use strict';
/* 실측 차단 검증 — 실제 페이지를 숨겨서 로드하고 차단된 요청 수를 센다.
 * 실행: electron scripts/test-live.js [url] */
const { app, BrowserWindow, session } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const fs = require('node:fs');
const path = require('node:path');

app.whenReady().then(async () => {
  const sess = session.fromPartition('test:live');
  const dir = path.join(__dirname, '..', 'filters');
  const text = ['easylist.txt', 'easyprivacy.txt']
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

  const blocker = ElectronBlocker.parse(text);
  let blocked = 0;
  const sample = [];
  blocker.on('request-blocked', (req) => {
    blocked++;
    if (sample.length < 8) sample.push(req.url);
  });
  blocker.enableBlockingInSession(sess);   // ← Electron 35 에서 throw 없이 동작해야 함

  const win = new BrowserWindow({ show: false, webPreferences: { partition: 'test:live', sandbox: true } });
  const url = process.argv.find((a) => a.startsWith('http')) || 'https://www.daum.net';
  console.log('로딩:', url);
  win.webContents.loadURL(url).catch((e) => console.log('load err:', e.message)); // 블로킹하지 않음
  await new Promise((r) => setTimeout(r, 9000));   // 고정 대기(로드가 멈춰도 진행)

  console.log('\n차단된 광고/트래커 요청:', blocked, '개');
  sample.forEach((u) => console.log('  ✗', u.slice(0, 90)));
  app.quit();
});
