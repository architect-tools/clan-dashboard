// loop-ocr.mjs — measure real-browser OCR recall on both labeled samples.
// Writes JSON result to env RES (Windows path). Used for the tuning loop.
import puppeteer from 'puppeteer-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe', ROOT = 'docs';
const PORT = 8200 + (Date.now() % 300 | 0);
const RES = process.env.RES;

const GT3 = ['붉으래','돈가츠','조말순','우소츠키','폭력','버기','아싸다','비타민나라','제크로무','여름빛','카운터펀치','샬루키','나유','데드','해지슬','배방3','헤파이토스','하도유','헤세메','이루릴','치느','v구름v','EXE','빛싸다','보스','다무리','페커리','두비두밥','딱꽁','노획','s하울s'];
const GT4 = ['끝판왕랑사부','리턴','Doberman','노획','망듕땅','카운터펀치','이루릴','치치','해지슬','붉으래','아싸다','두비두밥','승냉','딱꽁','윤재','헤파이토스','빛싸다','보스','s하울s','조말순','v구름v','VISVIM','oO서영Oo','폭력','귄성준','버기','xooos','우소츠키','여름빛','잠원동쓰레빠','헤세메','Babyee','치느','EXE','헤라클','페커리','KDA'];
const SAMPLES = [
  { file: '_sample.png', label: '#3(31)', panel: { x: 0.15, y: 0.17, w: 0.72, h: 0.70 }, gt: GT3 },
  { file: '_sample2.png', label: '#4(37)', panel: { x: 0.01, y: 0.05, w: 0.98, h: 0.94 }, gt: GT4 },
];
const norm = (s) => String(s).replace(/[\s　]/g, '').replace(/[^0-9a-z가-힣]/gi, '').toLowerCase();
const eq = (a, b) => { const x = norm(a), y = norm(b); return x === y || x.includes(y) || y.includes(x); };

const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html'; fs.readFile(path.join(ROOT, p), (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); r.end(d); }); });
await new Promise((r) => server.listen(PORT, r));
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--use-gl=swiftshader', '--user-data-dir=C:/Users/wytxh/AppData/Local/Temp/ppt-' + Date.now()] });
const pg = await b.newPage();
pg.on('pageerror', (e) => console.log('PAGEERR', e.message));
await pg.goto(`http://localhost:${PORT}/_ocrtest.html`, { waitUntil: 'networkidle0' });
await pg.waitForFunction('window.__ready === true', { timeout: 15000 });

const report = [];
for (const smp of SAMPLES) {
  const r = await pg.evaluate(async (smp) => {
    const O = window.__ocr;
    const img = await O.loadImage(await (await fetch('./' + smp.file)).blob());
    const roster = (await (await fetch('./data/seed.json')).json()).members;
    const W = img.naturalWidth, H = img.naturalHeight;
    const crop = { x: smp.panel.x * W, y: smp.panel.y * H, w: smp.panel.w * W, h: smp.panel.h * H };
    const out = await O.extractLines(img, crop, () => {});
    const m = O.consensusMatch(out.perScale, roster);
    return { matched: m.matched.map((x) => ({ n: x.member.name, t: x.token, s: +x.score.toFixed(2), v: x.votes })), maybe: m.maybe.map((x) => x.member.name), raw: out.lines };
  }, smp);
  const names = r.matched.map((x) => x.n);
  const got = smp.gt.filter((g) => names.some((h) => eq(h, g)));
  const gotMaybe = smp.gt.filter((g) => [...names, ...r.maybe].some((h) => eq(h, g)));
  const missed = smp.gt.filter((g) => ![...names, ...r.maybe].some((h) => eq(h, g)));
  const wrong = r.matched.filter((x) => !smp.gt.some((g) => eq(x.n, g)));
  report.push({ label: smp.label, total: smp.gt.length, matched: got.length, withMaybe: gotMaybe.length, wrong, missed, raw: r.raw });
}
fs.writeFileSync(RES, JSON.stringify(report, null, 1));
await b.close(); server.close(); process.exit(0);
