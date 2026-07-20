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
globalThis.fetch = async (u, opts = {}) => {
  const url = String(u);
  if (url.includes('script.google.com')) {
    const body = JSON.stringify({ data: opts.method === 'POST' ? { ok: true } : null });
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  }
  const path = url.includes('seed.json') ? 'docs/data/seed.json' : null;
  if (!path) throw new Error('unexpected fetch: ' + u);
  const text = readFileSync(path, 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
};

// run as admin so admin-only render paths are exercised
localStorage.setItem('clandash.v1.role', 'admin');
localStorage.setItem('clandash.v1.me', '관리자');

let pass = 0, fail = 0;
const ok = (name) => { console.log('  ✅ ' + name); pass++; };
const bad = (name, e) => { console.log('  ❌ ' + name + ' — ' + (e?.stack || e)); fail++; };

// Smoke rendering uses the local seed; live transport has its own integration test.
const { CONFIG } = await import('../docs/js/config.js');
CONFIG.SUPABASE_URL = '';
CONFIG.SUPABASE_PUBLISHABLE_KEY = '';

const { DB, Mutations } = await import('../docs/js/db.js');
const { computeSettlement, computeScores } = await import('../docs/js/calc.js');
const { recognitionMarkers } = await import('../docs/js/ocr.js');
const { applyAtomicAction } = await import('../docs/js/db.js');
const app = document.getElementById('app');

await DB.init();
console.log('DB.init: members=' + DB.state.members.length);

const dashboardModule = await import('../docs/js/views/dashboard.js');
const views = {
  dashboard: dashboardModule.renderDashboard,
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

console.log('\n── 참여 기록 콘텐츠 정렬 ──');
try {
  const arcanon = DB.state.contentCatalog.find((c) => c.category === '거인의 탑' && c.name === '아르카논');
  if (!arcanon) DB.state.contentCatalog.push({ category: '거인의 탑', name: '아르카논', points: 0, weekly: 0, active: true });
  app.innerHTML = '';
  views.participation();
  const towerRow = [...app.querySelectorAll('.content-cat')]
    .find((row) => row.querySelector('.content-cat-label')?.textContent === '거인의 탑');
  const towerButtons = [...(towerRow?.querySelectorAll('.content-btn') || [])].map((button) => button.textContent.trim());
  const expected = ['기슈칼', '할파시암', '드루가무', '아르카논'];
  if (expected.every((name, index) => towerButtons[index] === name)) ok(`거인의 탑 버튼 순서: ${expected.join(' → ')}`);
  else bad('거인의 탑 버튼 순서', `got [${towerButtons.join(', ')}]`);
  if (!arcanon) DB.state.contentCatalog = DB.state.contentCatalog.filter((c) => !(c.category === '거인의 탑' && c.name === '아르카논'));
} catch (e) { bad('참여 기록 콘텐츠 정렬', e); }


console.log('\n── request intake forms ──');
try {
  dashboardModule.openBugReportForm();
  let modal = document.querySelector('.modal-overlay');
  const bugText = modal?.textContent || '';
  if (bugText.includes('버그 리포트 접수') && bugText.includes('재현 절차') && bugText.includes('자동 처리 요청')) {
    ok('버그 리포트 전용 접수 폼');
  } else bad('bug request form', bugText);
  modal?.remove();

  dashboardModule.openImprovementForm();
  modal = document.querySelector('.modal-overlay');
  const improvementText = modal?.textContent || '';
  if (improvementText.includes('건의/개선사항 접수') && improvementText.includes('현재 불편/요청 배경') && improvementText.includes('자동 처리 요청')) {
    ok('건의/개선사항 전용 접수 폼');
  } else bad('improvement request form', improvementText);
  modal?.remove();

  const request = Mutations.addQaReport({
    type: 'improvement',
    title: '자동 처리 스모크',
    automationStatus: 'queued',
  });
  if (request.type === 'improvement' && request.automationStatus === 'queued' && request.status === 'open') {
    ok('요청 유형·자동 처리 상태 저장');
  } else bad('request normalization', JSON.stringify(request));

  const completed = Mutations.addQaReport({
    type: 'bug',
    title: '백로그 완료 항목',
    automationStatus: 'completed',
  });
  Mutations.updateQaReport(completed.id, { status: 'resolved', reply: '검증 완료' });
  dashboardModule.openQaBacklog(request.id);
  modal = document.querySelector('.modal-overlay');
  const filters = [...(modal?.querySelectorAll('.qa-backlog-filter') || [])];
  const selectedSlot = modal?.querySelector('.qa-slot.active b')?.textContent;
  const completedFilter = filters.find((button) => button.dataset.filter === 'completed');
  completedFilter?.click();
  const completedDetail = modal?.querySelector('.qa-detail')?.textContent || '';
  if (modal?.textContent.includes('요청 백로그 히스토리') && filters.length === 5
      && selectedSlot === request.slot && completedDetail.includes('백로그 완료 항목') && completedDetail.includes('해결')) {
    ok('백로그 상태 필터·슬롯 상세 모달');
  } else bad('backlog history modal', modal?.textContent || 'missing modal');
  modal?.remove();
  Mutations.removeQaReport(completed.id);
  Mutations.removeQaReport(request.id);
} catch (e) { bad('request intake forms', e); }

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

console.log('\n── 참여 체크인: 단일 선택 소스(두 목록 일치) ──');
try {
  localStorage.setItem('clandash.v1.role', 'admin');
  const renderParticipation = views.participation;
  const todayISO = new Date().toISOString().slice(0, 10);
  const roster = DB.state.members.filter((m) => m.active !== false);
  const [A, B, C] = [roster[0].id, roster[1].id, roster[2].id];
  const CONTENT = '심연 중앙';
  Mutations.setEventMembers(todayISO, CONTENT, [A]);            // A 는 이미 기록된 상태
  app.innerHTML = ''; renderParticipation();
  const openBtn = [...app.querySelectorAll('.content-btn')].find((b) => b.textContent.includes(CONTENT));
  openBtn.click();                                             // selContent 설정 → 체크인 패널 렌더
  const cbOf = (id) => app.querySelector(`.manual-pick input[data-mid="${id}"]`);
  if (app.querySelector('.checkin') && cbOf(A)?.checked) ok('체크인: 기존 기록(A) 자동 체크'); else bad('checkin open', 'panel/A');
  const setCb = (id, on) => { const cb = cbOf(id); cb.checked = on; cb.dispatchEvent(new w.Event('change')); };
  setCb(A, false); setCb(B, true); setCb(C, true);            // A 해제, B·C 추가
  [...app.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('참여 기록')).click();
  const rec = new Set(Mutations.getEvent(todayISO, CONTENT));
  if (rec.size === 2 && !rec.has(A) && rec.has(B) && rec.has(C)) ok('체크인 확정 = selected(단일소스): A제거·B·C추가'); else bad('checkin confirm', `got [${[...rec]}]`);
  Mutations.setEventMembers(todayISO, CONTENT, []);           // cleanup
} catch (e) { bad('참여 체크인 단일선택', e); }

console.log('\n── 멤버 UI: 본인 셀·입찰은 원자적 API만 사용 ──');
try {
  const savedState = JSON.parse(JSON.stringify(DB.state));
  const originalAtomic = DB.atomicAction;
  const me = DB.state.members.find((m) => m.active !== false);
  localStorage.setItem('clandash.v1.role', 'member');
  localStorage.setItem('clandash.v1.me', me.name);
  const calls = [];
  DB.atomicAction = async (kind, payload = {}) => {
    calls.push({ kind, payload });
    try { return { ok: true, result: applyAtomicAction(DB.state, kind, payload,
      { actor: me.name, role: localStorage.getItem('clandash.v1.role') || 'member' }) }; }
    catch (e) { return { ok: false, error: e.message }; }
  };

  app.innerHTML = ''; views.gear();
  const ownEquip = app.querySelector('.equip-status-tbl tr.me-row td.editable');
  const otherEditable = app.querySelector('.equip-status-tbl tr:not(.me-row) td.editable');
  ownEquip?.click();
  const equipSave = [...document.querySelectorAll('.modal-overlay button')].find((b) => b.textContent.trim() === '저장');
  equipSave?.click(); await new Promise((resolve) => setTimeout(resolve, 0));
  const ownToggle = app.querySelector('.me-row button.sk-toggle');
  ownToggle?.click(); await new Promise((resolve) => setTimeout(resolve, 0));
  if (ownEquip && !otherEditable && calls.some((c) => c.kind === 'equipment.set') && calls.some((c) => c.kind === 'skill.toggle' || c.kind === 'board.toggle')) {
    ok('멤버 장비/현황: 본인만 편집 + atomicAction 호출');
  } else bad('member atomic gear UI', JSON.stringify({ ownEquip: !!ownEquip, otherEditable: !!otherEditable, calls }));

  DB.state.sales = [{ id: 'smoke-sale', item: '동시성 테스트', bidType: '선착순', basePrice: 10, deadline: Date.now() + 60000, bids: [] }];
  app.innerHTML = ''; views.rotation();
  [...app.querySelectorAll('button')].find((b) => b.textContent.trim() === '+ 입찰')?.click();
  [...document.querySelectorAll('.modal-overlay button')].find((b) => b.textContent.trim() === '입찰')?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (calls.some((c) => c.kind === 'sale.bid') && DB.state.sales[0]?.bids.some((b) => b.name === me.name)) ok('멤버 입찰: atomicAction으로 본인 입찰 추가');
  else bad('member atomic bid UI', JSON.stringify(calls));

  localStorage.setItem('clandash.v1.role', 'admin');
  DB.state.sales = [{ id: 'smoke-cancel', item: '삭제 유지 테스트', bidType: '투력순', basePrice: 10,
    deadline: Date.now() + 60000, bids: [{ name: '탈퇴한멤버', amount: 0 }] }];
  app.innerHTML = ''; views.rotation();
  app.querySelector('button[title="입찰 취소(관리자)"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const refreshedSales = JSON.parse(JSON.stringify(DB.state.sales));
  if (calls.some((c) => c.kind === 'sale.cancelBid' && c.payload.memberName === '탈퇴한멤버')
      && refreshedSales[0]?.bids.length === 0) ok('관리자 입찰 삭제: 서버 확인 후 새로고침 상태에도 유지');
  else bad('admin atomic bid cancel UI', JSON.stringify({ calls, refreshedSales }));

  const originalCommitNow = DB.commitNow;
  try {
    let dropSaveConfirmed = false;
    DB.commitNow = async () => { dropSaveConfirmed = true; return true; };
    DB.state.dropLog = [{ id: 'drop-save-test', date: '2099-01-01', content: '즉시 저장 테스트', item: '테스트 드랍', note: '' }];
    app.innerHTML = ''; views.rotation();
    const dropRow = [...app.querySelectorAll('tr')].find((tr) => tr.textContent.includes('즉시 저장 테스트'));
    dropRow?.querySelector('button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (dropSaveConfirmed && !DB.state.dropLog.some((x) => x.id === 'drop-save-test')) ok('드랍 삭제: 서버 저장 확인 후 완료');
    else bad('drop delete immediate save', JSON.stringify({ dropSaveConfirmed, dropLog: DB.state.dropLog }));
  } finally {
    DB.commitNow = originalCommitNow;
  }
  localStorage.setItem('clandash.v1.role', 'member');

  CONFIG.APPS_SCRIPT_URL = 'https://script.google.com/test-remote-guard';
  DB._snapshot = JSON.parse(JSON.stringify(DB.state));
  const beforePower = DB.state.members[0].power;
  DB.state.members[0].power = beforePower + 999;
  const blockedCommit = DB.commit();
  if (blockedCommit === false && DB.state.members[0].power === beforePower) ok('멤버 전체 상태 저장 차단 + 로컬 변경 복구');
  else bad('member full save guard', `commit=${blockedCommit}, power=${DB.state.members[0].power}`);

  DB.atomicAction = originalAtomic;
  CONFIG.APPS_SCRIPT_URL = '';
  DB.state = savedState; DB._snapshot = JSON.parse(JSON.stringify(savedState));
  localStorage.setItem('clandash.v1.role', 'admin');
} catch (e) {
  CONFIG.APPS_SCRIPT_URL = '';
  localStorage.setItem('clandash.v1.role', 'admin');
  bad('멤버 원자적 UI', e);
}

console.log('\n── OCR 인식 마커 좌표 연결 ──');
try {
  const [a, b, c] = DB.state.members.slice(0, 3);
  const entries = [
    { member: a, score: 0.96, token: a.name },
    { member: b, score: 0.78, token: b.name },
  ];
  const markers = recognitionMarkers({
    matches: [{ member: a, score: 0.91, slot: { x: 1, y: 2, w: 30, h: 10 } }, { member: b, score: 0.82, slot: { x: 40, y: 2, w: 30, h: 10 } }],
    anchors: [{ member: a, score: 0.95, rect: { x: 5, y: 4, w: 12, h: 6 } }, { member: c, score: 0.99, rect: { x: 80, y: 2, w: 12, h: 6 } }],
  }, entries);
  const ma = markers.find((m) => m.member.id === a.id);
  const mb = markers.find((m) => m.member.id === b.id);
  if (markers.length === 2 && ma?.rect.x === 5 && mb?.rect.x === 40) ok('마커: 최종 인식자만 표시 + 단어 좌표 우선');
  else bad('OCR marker mapping', JSON.stringify(markers));
} catch (e) { bad('OCR marker mapping', e); }

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
