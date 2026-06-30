'use strict';
/* 스피드다이얼이 해시로 받은 바로가기 목록을 렌더하는지(사용자 추가 항목 포함) 확인. 실행: electron scripts/test-st.js */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const path = require('node:path');
app.on('window-all-closed', () => {});
const NEWTAB = path.join(__dirname, '..', 'ui', 'newtab.html');
app.whenReady().then(async () => {
  const scs = [
    { name: '네이버', url: 'https://www.naver.com', color: '#03C75A', mark: 'N' },
    { name: '내 블로그', url: 'example.org' },          // 스킴 없는 커스텀 → http 자동, 마크/색 자동
  ];
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await w.loadFile(NEWTAB, { hash: encodeURIComponent(JSON.stringify(scs)) });
  await new Promise((r) => setTimeout(r, 800));
  const out = {
    tiles: await w.webContents.executeJavaScript("document.querySelectorAll('.tile').length"),
    labels: await w.webContents.executeJavaScript("[...document.querySelectorAll('.label')].map(e=>e.textContent).join('|')"),
    marks: await w.webContents.executeJavaScript("[...document.querySelectorAll('.badge')].map(e=>e.textContent).join('|')"),
    hrefs: await w.webContents.executeJavaScript("[...document.querySelectorAll('.tile')].map(a=>a.getAttribute('href')).join('|')"),
  };
  fs.writeFileSync(path.join(__dirname, '..', '_st.json'), JSON.stringify(out, null, 2));
  app.quit();
});
