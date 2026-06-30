'use strict';
/*
 * 필터 목록 다운로더 — 학교망에서 raw.githubusercontent.com 이 차단되므로
 * easylist.to(접근 가능)에서 받아 filters/ 에 로컬 번들한다.
 * 실행: node scripts/update-filters.js
 */
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'filters');
const TARGETS = [
  ['easylist',    'https://easylist.to/easylist/easylist.txt'],
  ['easyprivacy', 'https://easylist.to/easylist/easyprivacy.txt'],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, url] of TARGETS) {
    try {
      const r = await fetch(url);
      if (!r.ok) { console.log(name, 'HTTP', r.status); continue; }
      const text = await r.text();
      fs.writeFileSync(path.join(OUT, name + '.txt'), text);
      console.log(name, 'OK', (text.length / 1024).toFixed(0) + 'KB', text.split('\n').length + ' lines');
    } catch (e) {
      console.log(name, 'FAIL', (e.cause && e.cause.code) || e.message);
    }
  }
})();
