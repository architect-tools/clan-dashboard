// build-seed.mjs — Parse the source Google-Sheet CSV exports into a normalized seed.json.
// Usage: node scripts/build-seed.mjs <csvDir> <outFile>
// The CSV dir must contain the files downloaded from the three source spreadsheets
// (see README "데이터 가져오기"). Re-runnable: regenerates docs/data/seed.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const csvDir = process.argv[2];
const outFile = process.argv[3] || 'docs/data/seed.json';
if (!csvDir) { console.error('usage: node scripts/build-seed.mjs <csvDir> [outFile]'); process.exit(1); }

// --- tiny CSV parser (handles quoted fields w/ commas + escaped quotes) ---
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const load = (name) => {
  const p = join(csvDir, name);
  if (!existsSync(p)) { console.warn('  (missing) ' + name); return []; }
  return parseCSV(readFileSync(p, 'utf8'));
};
const num = (s) => {
  if (s == null) return 0;
  const n = parseFloat(String(s).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const clean = (s) => (s == null ? '' : String(s).trim());

// ---------------- members (from 명단) ----------------
// header row at index 2: 기준순번,이름,직업,전투력,전투력순위,참여점수,참여티어
const mRows = load('s3_명단.csv');
const members = [];
for (let i = 3; i < mRows.length; i++) {
  const r = mRows[i];
  const name = clean(r[1]);
  if (!name) continue;
  members.push({
    id: members.length + 1,
    order: num(r[0]),               // 기준순번
    name,
    cls: clean(r[2]),               // 직업
    power: num(r[3]),               // 전투력
    score: num(r[5]),               // 참여점수 (manually-curated, drives tier)
    active: true,
    note: '',
  });
}

// ---------------- settings (from 설정) ----------------
const sRows = load('s3_설정.csv');
const findVal = (label) => {
  for (const r of sRows) if (clean(r[0]) === label) return r[1];
  return null;
};
const settings = {
  totalDiamonds: num(findVal('총 다이아')) || 170000,
  staffRatio: num(findVal('운영진 비율')) / 100 || 0.05,
  powerRatio: num(findVal('투력 비율')) / 100 || 0.40,
  participationRatio: num(findVal('참여도 비율')) / 100 || 0.55,
};
// tier cuts: cols 7=티어,8=최소점수,9=티어배수 (rows 4.. in 설정)
const tiers = [];
for (const r of sRows) {
  const t = clean(r[7]);
  if (['S', 'A', 'B', 'C', 'D', 'F'].includes(t)) {
    tiers.push({ tier: t, minScore: num(r[8]), mult: num(r[9]) });
  }
}
tiers.sort((a, b) => b.minScore - a.minScore);
// 고투 (combat-power top ranks): cols 3=순위,4=전체비율
const powerRanks = [];
for (const r of sRows) {
  const rank = num(r[3]);
  const pct = clean(r[4]);
  if (rank >= 1 && rank <= 50 && /%/.test(pct)) powerRanks.push({ rank, pct: num(pct) / 100 });
}
powerRanks.sort((a, b) => a.rank - b.rank);

// ---------------- staff (from 운영진) ----------------
const stRows = load('s3_운영진.csv');
const staff = [];
for (let i = 3; i < stRows.length; i++) {
  const r = stRows[i];
  const name = clean(r[0]);
  if (!name || name === '합계') continue;
  staff.push({ name, ratio: num(r[1]) / 100 });
}

// ---------------- content catalog (from 참여도점수표, NEW side cols 6..9) ----------------
const cRows = load('s1_참여도점수표.csv');
const contentCatalog = [];
let curCat = '';
for (const r of cRows) {
  const cat = clean(r[6]);
  const name = clean(r[7]);
  const per = clean(r[8]);
  const cnt = clean(r[9]);
  if (cat) curCat = cat;
  if (!name || per === '' || isNaN(num(per))) continue;
  if (name.includes('겹칠')) continue;
  contentCatalog.push({
    category: curCat,
    name,
    points: num(per),       // points per participation
    weekly: num(cnt),       // weekly occurrence count (cap)
    active: num(per) > 0,
  });
}

// ---------------- rotation queues (from 순번제) ----------------
function readQueue(file, nameCol, statusCol, queueName) {
  const rows = load(file);
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = clean(r[nameCol]);
    if (!name) continue;
    const status = statusCol != null ? clean(r[statusCol]) : '';
    items.push({ name, status });
  }
  return { name: queueName, items };
}
const rotationQueues = [
  readQueue('s2_방어구.csv', 2, 3, '상급 방어구 설계도'),
  readQueue('s2_장신구.csv', 2, 4, '상급 장신구 설계도'),
];

// weapon progress (from 무기): 주무기/보조/보조2 stars per member
const wRows = load('s2_무기.csv');
const weaponProgress = [];
for (let i = 1; i < wRows.length; i++) {
  const r = wRows[i];
  const name = clean(r[0]);
  if (!name) continue;
  weaponProgress.push({
    name, cls: clean(r[1]),
    main: clean(r[2]), sub1: clean(r[3]), sub2: clean(r[4]),
  });
}

const seed = {
  meta: {
    clanName: '불면증',
    generatedFrom: 'Google Sheets CSV export',
    generatedNote: 'node scripts/build-seed.mjs',
    schemaVersion: 1,
  },
  settings,
  tiers,
  powerRanks,
  staff,
  members,
  contentCatalog,
  rotationQueues,
  weaponProgress,
};

writeFileSync(outFile, JSON.stringify(seed, null, 2), 'utf8');
console.log(`seed written -> ${outFile}`);
console.log(`  members=${members.length} tiers=${tiers.length} powerRanks=${powerRanks.length} staff=${staff.length} content=${contentCatalog.length} queues=${rotationQueues.length} weapons=${weaponProgress.length}`);
