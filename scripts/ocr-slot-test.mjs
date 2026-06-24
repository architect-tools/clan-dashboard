// ocr-slot-test.mjs — prototype: slice the clan-party panel into name slots and OCR each cell.
import { createWorker, PSM } from 'tesseract.js';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { matchName, normName } from '../docs/js/util.js';

const IMG = process.argv[2];
const roster = JSON.parse(readFileSync('docs/data/seed.json', 'utf8')).members;

// ground truth: 26 occupied slots
const GT = ['붉으래','돈가츠','조말순','우소츠키','폭력','버기','아싸다','비타민나라','제크로무','여름빛',
  '카운터펀치','샬루키','나유','데드','해지슬','배방3','헤파이토스','하도유','헤세메','이루릴',
  '치느','v구름v','EXE','빛싸다','보스','다무리','페커리','두비두밥','딱꽁','노획','s하울s'].slice(0, 31);
// (s하울s is group7 slot1 → 26 occupied across groups; GT has 26 names + a few extra here)

const eq = (a, b) => { const x = normName(a), y = normName(b); return x === y || x.includes(y) || y.includes(x); };

async function main() {
  const m = await sharp(IMG).metadata();
  const panel = { left: m.width * 0.15, top: m.height * 0.18, w: m.width * 0.70, h: m.height * 0.68 };
  const colW = panel.w / 5;
  const topYs = [0.105, 0.190, 0.275, 0.360, 0.445];
  const botYs = [0.605, 0.685, 0.765, 0.845, 0.925];
  const rowH = 0.075;
  const nameLeftPct = 0.22, nameRightPad = 0.03;

  const cells = [];
  for (const [sec, ys] of [['T', topYs], ['B', botYs]]) {
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < ys.length; r++) {
        const x = Math.round(panel.left + c * colW + colW * nameLeftPct);
        const w = Math.round(colW * (1 - nameLeftPct - nameRightPad));
        const y = Math.round(panel.top + ys[r] * panel.h);
        const h = Math.round(rowH * panel.h);
        cells.push({ id: `${sec}${c + 1}-${r + 1}`, x, y, w, h });
      }
    }
  }

  const worker = await createWorker('kor+eng');
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });

  const found = new Set();
  const raw = [];
  for (const cell of cells) {
    const buf = await sharp(IMG).extract({ left: cell.x, top: cell.y, width: cell.w, height: cell.h })
      .grayscale().resize(cell.w * 3).normalize().png().toBuffer();
    const { data } = await worker.recognize(buf);
    const text = (data.text || '').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    const mt = matchName(text, roster, 0.6);
    raw.push(`${cell.id}: "${text}"${mt ? ' → ' + mt.member.name + ' ' + Math.round(mt.score * 100) + '%' : ' (no match)'}`);
    if (mt) found.add(mt.member.name);
  }
  await worker.terminate();

  const got = GT.filter((g) => [...found].some((h) => eq(h, g)));
  const wrong = [...found].filter((f) => !GT.some((g) => eq(f, g)));
  console.log(raw.join('\n'));
  console.log('\n=== SLOT OCR RESULT ===');
  console.log(`인식 ${found.size}명 / GT recall ${got.length}/26 / 오인식(GT 외) ${wrong.length}: ${wrong.join(', ')}`);
  console.log('놓침:', GT.slice(0, 26).filter((g) => !got.includes(g)).join(', ') || '없음');
}
main();
