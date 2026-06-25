import fs from 'node:fs';
import { consensusMatch } from '../docs/js/ocr.js';
import { normName } from '../docs/js/util.js';
const G=JSON.parse(fs.readFileSync('scripts/_gt.json','utf8'));
const cache=JSON.parse(fs.readFileSync('/tmp/exp_cache.json','utf8'));
const roster=JSON.parse(fs.readFileSync('docs/data/seed.json','utf8')).members;
const SAMPLES=[['docs/_sample.png','#3',G.GT3],['docs/_sample2.png','#4',G.GT4],['docs/_sample3.png','#5',G.GT5],['docs/_sample4.png','#6',G.GT6]];
const SCALES=[2.8,3.6,4.4,5.2];
const norm=(s)=>normName(s);
const eq=(a,b)=>{const x=norm(a),y=norm(b);return x&&(x===y||x.includes(y)||y.includes(x));};
function evalConfig(recipes){
  let auto=0,found=0,wrong=0,total=0; const wrongList=[],reviewList=[];
  for(const [file,label,gt] of SAMPLES){
    const perScale=[];
    for(const s of SCALES) for(const rk of recipes){ const k=`${file}|${s}|${rk}`; if(cache[k]) perScale.push(cache[k]); }
    const m=consensusMatch(perScale,roster);
    const names=m.matched.map(x=>x.member.name), maybe=m.maybe.map(x=>x.member.name);
    total+=gt.length;
    auto+=gt.filter(g=>names.some(h=>eq(h,g))).length;
    found+=gt.filter(g=>[...names,...maybe].some(h=>eq(h,g))).length;
    const w=m.matched.filter(x=>!gt.some(g=>eq(x.member.name,g))).map(x=>x.member.name);
    wrong+=w.length; if(w.length) wrongList.push(label+':'+w.join(','));
    const rev=gt.filter(g=>!names.some(h=>eq(h,g))&&maybe.some(h=>eq(h,g)));
    if(rev.length) reviewList.push(label+':'+rev.join(','));
  }
  return {auto,found,total,wrong,wrongList,reviewList};
}
const CONFIGS={
  'PROD [raw,b132]':['raw','b132'],
  'b132,b110,b155,sharp':['b132','b110','b155','sharp'],
  'raw,b132,b110,sharp':['raw','b132','b110','sharp'],
  'raw,b132,sharp,adapt':['raw','b132','sharp','adapt'],
  'raw,b132,b110,b155,sharp':['raw','b132','b110','b155','sharp'],
  'raw,b132,inv,sharp':['raw','b132','inv','sharp'],
  'raw,b132,inv,b110,sharp':['raw','b132','inv','b110','sharp'],
  'raw,b132,b155,sharp,adapt':['raw','b132','b155','sharp','adapt'],
};
console.log('config'.padEnd(20),'auto','found','wrong','| review / wrong detail');
for(const [name,rec] of Object.entries(CONFIGS)){
  const r=evalConfig(rec);
  console.log(name.padEnd(20), String(r.auto+'/'+r.total).padEnd(7), String(r.found+'/'+r.total).padEnd(7), String(r.wrong).padEnd(6),'| rev:'+r.reviewList.join(' ')+(r.wrongList.length?'  WRONG:'+r.wrongList.join(' '):''));
}
