// cv-detect.mjs — validate OpenCV.js contour-based panel detection in real browser.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = 'docs', PORT = 8091;
const SCRATCH = process.argv[2]; // scratch dir for overlay output
const SAMPLES = [['_sample.png', 'cv3.png'], ['_sample2.png', 'cv4.png']];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  fs.readFile(path.join(ROOT, p), (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); res.end(d); });
});
await new Promise((r) => server.listen(PORT, r));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--use-gl=swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.goto(`http://localhost:${PORT}/_cvtest.html`, { waitUntil: 'networkidle0' });
console.log('loading opencv.js…');
await page.waitForFunction('window.__cvReady === true', { timeout: 60000 });
console.log('opencv ready\n');

for (const [file, out] of SAMPLES) {
  const r = await page.evaluate((f) => window.detectPanel('./' + f), file).catch((e) => ({ error: String(e) }));
  if (r.error) { console.log(file, 'ERR', r.error); continue; }
  const meta = await sharp(path.join(ROOT, file)).metadata();
  const fr = (v, d) => (v / d).toFixed(3);
  console.log(`=== ${file} (${meta.width}x${meta.height}) ===`);
  console.log('  best:', r.best ? `x${fr(r.best.x, meta.width)} y${fr(r.best.y, meta.height)} w${fr(r.best.w, meta.width)} h${fr(r.best.h, meta.height)} (area ${r.best.areaFrac})` : 'none');
  console.log('  top5 areaFrac:', r.top5.map((c) => c.areaFrac).join(', '));
  if (r.best && SCRATCH) {
    const b = r.best;
    const svg = `<svg width='${meta.width}' height='${meta.height}' xmlns='http://www.w3.org/2000/svg'><rect x='${b.x}' y='${b.y}' width='${b.w}' height='${b.h}' fill='none' stroke='lime' stroke-width='4'/></svg>`;
    await sharp(path.join(ROOT, file)).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).toFile(path.join(SCRATCH, out));
    console.log('  saved', out);
  }
}
await browser.close(); server.close();
