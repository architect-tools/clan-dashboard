// build-roster.mjs — rebuild the canonical roster from the real active clan list
// (in-game decorated nicknames), merging 전투력/직업 from the 주간참여도 CSV
// (positionally, since the list is 투력-desc) and 참여점수 from the old 명단.
// Usage: node scripts/build-roster.mjs <weeklyCsv> <seedFile>
import { readFileSync, writeFileSync } from 'node:fs';
import { matchName } from '../docs/js/util.js';

const weeklyCsv = process.argv[2];
const seedFile = process.argv[3] || 'docs/data/seed.json';

// The real current clan, in 투력 order (as supplied by the user). In-game nicknames.
const CANON = ['보스','페커리','붉으래','우소츠키','돈가츠','딱꽁','아싸다','치느','하나둘셋얍','이루릴',
  '폭력','데드','빛싸다','여신민아','버기','제크로무','다무리','스팔','나유','Doberman',
  '치치','헤세메','KDA','까치','승냉','윤재','해지슬','하도유','Babyee','xooos',
  'oO서영Oo','s하울s','헤파이토스','EXE','v구름v','권성준','비타민나라','VISVIM','리턴','헤라클',
  '배방3','잠원동쓰레빠','두비두밥','카운터펀치','여름빛','조말순','샬루키','노획','끝판왕랑사부','마무리'];

function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else if (c !== '\r') f += c; }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const num = (s) => { const n = parseFloat(String(s ?? '').replace(/[,\s]/g, '')); return Number.isFinite(n) ? n : 0; };

// weekly roster (positional): rows 5+ → col0=order, col1=name, col2=class, col3=power
const wrows = parseCSV(readFileSync(weeklyCsv, 'utf8'));
const weekly = [];
for (let i = 4; i < wrows.length; i++) {
  const r = wrows[i]; const name = (r[1] || '').trim();
  if (!name) continue;
  weekly.push({ name, cls: (r[2] || '').trim(), power: num(r[3]) });
}

const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
const oldMembers = seed.members; // for 참여점수 carryover

// Clan merger → fresh start: participation scores reset to 0 (rebuilt via tracking).
const members = CANON.map((name, i) => {
  const w = weekly[i] || {};                      // positional 전투력/직업
  const m = matchName(name, oldMembers, 0.7);     // fuzzy fallback for 직업 only
  return {
    id: i + 1, order: i + 1, name,
    cls: w.cls || (m ? m.member.cls : ''),
    power: w.power || (m ? m.member.power : 0),
    score: 0,                                     // fresh start (clan merger)
    active: true, note: !w.name ? '전투력 미입력' : '',
  };
});

// reconcile staff to those present in the new roster
const names = new Set(members.map((m) => m.name));
const keptStaff = (seed.staff || []).filter((s) => names.has(s.name));
const finalStaff = keptStaff.length ? keptStaff : [];
const eachRatio = finalStaff.length ? (seed.settings.staffRatio / finalStaff.length) : 0;
finalStaff.forEach((s) => { s.ratio = eachRatio; });

seed.members = members;
seed.staff = finalStaff;
seed.meta = { ...seed.meta, rosterSource: '활동 클랜 50명 (게임 내 닉네임)', schemaVersion: 1 };

writeFileSync(seedFile, JSON.stringify(seed, null, 2), 'utf8');

const carried = members.filter((m) => m.score > 0).length;
const noPower = members.filter((m) => !m.power).length;
console.log(`roster rebuilt → ${members.length}명`);
console.log(`  전투력 매핑: ${members.length - noPower}명 (미입력 ${noPower})`);
console.log(`  참여점수 병합: ${carried}명`);
console.log(`  운영진(로스터 내): ${finalStaff.map((s) => s.name).join(', ') || '없음'} — 각 ${(eachRatio * 100).toFixed(1)}%`);
