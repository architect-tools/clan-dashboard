// smoke.mjs — render every view in a jsdom DOM with the seed data and assert
// it produces output without throwing. Also exercises core mutations + settlement.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><div id="app"></div></body></html>',
  { url: 'http://localhost/', pretendToBeVisual: true });
const w = dom.window;
for (const k of ['window', 'document', 'localStorage', 'Image', 'Blob', 'Node', 'HTMLElement', 'getComputedStyle'])
  try { globalThis[k] = w[k]; } catch { /* read-only global — leave node's */ }
// keep Node's native performance (jsdom's shim self-recurses when made global)
globalThis.location = w.location;
globalThis.URL = w.URL;
globalThis.fetch = async (u) => {
  const path = String(u).includes('seed.json') ? 'docs/data/seed.json' : null;
  if (!path) throw new Error('unexpected fetch: ' + u);
  const text = readFileSync(path, 'utf8');
  return { ok: true, json: async () => JSON.parse(text), text: async () => text };
};

let pass = 0, fail = 0;
const ok = (name) => { console.log('  ✅ ' + name); pass++; };
const bad = (name, e) => { console.log('  ❌ ' + name + ' — ' + (e?.stack || e)); fail++; };

const { DB, Mutations } = await import('../docs/js/db.js');
const { computeSettlement, scoreFromAttendance } = await import('../docs/js/calc.js');
const app = document.getElementById('app');

await DB.init();
console.log('DB.init: members=' + DB.state.members.length);

const views = {
  dashboard: (await import('../docs/js/views/dashboard.js')).renderDashboard,
  members: (await import('../docs/js/views/members.js')).renderMembers,
  participation: (await import('../docs/js/views/participation.js')).renderParticipation,
  diamond: (await import('../docs/js/views/diamond.js')).renderDiamond,
  rotation: (await import('../docs/js/views/rotation.js')).renderRotation,
  schedule: (await import('../docs/js/views/schedule.js')).renderSchedule,
  settings: (await import('../docs/js/views/settings.js')).renderSettings,
};

console.log('\n── render each view ──');
for (const [name, fn] of Object.entries(views)) {
  try {
    app.innerHTML = '';
    fn();
    const html = app.innerHTML;
    if (app.childElementCount > 0 && html.length > 50) ok(`${name} rendered (${html.length} chars)`);
    else bad(name, 'empty output');
  } catch (e) { bad(name, e); }
}

console.log('\n── core mutations ──');
try {
  const before = DB.state.members.length;
  const m = Mutations.upsertMember({ name: '테스트원', cls: '전사', power: 50, score: 100 });
  if (DB.state.members.length === before + 1 && m.id) ok('upsertMember adds'); else bad('upsertMember', 'count');
  Mutations.upsertMember({ id: m.id, score: 175 });
  if (DB.state.members.find((x) => x.id === m.id).score === 175) ok('upsertMember edits'); else bad('upsertMember edit', 'score');
  Mutations.bumpAttendance(m.id, '7그룹', 1);
  Mutations.bumpAttendance(m.id, '심연 중앙', 1);
  const att = Mutations.weekData()[m.id];
  const sc = scoreFromAttendance(att, DB.state.contentCatalog);
  if (sc === 65) ok(`attendance→score 7그룹(15)+심연중앙(50)=${sc}`); else bad('attendance score', `got ${sc}, want 65`);
  Mutations.removeMember(m.id);
  if (DB.state.members.length === before) ok('removeMember'); else bad('removeMember', 'count');
} catch (e) { bad('mutations', e); }

console.log('\n── settlement re-verify (post-init) ──');
try {
  const r = computeSettlement(DB.state);
  const c = r.rows.find((x) => x.name === '붉으래');
  if (c && c.total === 17454 && r.totals.remaining === 3) ok(`settlement intact (붉으래=${c.total}, 남는=${r.totals.remaining})`);
  else bad('settlement', `붉으래=${c?.total} remaining=${r.totals.remaining}`);
} catch (e) { bad('settlement', e); }

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ ' + fail + ' FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
