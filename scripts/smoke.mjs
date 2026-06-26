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

// run as admin so admin-only render paths are exercised
localStorage.setItem('clandash.v1.role', 'admin');
localStorage.setItem('clandash.v1.me', '관리자');

let pass = 0, fail = 0;
const ok = (name) => { console.log('  ✅ ' + name); pass++; };
const bad = (name, e) => { console.log('  ❌ ' + name + ' — ' + (e?.stack || e)); fail++; };

const { DB, Mutations } = await import('../docs/js/db.js');
const { computeSettlement, computeScores } = await import('../docs/js/calc.js');
const app = document.getElementById('app');

await DB.init();
console.log('DB.init: members=' + DB.state.members.length);

const views = {
  dashboard: (await import('../docs/js/views/dashboard.js')).renderDashboard,
  members: (await import('../docs/js/views/members.js')).renderMembers,
  participation: (await import('../docs/js/views/participation.js')).renderParticipation,
  diamond: (await import('../docs/js/views/diamond.js')).renderDiamond,
  rotation: (await import('../docs/js/views/rotation.js')).renderRotation,
  gear: (await import('../docs/js/views/gear.js')).renderGear,
  settings: (await import('../docs/js/views/settings.js')).renderSettings,
  distParams: (await import('../docs/js/views/distParams.js')).renderDistParams,
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

console.log('\n── render each view (member role) ──');
localStorage.setItem('clandash.v1.role', 'member');
for (const [name, fn] of Object.entries(views)) {
  try { app.innerHTML = ''; fn(); ok(`${name} (member) rendered`); }
  catch (e) { bad(name + ' (member)', e); }
}
localStorage.setItem('clandash.v1.role', 'admin');

console.log('\n── core mutations ──');
try {
  const before = DB.state.members.length;
  const m = Mutations.upsertMember({ name: '테스트원', cls: '전사', power: 50, score: 100 });
  if (DB.state.members.length === before + 1 && m.id) ok('upsertMember adds'); else bad('upsertMember', 'count');
  Mutations.upsertMember({ id: m.id, score: 175 });
  if (DB.state.members.find((x) => x.id === m.id).score === 175) ok('upsertMember edits'); else bad('upsertMember edit', 'score');
  const D = '2026-06-24';
  Mutations.addEventMembers(D, '7그룹', [m.id]);
  Mutations.addEventMembers(D, '심연 중앙', [m.id]);
  const scMap = computeScores(DB.state.participation.byDate, DB.state.contentCatalog, [m], {});
  if (scMap[m.id] === 65) ok(`date events→score 7그룹(15)+심연중앙(50)=${scMap[m.id]}`); else bad('event score', `got ${scMap[m.id]}, want 65`);
  Mutations.toggleEventMember(D, '7그룹', m.id); // remove
  if (!Mutations.getEvent(D, '7그룹').includes(m.id)) ok('toggleEventMember removes'); else bad('toggle', 'still present');
  Mutations.removeMember(m.id);
  if (DB.state.members.length === before) ok('removeMember'); else bad('removeMember', 'count');
} catch (e) { bad('mutations', e); }

console.log('\n── undo / redo ──');
try {
  const n0 = DB.state.members.length;
  const tm = Mutations.upsertMember({ name: '언두테스트', cls: '전사' }); DB.commit();
  const n1 = DB.state.members.length;
  const u = DB.undo();
  if (u && DB.state.members.length === n0) ok(`undo (${n1}→${DB.state.members.length})`); else bad('undo', `len=${DB.state.members.length}`);
  const r = DB.redo();
  if (r && DB.state.members.length === n1) ok(`redo (→${DB.state.members.length})`); else bad('redo', `len=${DB.state.members.length}`);
  DB.undo(); // clean up the test member
} catch (e) { bad('undo/redo', e); }

console.log('\n── settlement consistency (post-init, current roster) ──');
try {
  const r = computeSettlement(DB.state);
  const t = r.totals;
  // engine correctness is proven separately; here assert internal consistency for the live roster
  const consistent = Math.abs(t.remaining) <= DB.state.members.length
    && t.staffSum === t.staffBudget && t.powerSum === t.powerBudget && r.verification.status === '정상';
  if (consistent) ok(`settlement consistent (분배 ${t.distributed.toLocaleString()} / 총 ${t.total.toLocaleString()}, 남는 ${t.remaining}, 검증 ${r.verification.status})`);
  else bad('settlement', `distributed=${t.distributed} total=${t.total} remaining=${t.remaining} staffSum=${t.staffSum}/${t.staffBudget} powerSum=${t.powerSum}/${t.powerBudget}`);
} catch (e) { bad('settlement', e); }

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ ' + fail + ' FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
