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

const GTA = ['빛싸다','망듕땅','리턴','헤라클','배방3','해지슬','승냉','버기','조말순','샬루키','VISVIM','데드','EXE','다무리','딱꽁','카운터펀치','v구름v','s하울s','치느','두비두밥','폭력','헤파이토스','스팔','아싸다','하도유','보스','하나둘셋얍','헤세메','이루릴','붉으래','여름빛','우소츠키','Doberman','돈가츠','냉정','귄성준','KDA','oO서영Oo'];
const GTB = ['하도유','조말순','이루릴','여름빛','카운터펀치','VISVIM','해지슬','승냉','치치','데드','귄성준','버기','s하울s','Doberman','헤파이토스','냉정','oO서영Oo','하나둘셋얍','v구름v','윤재','헤세메','아싸다','우소츠키','배방3','빛싸다','두비두밥','KDA','헤라클','잠원동쓰레빠','붉으래','EXE','비타민나라','Babyee','제크로무','샬루키','딱꽁','치느','리턴','망듕땅','스팔'];
const GTC = ['끝판왕랑사부','조말순','치치','oO서영Oo','카운터펀치','EXE','스팔','샬루키','빛싸다','리턴','헤라클','두비두밥','까치','해지슬','헤세메','이루릴','딱꽁','배방3','v구름v','붉으래','s하울s','제크로무','헤파이토스','Doberman','KDA','아싸다','우소츠키','잠원동쓰레빠','하도유','데드','윤재','노획','망듕땅','치느','버기','보스','돈가츠','나유','비타민나라'];

const SAMPLES = [
  { file: 'docs/_sampleA.png', label: 'A(38)', gt: GTA, panel: JSON.parse(process.env.CROPA || 'null') || { x: 0.00, y: 0.14, w: 1.00, h: 0.72 } },
  { file: 'docs/_sampleB.png', label: 'B(40)', gt: GTB, panel: JSON.parse(process.env.CROPB || 'null') || { x: 0.12, y: 0.09, w: 0.76, h: 0.80 } },
  { file: 'docs/_sampleC.png', label: 'C(39)', gt: GTC, panel: JSON.parse(process.env.CROPC || 'null') || { x: 0.00, y: 0.10, w: 1.00, h: 0.86 } },
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
// 3×3 ops — identical math to docs/js/ocr.js preprocess (keep in sync).
function box3(g,w,h){const o=new Float32Array(g.length);for(let y=0;y<h;y++)for(let x=0;x<w;x++){let s=0,c=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=w||yy>=h)continue;s+=g[yy*w+xx];c++;}o[y*w+x]=s/c;}return o;}
function median3(g,w,h){const o=new Uint8Array(g.length),win=new Array(9);for(let y=0;y<h;y++)for(let x=0;x<w;x++){let k=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=Math.min(w-1,Math.max(0,x+dx)),yy=Math.min(h-1,Math.max(0,y+dy));win[k++]=g[yy*w+xx];}win.sort((a,b)=>a-b);o[y*w+x]=win[4];}return o;}
function unsharp3(g,w,h,amt){const b=box3(g,w,h),o=new Uint8Array(g.length);for(let i=0;i<g.length;i++){let v=g[i]+amt*(g[i]-b[i]);o[i]=v<0?0:v>255?255:v|0;}return o;}
async function preprocess(file, meta, panel, scale, { binarize = false, invert = false, ops = [] } = {}) {
  const W = meta.width, H = meta.height;
  const sx = Math.round(panel.x*W), sy = Math.round(panel.y*H), sw = Math.round(panel.w*W), sh = Math.round(panel.h*H);
  const rs = Math.max(1, Math.min(scale, MAX_SIDE / Math.max(sw, sh)));
  const cw = Math.max(1, Math.round(sw*rs)), ch = Math.max(1, Math.round(sh*rs));
  const { data, info } = await sharp(file).extract({ left: sx, top: sy, width: sw, height: sh })
    .resize(cw, ch, { kernel: KERNEL }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w=info.width, h=info.height, n=w*h, gray = new Uint8Array(n); let min=255,max=0;
  for (let i=0,j=0;j<n;i+=info.channels,j++){const g=(data[i]*0.299+data[i+1]*0.587+data[i+2]*0.114)|0;gray[j]=g;if(g<min)min=g;if(g>max)max=g;}
  const range=Math.max(1,max-min); let ng=new Uint8Array(n);
  for(let j=0;j<n;j++)ng[j]=((gray[j]-min)*255/range)|0;
  for(const op of ops){if(op==='median')ng=median3(ng,w,h);else if(op==='unsharp')ng=unsharp3(ng,w,h,1.0);}
  const out=Buffer.allocUnsafe(n);
  const binT = binarize===true?132:(typeof binarize==='number'?binarize:null);
  for(let j=0;j<n;j++){let v=ng[j]; if(binT!=null)v=v>binT?0:255; else if(invert)v=255-v; out[j]=v;}
  return sharp(out,{raw:{width:w,height:h,channels:1}}).png().toBuffer();
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
  // mirror ocr.js extractLines: add denoise/sharpen passes and a higher scale for low-res regions
  const regionW = smp.panel.w * meta.width;
  const regionH = smp.panel.h * meta.height;
  const lowRes = regionW < 1150 || regionH < 720 || meta.width < 1280;
  const veryLowRes = regionW < 900 || regionH < 520 || meta.width < 1000;
  const variants = (process.env.VARIANTS ? VARIANTS : [
    {}, { binarize: 132 }, { binarize: 110 },
    ...(lowRes ? [{ ops: ['median','unsharp'], binarize: 132 }, { ops: ['unsharp'], binarize: 150 }] : []),
  ]);
  const scales = process.env.SCALES || !veryLowRes || SCALES.includes(5.2) ? SCALES : [...SCALES, 5.2];
  const perScale = [];
  for (const s of scales) for (const v of variants) {
    const key = `${KERNEL}|ms${MAX_SIDE}|${smp.file}|${cropKey}|${s}|${v.binarize?'b'+v.binarize:'n'}|${(v.ops||[]).join('+')}`;
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
