// ocr-experiment.mjs — test preprocessing recipes for recall, caching each OCR
// pass per (sample|scale|recipe). Evaluation recombines cached passes through
// the REAL consensusMatch() so configs are comparable to production.
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import fs from 'node:fs';
import { consensusMatch } from '../docs/js/ocr.js';
import { normName } from '../docs/js/util.js';

const G = JSON.parse(fs.readFileSync('scripts/_gt.json','utf8'));
const SAMPLES = [
  { file:'docs/_sample.png',  label:'#3(31)', panel:{x:0.15,y:0.17,w:0.72,h:0.70}, gt:G.GT3 },
  { file:'docs/_sample2.png', label:'#4(37)', panel:{x:0.01,y:0.05,w:0.98,h:0.94}, gt:G.GT4 },
  { file:'docs/_sample3.png', label:'#5(46)', panel:{x:0.005,y:0.07,w:0.99,h:0.92}, gt:G.GT5 },
  { file:'docs/_sample4.png', label:'#6(45)', panel:{x:0.005,y:0.07,w:0.99,h:0.92}, gt:G.GT6 },
];
const SCALES = [2.8, 3.6, 4.4, 5.2];
const MAX_SIDE = 5200, KERNEL = 'cubic';
const norm=(s)=>normName(s);
const eq=(a,b)=>{const x=norm(a),y=norm(b);return x&&(x===y||x.includes(y)||y.includes(x));};
function dedup(text){const seen=new Set(),out=[];for(const raw of String(text).split(/\n+/))for(const tok of raw.split(/[\s,，|/·•_\[\]()]+/)){const t=tok.trim();if(t.length<1)continue;const k=normName(t);if(!k||seen.has(k))continue;seen.add(k);out.push(t);}return out;}

// recipes: how to turn the gray panel into a tesseract input
const RECIPES = {
  raw:   { },                              // global stretch, light-on-dark (current)
  b132:  { binarize:132 },                 // global stretch + threshold (current)
  inv:   { invert:true },                  // dark-on-light, no threshold
  b110:  { binarize:110 },
  b155:  { binarize:155 },
  sharp: { invert:true, sharpen:true },    // unsharp then dark-on-light
  adapt: { adaptive:true },                // local-mean adaptive threshold
};

async function preprocess(file, meta, panel, scale, rec){
  const W=meta.width,H=meta.height;
  const sx=Math.round(panel.x*W),sy=Math.round(panel.y*H),sw=Math.round(panel.w*W),sh=Math.round(panel.h*H);
  const rs=Math.max(1,Math.min(scale,MAX_SIDE/Math.max(sw,sh)));
  const cw=Math.max(1,Math.round(sw*rs)),ch=Math.max(1,Math.round(sh*rs));
  let pipe=sharp(file).extract({left:sx,top:sy,width:sw,height:sh}).resize(cw,ch,{kernel:KERNEL});
  if(rec.sharpen) pipe=pipe.sharpen({sigma:1.2});
  const {data,info}=await pipe.removeAlpha().raw().toBuffer({resolveWithObject:true});
  const n=info.width*info.height, ch_=info.channels, gray=new Uint8Array(n);
  let min=255,max=0;
  for(let i=0,j=0;j<n;i+=ch_,j++){const g=(data[i]*0.299+data[i+1]*0.587+data[i+2]*0.114)|0;gray[j]=g;if(g<min)min=g;if(g>max)max=g;}
  const range=Math.max(1,max-min);
  const out=Buffer.allocUnsafe(n);
  if(rec.adaptive){
    // integral image → local mean (window R) → text(bright)>mean+C => black(0)
    const w=info.width,h=info.height,R=Math.max(8,Math.round(h*0.012)),C=10;
    const I=new Float64Array((w+1)*(h+1));
    for(let y=0;y<h;y++){let s=0;for(let x=0;x<w;x++){s+=gray[y*w+x];I[(y+1)*(w+1)+(x+1)]=I[y*(w+1)+(x+1)]+s;}}
    const mean=(x,y)=>{const x0=Math.max(0,x-R),y0=Math.max(0,y-R),x1=Math.min(w-1,x+R),y1=Math.min(h-1,y+R);
      const A=I[y0*(w+1)+x0],B=I[y0*(w+1)+(x1+1)],Cc=I[(y1+1)*(w+1)+x0],D=I[(y1+1)*(w+1)+(x1+1)];
      return (D-B-Cc+A)/((x1-x0+1)*(y1-y0+1));};
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const j=y*w+x;out[j]=gray[j]>mean(x,y)+C?0:255;}
  } else {
    for(let j=0;j<n;j++){let v=((gray[j]-min)*255/range)|0;if(rec.binarize!=null)v=v>rec.binarize?0:255;else if(rec.invert)v=255-v;out[j]=v;}
  }
  return sharp(out,{raw:{width:info.width,height:info.height,channels:1}}).png().toBuffer();
}

const CACHE=process.env.CACHE||'/tmp/exp_cache.json';
const cache=fs.existsSync(CACHE)?JSON.parse(fs.readFileSync(CACHE,'utf8')):{};
const save=()=>fs.writeFileSync(CACHE,JSON.stringify(cache));
const TJS=process.env.TJS_DIR||'./node_modules';
const worker=await createWorker('kor+eng',1,{corePath:TJS+'/tesseract.js-core',langPath:'.',gzip:false,logger:()=>{},workerPath:TJS+'/tesseract.js/src/worker-script/node/index.js'});
await worker.setParameters({tessedit_pageseg_mode:'11'});

const ONLY=(process.env.RECIPES||Object.keys(RECIPES).join(',')).split(',');
let budget=parseInt(process.env.MAXPASS||'14',10);
for(const smp of SAMPLES){ if(!fs.existsSync(smp.file))continue;
  const meta=await sharp(smp.file).metadata();
  for(const s of SCALES) for(const rk of ONLY){
    const key=`${smp.file}|${s}|${rk}`;
    if(cache[key]) continue;
    if(budget--<=0){ process.stderr.write('budget exhausted\n'); await worker.terminate(); save(); process.exit(2); }
    const buf=await preprocess(smp.file,meta,smp.panel,s,RECIPES[rk]);
    const {data}=await worker.recognize(buf);
    cache[key]=dedup(data.text||''); save();
    process.stderr.write(`done ${key}\n`);
  }
}
await worker.terminate();
process.stderr.write('ALL PASSES CACHED\n');
