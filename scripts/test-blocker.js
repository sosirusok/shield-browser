'use strict';
/* 차단 엔진 검증 — electron 으로 실행: electron scripts/test-blocker.js
 * 알려진 광고/트래커 URL은 BLOCK, 정상 리소스는 ALLOW 되어야 한다. */
const { app } = require('electron');
const adblock = require('@ghostery/adblocker-electron');
const ElectronBlocker = adblock.ElectronBlocker;
const Request = adblock.Request || require('@ghostery/adblocker').Request;
const fs = require('node:fs');
const path = require('node:path');

app.whenReady().then(() => {
  const dir = path.join(__dirname, '..', 'filters');
  const text = ['easylist.txt', 'easyprivacy.txt']
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const blocker = ElectronBlocker.parse(text);

  const cases = [
    ['ad',      'https://www.googletagmanager.com/gtag/js',        'https://news.daum.net', 'script'],
    ['tracker', 'https://www.google-analytics.com/analytics.js',   'https://news.daum.net', 'script'],
    ['ad',      'https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'https://news.daum.net', 'script'],
    ['tracker', 'https://connect.facebook.net/en_US/fbevents.js',  'https://shop.example.com', 'script'],
    ['normal',  'https://news.daum.net/main.js',                   'https://news.daum.net', 'script'],
    ['normal',  'https://cdn.jsdelivr.net/npm/vue/dist/vue.js',    'https://app.example.com', 'script'],
  ];

  let pass = 0;
  for (const [kind, url, source, type] of cases) {
    const { match } = blocker.match(Request.fromRawDetails({ url, sourceUrl: source, type }));
    const expectBlock = kind !== 'normal';
    const ok = match === expectBlock;
    if (ok) pass++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${kind}] ${match ? 'BLOCK' : 'ALLOW'}  ${url}`);
  }
  console.log(`\n결과: ${pass}/${cases.length} 통과`);
  app.quit();
});
