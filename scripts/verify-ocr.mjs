// verify-ocr.mjs — offline (sandbox) recall measurement, faithful to docs/js/ocr.js.
// Preprocessing replicates preprocess() in raw pixels (Rec.601 luma + min/max
// stretch); matching reuses the REAL consensusMatch()/util.js, so the 31/37
// verdict is the same code path the deployed app runs.
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import fs from 'node:fs';
import { consensusMatch } from '../docs/js/ocr.js';
import { normName } from '../docs/js/util.js';

const GT3 = ['붉으래','돈가츠','조말순','우소츠키','폭력','버기','아싸다','비타민나라','제크로무','여름빛','카운터펀치','샬루키','나유','데드','해지슬','배방3','헤파이토스','하도유','헤세메','이루릴','치느','v구름v','EXE','빛싸다','보스','다무리','페커리','두비두밥','딱꽁','노획','s하울s'];
const GT4 = ['끝판왕랑사부','리턴','Doberman','노획','여신민아','카운터펀치','이루릴','치치','해지슬','붉으래','아싸다','두비두밥','승냉','딱꽁','윤재','헤파이토스','빛싸다','보스','s하울s','조말순','v구름v','VISVIM','oO서영Oo','폭력','권성준','버기','xooos','우소츠키','여름빛','잠원동쓰레빠','헤세메','Babyee','치느','EXE','헤라클','페커리','KDA'];
const GT5 = ['끝판왕랑사부','우소츠키','아싸다','붉으래','여름빛','Babyee','치느','빛싸다','나유','s하울s','헤세메','보스','제크로무','oO서영Oo','xooos','까치','폭력','승냉','돈가츠','딱꽁','잠원동쓰레빠','다무리','하나둘셋얍','리턴','윤재','치치','조말순','권성준','v구름v','헤라클','노획','이루릴','KDA','비타민나라','여신민아','VISVIM','배방3','헤파이토스','해지슬','두비두밥','버기','Doberman','카운터펀치','스팔','EXE','페커리'];
const GT6 = ['끝판왕랑사부','윤재','치치','Babyee','제크로무','스팔','보스','버기','여름빛','리턴','승냉','우소츠키','카운터펀치','다무리','딱꽁','돈가츠','두비두밥','oO서영Oo','Doberman','여신민아','헤세메','조말순','이루릴','해지슬','빛싸다','나유','노획','페커리','까치','아싸다','잠원동쓰레빠','헤라클','헤파이토스','비타민나라','붉으래','v구름v','치느','KDA','EXE','xooos','배방3','VISVIM','권성준','폭력','s하울s'];
const SAMPLES = [
  { file: 'docs/_sample.png',  label: '#3(31)', panel: { x: 0.15, y: 0.17, w: 0.72, h: 0.70 }, gt: GT3 },
  { file: 'docs/_sample2.png', label: '#4(37)', panel: { x: 0.01, y: 0.05, w: 0.98, h: 0.94 }, gt: GT4 },
  { file: 'docs/_sample3.png', label: '#5(46)', panel: { x: 0.005, y: 0.07, w: 0.99, h: 0.92 }, gt: GT5 },
  { file: 'docs/_sample4.png', label: '#6(45)', panel: { x: 0.005, y: 0.07, w: 0.99, h: 0.92 }, gt: GT6 },
];
const SCALES = [2.8, 3.6, 4.4]; // matches ocr.js extractLines default (5.2 dropped for speed)
const VARIANTS = [{}, { binarize: 132 }, { binarize: 110 }]; // faithful to ocr.js extractLines default
const MAX_SIDE = 5200;
const KERNEL = process.env.KERNEL || 'cubic';
const norm = (s) => normName(s);
const eq = (a, b) => { const x = norm(a), y = norm(b); return x && (x === y || x.includes(y) || y.includes(x)); };

function dedup(text) { // faithful copy of dedup() from ocr.js
  const seen = new Set(), out = [];
  for (const raw of String(text).split(/\n+/))
    for (const tok of raw.split(/[\s,，|/·•_\[\]()]+/)) {
      const t = tok.trim(); if (t.length < 1) continue;
      const key = normName(t); if (!key || seen.has(key)) continue;
      seen.add(key); out.push(t);
    }
  return out;
}

async function preprocess(file, meta, panel, scale, { binarize = false, invert = false } = {}) {
  const W = meta.width, H = meta.height;
  const sx = Math.round(panel.x * W), sy = Math.round(panel.y * H);
  const sw = Math.round(panel.w * W), sh = Math.round(panel.h * H);
  const realScale = Math.max(1, Math.min(scale, MAX_SIDE / Math.max(sw, sh)));
  const cw = Math.max(1, Math.round(sw * realScale)), ch = Math.max(1, Math.round(sh * realScale));
  const { data, info } = await sharp(file).extract({ left: sx, top: sy, width: sw, height: sh })
    .resize(cw, ch, { kernel: KERNEL }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height, gray = new Uint8Array(n);
  let min = 255, max = 0;
  for (let i = 0, j = 0; j < n; i += info.channels, j++) {
    const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    gray[j] = g; if (g < min) min = g; if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  const out = Buffer.allocUnsafe(n);
  const binT = binarize === true ? 132 : (typeof binarize === 'number' ? binarize : null);
  for (let j = 0; j < n; j++) {
    let v = ((gray[j] - min) * 255 / range) | 0;
    if (binT != null) v = v > binT ? 0 : 255; else if (invert) v = 255 - v;
    out[j] = v;
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
}

const TJS = process.env.TJS_DIR || './node_modules';
const worker = await createWorker('kor+eng', 1, {
  corePath: TJS + '/tesseract.js-core',
  langPath: '.', gzip: false, logger: () => {},
  workerPath: TJS + '/tesseract.js/src/worker-script/node/index.js',
});
await worker.setParameters({ tessedit_pageseg_mode: '11' });

const roster = JSON.parse(fs.readFileSync('docs/data/seed.json', 'utf8')).members;
const CACHE = process.env.CACHE || '/tmp/ocrcache.json';
const VER = process.env.CACHE_VER || 'v2';
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
const save = () => fs.writeFileSync(CACHE, JSON.stringify(cache));
const report = [];
for (const smp of SAMPLES) {
  if (!fs.existsSync(smp.file)) continue;
  const meta = await sharp(smp.file).metadata();
  const perScale = [];
  for (const s of SCALES) for (const v of VARIANTS) {
    const key = `${VER}|${KERNEL}|${smp.file}|${s}|${v.binarize ? 'b' + v.binarize : 'n'}`;
    if (!cache[key]) {
      const buf = await preprocess(smp.file, meta, smp.panel, s, v);
      const { data } = await worker.recognize(buf);
      cache[key] = dedup(data.text || ''); save();
      process.stderr.write(`done ${key}\n`);
    }
    perScale.push(cache[key]);
  }
  const m = consensusMatch(perScale, roster);
  const names = m.matched.map((x) => x.member.name);
  const maybe = m.maybe.map((x) => x.member.name);
  const got = smp.gt.filter((g) => names.some((h) => eq(h, g)));
  const missed = smp.gt.filter((g) => ![...names, ...maybe].some((h) => eq(h, g)));
  const missedStrict = smp.gt.filter((g) => !names.some((h) => eq(h, g)));
  const wrong = m.matched.filter((x) => !smp.gt.some((g) => eq(x.member.name, g))).map((x) => x.member.name);
  report.push({ label: smp.label, total: smp.gt.length, matched: got.length, withMaybe: smp.gt.length - missed.length, missed: missedStrict, wrong, names });
}
await worker.terminate();
console.log(JSON.stringify(report, null, 1));
