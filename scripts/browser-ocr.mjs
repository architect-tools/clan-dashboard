// browser-ocr.mjs — run the REAL browser OCR pipeline (canvas + Tesseract.js CDN)
// in headless Chrome and report what it actually produces on the sample.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = 'docs';
const PORT = 8090;

const GT = ['붉으래','돈가츠','조말순','우소츠키','폭력','버기','아싸다','비타민나라','제크로무','여름빛',
  '카운터펀치','샬루키','나유','데드','해지슬','배방3','헤파이토스','하도유','헤세메','이루릴',
  '치느','v구름v','EXE','빛싸다','보스','다무리','페커리','두비두밥','딱꽁','노획','s하울s'];
const norm = (s) => String(s).replace(/[\s　]/g, '').replace(/[^0-9a-z가-힣]/gi, '').toLowerCase();
const eq = (a, b) => { const x = norm(a), y = norm(b); return x === y || x.includes(y) || y.includes(x); };
const score = (found) => {
  const got = GT.filter((g) => found.some((h) => eq(h, g)));
  const wrong = found.filter((f) => !GT.some((g) => eq(f, g)));
  return `recall ${got.length}/26 · 인식 ${found.length} · 오인식 ${wrong.length}${wrong.length ? ' [' + wrong.join(',') + ']' : ''}`;
};

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  fs.readFile(path.join(ROOT, p), (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); res.end(d); });
});
await new Promise((r) => server.listen(PORT, r));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('console', (m) => { const t = m.text(); if (!/Tesseract|loading|http/.test(t)) console.log('  [page]', t); });
await page.goto(`http://localhost:${PORT}/_ocrtest.html`, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__ready === true', { timeout: 15000 });

const result = await page.evaluate(async () => {
  const O = window.__ocr;
  const blob = await (await fetch('./_sample.png')).blob();
  const img = await O.loadImage(blob);
  const roster = (await (await fetch('./data/seed.json')).json()).members;
  const W = img.naturalWidth, H = img.naturalHeight;
  const panel = { x: 0.15 * W, y: 0.17 * H, w: 0.72 * W, h: 0.70 * H };
  const out = {};
  const run = async (label, crop, opts) => {
    const r = await O.extractLines(img, crop, () => {}, opts);
    const m = O.matchRoster(r.lines, roster);
    out[label] = { lines: r.lines, matched: m.matched.map((x) => x.member.name), maybe: m.maybe.map((x) => x.member.name) };
  };
  await run('FULL image (multiscale)', null, {});
  await run('PANEL crop (multiscale)', panel, {});
  return { dims: W + 'x' + H, out };
}).catch((e) => ({ error: String(e) }));

if (result.error) { console.log('ERROR:', result.error); }
else {
  console.log('dims:', result.dims, '\n');
  for (const [label, r] of Object.entries(result.out)) {
    console.log(`[${label}]`);
    console.log('  신뢰   :', score(r.matched));
    console.log('  matched:', r.matched.join(', '));
    console.log('  RAW    :', JSON.stringify(r.lines));
  }
}

await browser.close();
server.close();
