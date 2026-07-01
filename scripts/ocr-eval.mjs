// ocr-eval.mjs — diagnostic recall harness for the two NEW labeled screenshots
// (_sampleA=38, _sampleB=40). Reuses the REAL consensusMatch()/similarity() so
// numbers reflect the deployed matcher. Reports per-name status:
//   AUTO   = in matched (checkbox auto-checked)
//   REVIEW = in maybe   (shown but UNCHECKED)   -> "high% but unchecked" bug
//   MISS   = not shown at all                    -> "70%+ but not shown" bug
// For each miss it also prints the best raw-token similarity so we can tell
// "OCR never read it" from "matcher threshold too strict".
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import fs from 'node:fs';
import { consensusMatch } from '../docs/js/ocr.js';
import { normName, similarity } from '../docs/js/util.js';

// Roster = seed.json, patched to the current live names these screenshots use:
// 도베르만→Doberman (already in seed) and the stale 페커리→냉정 (live in-game nick).
const seed = JSON.parse(fs.readFileSync('docs/data/seed.json', 'utf8'));
const roster = seed.members.filter(m => m.active !== false)
  .map(m => ({ ...m, name: m.name === '페커리' ? '냉정' : m.name }));

const GTA = ['빛싸다','여신민아','리턴','헤라클','배방3','해지슬','승냉','버기','조말순','샬루키','VISVIM','데드','EXE','다무리','딱꽁','카운터펀치','v구름v','s하울s','치느','두비두밥','폭력','헤파이토스','스팔','아싸다','하도유','보스','하나둘셋얍','헤세메','이루릴','붉으래','여름빛','우소츠키','Doberman','돈가츠','냉정','권성준','KDA','oO서영Oo'];
const GTB = ['하도유','조말순','이루릴','여름빛','카운터펀치','VISVIM','해지슬','승냉','치치','데드','권성준','버기','s하울s','Doberman','헤파이토스','냉정','oO서영Oo','하나둘셋얍','v구름v','윤재','헤세메','아싸다','우소츠키','배방3','빛싸다','두비두밥','KDA','헤라클','잠원동쓰레빠','붉으래','EXE','비타민나라','Babyee','제크로무','샬루키','딱꽁','치느','리턴','여신민아','스팔'];

const SAMPLES = [
  { file: 'docs/_sampleA.png', label: 'A(38)', gt: GTA, panel: JSON.parse(process.env.CROPA || 'null') || { x: 0.00, y: 0.14, w: 1.00, h: 0.72 } },
  { file: 'docs/_sampleB.png', label: 'B(40)', gt: GTB, panel: JSON.parse(process.env.CROPB || 'null') || { x: 0.12, y: 0.09, w: 0.76, h: 0.80 } },
];
const SCALES = JSON.parse(process.env.SCALES || '[2.8,3.6,4.4]');
const VARIANTS = JSON.parse(process.env.VARIANTS || '[{},{"binarize":132},{"binarize":110}]');
const MAX_SIDE = +(process.env.MAXSIDE || 6000), KERNEL = process.env.KERNEL || 'cubic'; // 6000 = ocr.js default
const eq = (a, b) => { const x = normName(a), y = normName(b); return x && (x === y || x.includes(y) || y.includes(x)); };

function dedup(text) {
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
  const sx = Math.round(panel.x*W), sy = Math.round(panel.y*H), sw = Math.round(panel.w*W), sh = Math.round(panel.h*H);
  const rs = Math.max(1, Math.min(scale, MAX_SIDE / Math.max(sw, sh)));
  const cw = Math.max(1, Math.round(sw*rs)), ch = Math.max(1, Math.round(sh*rs));
  const { data, info } = await sharp(file).extract({ left: sx, top: sy, width: sw, height: sh })
    .resize(cw, ch, { kernel: KERNEL }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width*info.height, gray = new Uint8Array(n); let min=255,max=0;
  for (let i=0,j=0;j<n;i+=info.channels,j++){const g=(data[i]*0.299+data[i+1]*0.587+data[i+2]*0.114)|0;gray[j]=g;if(g<min)min=g;if(g>max)max=g;}
  const range=Math.max(1,max-min), out=Buffer.allocUnsafe(n);
  const binT = binarize===true?132:(typeof binarize==='number'?binarize:null);
  for(let j=0;j<n;j++){let v=((gray[j]-min)*255/range)|0; if(binT!=null)v=v>binT?0:255; else if(invert)v=255-v; out[j]=v;}
  return sharp(out,{raw:{width:info.width,height:info.height,channels:1}}).png().toBuffer();
}

const TJS = './node_modules';
const worker = await createWorker('kor+eng', 1, { corePath: TJS+'/tesseract.js-core', langPath: '.', gzip: false, logger: ()=>{}, workerPath: TJS+'/tesseract.js/src/worker-script/node/index.js' });
await worker.setParameters({ tessedit_pageseg_mode: '11' });

const CACHE = process.env.CACHE || 'C:/tmp/ocreval_cache.json';
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE,'utf8')) : {};
const save = () => fs.writeFileSync(CACHE, JSON.stringify(cache));

for (const smp of SAMPLES) {
  const meta = await sharp(smp.file).metadata();
  const cropKey = `${smp.panel.x},${smp.panel.y},${smp.panel.w},${smp.panel.h}`;
  const perScale = [];
  for (const s of SCALES) for (const v of VARIANTS) {
    const key = `${KERNEL}|ms${MAX_SIDE}|${smp.file}|${cropKey}|${s}|${v.binarize?'b'+v.binarize:'n'}`;
    if (!cache[key]) { const buf = await preprocess(smp.file, meta, smp.panel, s, v); const { data } = await worker.recognize(buf); cache[key]=dedup(data.text||''); save(); process.stderr.write('.'); }
    perScale.push(cache[key]);
  }
  const rawTokens = [...new Set(perScale.flat())];
  const m = consensusMatch(perScale, roster);
  const autoNames = new Set(m.matched.map(x=>x.member.name));
  const reviewNames = new Set(m.maybe.map(x=>x.member.name));
  const bestTokFor = (name) => { let bs=0,bt=''; for (const t of rawTokens){ const s=similarity(t,name); if(s>bs){bs=s;bt=t;} } return {bs,bt}; };
  let auto=0, review=0, miss=0; const lines=[];
  for (const g of smp.gt) {
    if ([...autoNames].some(h=>eq(h,g))) { auto++; }
    else if ([...reviewNames].some(h=>eq(h,g))) { review++; const {bs,bt}=bestTokFor(g); lines.push(`  REVIEW ${g}  (best "${bt}" ${(bs*100)|0}%)`); }
    else { miss++; const {bs,bt}=bestTokFor(g); lines.push(`  MISS   ${g}  (best raw "${bt}" ${(bs*100)|0}%)`); }
  }
  const wrong = m.matched.filter(x=>!smp.gt.some(g=>eq(x.member.name,g))).map(x=>`${x.member.name}<-"${x.token}"${(x.score*100)|0}%`);
  console.log(`\n=== ${smp.label} crop=${cropKey} passes=${perScale.length} rawTokens=${rawTokens.length} ===`);
  console.log(`AUTO ${auto}/${smp.gt.length}  REVIEW ${review}  MISS ${miss}  WRONG ${wrong.length}`);
  if (lines.length) console.log(lines.join('\n'));
  if (wrong.length) console.log('  WRONG:', wrong.join(', '));
}
await worker.terminate();
