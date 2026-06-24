// ocr-scale-test.mjs — prove slot OCR is resolution-independent: run the same
// fraction-based block grid + target-height cell normalization across image scales.
import { createWorker, PSM } from 'tesseract.js';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { matchRoster } from '../docs/js/ocr.js';
import { normName } from '../docs/js/util.js';

const roster = JSON.parse(readFileSync('docs/data/seed.json', 'utf8')).members;
const GT = ['붉으래','돈가츠','조말순','우소츠키','폭력','버기','아싸다','비타민나라','제크로무','여름빛',
  '카운터펀치','샬루키','나유','데드','해지슬','배방3','헤파이토스','하도유','헤세메','이루릴',
  '치느','v구름v','EXE','빛싸다','보스','다무리','페커리','두비두밥','딱꽁','노획','s하울s'];
const eq = (a, b) => { const x = normName(a), y = normName(b); return x === y || x.includes(y) || y.includes(x); };
const TARGET_H = 96;

async function run(img, worker) {
  const m = await sharp(img).metadata();
  const blocks = [{ x: 0.158, y: 0.232, w: 0.700, h: 0.262 }, { x: 0.158, y: 0.612, w: 0.700, h: 0.262 }];
  const nameLeftPct = 0.16, cols = 5, rows = 5;
  const texts = [];
  for (const b of blocks) {
    const L = b.x * m.width, T = b.y * m.height, W = b.w * m.width, H = b.h * m.height, cw = W / cols, rh = H / rows;
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
      const x = Math.round(L + c * cw + cw * nameLeftPct), y = Math.round(T + r * rh + rh * 0.06);
      const ww = Math.round(cw * (1 - nameLeftPct - 0.02)), hh = Math.round(rh * 0.88);
      const scale = Math.min(6, Math.max(1, TARGET_H / Math.max(8, hh)));
      const buf = await sharp(img).extract({ left: x, top: y, width: ww, height: hh })
        .grayscale().resize(Math.round(ww * scale)).normalize().png().toBuffer();
      const { data } = await worker.recognize(buf);
      const t = (data.text || '').trim().replace(/\s+/g, ' ');
      if (t) texts.push(t);
    }
  }
  const { matched, maybe } = matchRoster(texts, roster);
  const found = new Set([...matched, ...maybe].map((x) => x.member.name));
  const got = GT.filter((g) => [...found].some((h) => eq(h, g)));
  const wrong = [...found].filter((f) => !GT.some((g) => eq(f, g)));
  return { dims: `${m.width}x${m.height}`, recall: got.length, found: found.size, wrong: wrong.length, wrongList: wrong };
}

const worker = await createWorker('kor+eng');
await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
for (const f of process.argv.slice(2)) {
  const r = await run(f, worker);
  console.log(`${r.dims.padEnd(10)} → GT recall ${r.recall}/26 · 인식 ${r.found} · 오인식 ${r.wrong} ${r.wrongList.length ? '(' + r.wrongList.join(',') + ')' : ''}`);
}
await worker.terminate();
