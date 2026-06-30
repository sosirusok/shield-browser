'use strict';
/* chess.com 진단 — UA/헤더/광고차단 조합별로 실제 로드 결과(최종 URL·제목)를 본다.
 * "Just a moment"/"Attention Required" = Cloudflare 차단. 결과는 _chess.json. */
const { app, BrowserWindow, session } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const fs = require('node:fs');
const path = require('node:path');

const UA120 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA134 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

app.on('window-all-closed', () => {});

let blocker;
async function getBlocker() {
  if (blocker) return blocker;
  const dir = path.join(__dirname, '..', 'filters');
  const text = ['easylist.txt', 'easyprivacy.txt'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  blocker = ElectronBlocker.parse(text);
  return blocker;
}

async function run(cfg, i) {
  const part = 'test:chess' + i;
  const sess = session.fromPartition(part);
  if (cfg.ua) sess.setUserAgent(cfg.ua);
  if (cfg.headers) {
    sess.webRequest.onBeforeSendHeaders((d, cb) => { const h = { ...d.requestHeaders }; h.DNT = '1'; h['Sec-GPC'] = '1'; cb({ requestHeaders: h }); });
  }
  if (cfg.adblock) { (await getBlocker()).enableBlockingInSession(sess); }

  const w = new BrowserWindow({ show: false, webPreferences: { partition: part, sandbox: true } });
  w.webContents.loadURL('https://www.chess.com/').catch(() => {});
  await new Promise((r) => setTimeout(r, 9000));
  const res = { cfg: cfg.name, final: w.webContents.getURL(), title: w.webContents.getTitle() };
  w.destroy();
  return res;
}

app.whenReady().then(async () => {
  const configs = [
    { name: '현재(UA120+헤더+차단)', ua: UA120, headers: true, adblock: true },
    { name: 'UA134+헤더+차단',       ua: UA134, headers: true, adblock: true },
    { name: 'UA134+헤더X+차단',      ua: UA134, headers: false, adblock: true },
    { name: 'UA134+헤더+차단X',      ua: UA134, headers: true, adblock: false },
  ];
  const out = [];
  for (let i = 0; i < configs.length; i++) out.push(await run(configs[i], i));
  fs.writeFileSync(path.join(__dirname, '..', '_chess.json'), JSON.stringify(out, null, 2));
  app.quit();
});
