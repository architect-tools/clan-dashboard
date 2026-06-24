// ocr-test.mjs — evaluate Tesseract OCR + roster matching on a real game screenshot.
import { createWorker, PSM } from 'tesseract.js';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { matchName, normName } from '../docs/js/util.js';

const IMG = process.argv[2];
if (!IMG) { console.error('usage: node scripts/ocr-test.mjs <image>'); process.exit(1); }

const GT = ['붉으래','돈가츠','조말순','우소츠키','폭력','버기','아싸다','비타민나라','제크로무','여름빛',
  '카운터펀치','샬루키','나유','데드','해지슬','배방3','헤파이토스','하도유','헤세메','이루릴',
  '치느','구름','EXE','빛싸다','보스','다무리','페커리','두비두밥','딱꽁','노획','하울'];

const weeklyNames = ['보스','페커리','붉으래','우소츠키','돈가츠','딱꽁','아싸다','치느','하나둘셋얍','이루릴',
  '폭력','데드','빛싸다','여신민아','버기','제크로무','다무리','스팔','나유','도베르만','치치','헤세메','크다',
  '까치','승냉','윤재','해지슬','하도유','베비','수스','서영','하울','헤파이토스','이엑스이','구름','권성준',
  '비타민나라','비스빔','리턴','헤라클','배방3','잠원동쓰레빠','두비두밥','카운터펀치','여름빛','조말순','샬루키','노획','끝판왕랑사부'];
const roster = weeklyNames.map((name, i) => ({ id: i + 1, name }));

async function variant(kind) {
  const meta = await sharp(IMG).metadata();
  let img = sharp(IMG);
  if (kind.startsWith('crop')) {
    img = img.extract({
      left: Math.round(meta.width * 0.14), top: Math.round(meta.height * 0.17),
      width: Math.round(meta.width * 0.72), height: Math.round(meta.height * 0.66),
    });
  }
  img = img.grayscale();
  const w = (kind.startsWith('crop') ? meta.width * 0.72 : meta.width);
  img = img.resize(Math.round(w * (kind.includes('3x') ? 3 : 2.4))).normalize();
  return img.png().toBuffer();
}

function dedup(text) {
  const seen = new Set(), out = [];
  for (const raw of text.split(/\n+/)) for (const tok of raw.split(/[\s,|/·•\-_\[\]()]+/)) {
    const t = tok.trim(); if (t.length < 1) continue;
    const k = normName(t); if (!k || seen.has(k)) continue; seen.add(k); out.push(t);
  }
  return out;
}
const eq = (a, b) => { const x = normName(a), y = normName(b); return x === y || x.includes(y) || y.includes(x); };

function evalText(text) {
  const lines = dedup(text);
  const hit = new Set();
  for (const line of lines) { const r = matchName(line, roster, 0.6); if (r) hit.add(r.member.name); }
  const got = GT.filter((g) => [...hit].some((h) => eq(h, g)));
  const missed = GT.filter((g) => !got.includes(g));
  return { lines, hitCount: hit.size, recall: got.length, missed };
}

const worker = await createWorker('kor');
for (const psm of [PSM.SINGLE_BLOCK, PSM.SPARSE_TEXT]) {
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  for (const kind of ['full-2.4x', 'crop-2.4x', 'crop-3x']) {
    const buf = await variant(kind);
    const { data } = await worker.recognize(buf);
    const r = evalText(data.text);
    console.log(`PSM=${psm} ${kind.padEnd(10)} → 매칭 ${String(r.hitCount).padStart(2)}명, GT recall ${r.recall}/${GT.length}  missed: ${r.missed.join(',')}`);
  }
}
await worker.terminate();
