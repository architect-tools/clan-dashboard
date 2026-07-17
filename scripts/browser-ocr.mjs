// browser-ocr.mjs — run the REAL browser OCR pipeline on the labeled samples.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = 'docs', PORT = 8090;

const GT3 = ['붉으래','돈가츠','조말순','우소츠키','폭력','버기','아싸다','비타민나라','제크로무','여름빛','카운터펀치','샬루키','나유','데드','해지슬','배방3','헤파이토스','하도유','헤세메','이루릴','치느','v구름v','EXE','빛싸다','보스','다무리','페커리','두비두밥','딱꽁','노획','s하울s'];
const SAMPLES = [
  { file: '_sample.png', label: '#3 FULL 이미지(크롭X)', panel: null, gt: GT3 },
  { file: '_sample.png', label: '#3 패널 크롭', panel: { x: 0.15, y: 0.17, w: 0.72, h: 0.70 }, gt: GT3 },
  { file: '_sample2.png', label: '#4 (37명, 패널만)', panel: null,
    gt: ['끝판왕랑사부','리턴','Doberman','노획','망듕땅','카운터펀치','이루릴','치치','해지슬','붉으래','아싸다','두비두밥','승냉','딱꽁','윤재','헤파이토스','빛싸다','보스','s하울s','조말순','v구름v','VISVIM','oO서영Oo','폭력','귄성준','버기','xooos','우소츠키','여름빛','잠원동쓰레빠','헤세메','Babyee','치느','EXE','헤라클','페커리','KDA'] },
];
const norm = (s) => String(s).replace(/[\s　]/g, '').replace(/[^0-9a-z가-힣]/gi, '').toLowerCase();
const eq = (a, b) => { const x = norm(a), y = norm(b); return x === y || x.includes(y) || y.includes(x); };

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  fs.readFile(path.join(ROOT, p), (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); res.end(d); });
});
await new Promise((r) => server.listen(PORT, r));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/_ocrtest.html`, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__ready === true', { timeout: 15000 });

const SCALES = process.env.SCALES ? JSON.parse(process.env.SCALES) : null;
if (SCALES) { await page.evaluate((s) => { window.__SCALES = s; }, SCALES); console.log('SCALES =', JSON.stringify(SCALES)); }

for (const smp of SAMPLES) {
  const r = await page.evaluate(async (smp) => {
    const O = window.__ocr;
    const img = await O.loadImage(await (await fetch('./' + smp.file)).blob());
    const roster = (await (await fetch('./data/seed.json')).json()).members;
    const W = img.naturalWidth, H = img.naturalHeight;
    const crop = smp.panel ? { x: smp.panel.x * W, y: smp.panel.y * H, w: smp.panel.w * W, h: smp.panel.h * H } : null;
    const scales = window.__SCALES || undefined;
    const out = await O.extractLines(img, crop, () => {}, scales ? { scales } : {});
    const m = O.consensusMatch(out.perScale, roster);
    return { matched: m.matched.map((x) => ({ n: x.member.name, s: Math.round(x.score * 100), v: x.votes })), maybe: m.maybe.map((x) => x.member.name) };
  }, smp).catch((e) => ({ error: String(e) }));

  if (r.error) { console.log(smp.label, 'ERROR', r.error); continue; }
  const names = r.matched.map((x) => x.n);
  const got = smp.gt.filter((g) => names.some((h) => eq(h, g)));
  const missed = smp.gt.filter((g) => !names.some((h) => eq(h, g)));
  const wrong = r.matched.filter((x) => !smp.gt.some((g) => eq(x.n, g)));
  console.log(`\n=== ${smp.label} ===`);
  console.log(`신뢰 ${names.length}명 · 정답매칭 ${got.length}/${smp.gt.length} · 오인식 ${wrong.length}${wrong.length ? ' [' + wrong.map((x) => `${x.n}(${x.s}%,v${x.v})`).join(',') + ']' : ''}`);
  console.log('놓침:', missed.join(', ') || '없음');
  const gotM = smp.gt.filter((g) => [...names, ...r.maybe].some((h) => eq(h, g)));
  console.log(`(+확인필요 포함: ${gotM.length}/${smp.gt.length})`);
}
await browser.close();
server.close();
