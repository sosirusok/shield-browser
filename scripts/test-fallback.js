'use strict';
/* HTTPS 업그레이드 + 폴백 검증 (main.js 와 동일 로직).
 * 실행: electron scripts/test-fallback.js */
const { app, BrowserWindow, session } = require('electron');

const noUpgradeHosts = new Set();
const upgradedFrom = new Map();
const isLocalHost = (h) => /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(h || '');

function attach(sess) {
  sess.webRequest.onBeforeRequest((details, cb) => {
    if (details.resourceType === 'mainFrame' && details.url.startsWith('http://')) {
      try {
        const host = new URL(details.url).hostname;
        if (!isLocalHost(host) && !noUpgradeHosts.has(host)) {
          const https = 'https://' + details.url.slice(7);
          upgradedFrom.set(https, details.url);
          return cb({ redirectURL: https });
        }
      } catch {}
    }
    cb({});
  });
}

async function loadOne(url) {
  const sess = session.fromPartition('test:fb:' + Math.abs(url.length));
  attach(sess);
  const win = new BrowserWindow({ show: false, webPreferences: { partition: 'test:fb:' + Math.abs(url.length), sandbox: true } });
  const wc = win.webContents;
  wc.on('did-fail-load', (e, code, desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (validatedURL.startsWith('https://') && upgradedFrom.has(validatedURL)) {
      const orig = upgradedFrom.get(validatedURL);
      upgradedFrom.delete(validatedURL);
      try { noUpgradeHosts.add(new URL(orig).hostname); } catch {}
      wc.loadURL(orig);
    }
  });
  wc.loadURL(url).catch(() => {});
  await new Promise((r) => setTimeout(r, 7000));
  const final = wc.getURL();
  const title = wc.getTitle();
  win.destroy();
  return { input: url, final, title };
}

app.whenReady().then(async () => {
  const tests = ['http://httpforever.com', 'http://neverssl.com', 'http://example.com', 'https://www.naver.com'];
  for (const t of tests) {
    const r = await loadOne(t);
    const ok = r.final && !r.final.startsWith('data:') && r.final !== 'about:blank';
    console.log(`${ok ? 'OK ' : 'FAIL'}  ${r.input}  →  ${r.final}   [${r.title}]`);
  }
  app.quit();
});
