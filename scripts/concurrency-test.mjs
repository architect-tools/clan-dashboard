// concurrency-test.mjs — exercise the Apps Script atomic mutation engine with an
// in-memory state store. Requests represent independent clients that all started
// from the same stale snapshot; the server must load latest state under its lock.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const source = readFileSync('apps-script/Code.gs', 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));
let uuidN = 0, lockDepth = 0, lockAcquires = 0;

const context = vm.createContext({
  console,
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => '7979' }) },
  LockService: { getScriptLock: () => ({
    waitLock() { assert.equal(lockDepth, 0, 'script lock must serialize writers'); lockDepth++; lockAcquires++; },
    tryLock() { assert.equal(lockDepth, 0); lockDepth++; lockAcquires++; return true; },
    releaseLock() { assert.equal(lockDepth, 1); lockDepth--; },
  }) },
  Utilities: {
    getUuid: () => `uuid-${++uuidN}`,
    formatDate: (date, _tz, format) => format === 'yyyy-MM-dd' ? date.toISOString().slice(0, 10) : date.toISOString(),
  },
  Session: { getScriptTimeZone: () => 'Asia/Seoul' },
  ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (text) => ({ setMimeType() { return this; }, text }) },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({}) },
});
vm.runInContext(source, context, { filename: 'Code.gs' });

let store = {
  meta: { clanName: '동시성테스트', schemaVersion: 2, revision: 0, adminRevision: 0, appliedMutations: [] },
  staff: [],
  members: [
    { id: 1, name: '멤버A', cls: '전사', active: true, power: 100, score: 10, equip: {}, skills: {} },
    { id: 2, name: '멤버B', cls: '마법사', active: true, power: 200, score: 20, equip: {}, skills: {} },
    { id: 3, name: '멤버C', cls: '사냥꾼', active: true, power: 300, score: 30, equip: {}, skills: {} },
  ],
  statusBoards: [{ id: 'board-1', name: '플랫폼', columns: ['PC', '모바일'], data: {} }],
  appSettings: { managedStones: [{ name: '공용석', star: 5 }] },
  sales: [
    { id: 'sale-1', item: '테스트 아이템', bidType: '경매', basePrice: 10, deadline: Date.now() + 3600000, bids: [] },
    { id: 'sale-stale', item: '과거 입찰', bidType: '투력순', basePrice: 10, deadline: Date.now() + 3600000,
      bids: [{ name: '탈퇴한멤버', amount: 0 }] },
  ],
  distributionLog: [],
};

// Replace spreadsheet I/O only; mutation/business/locking code remains Code.gs.
context.ss = () => ({});
context.loadState = () => clone(store);
context.writeStateSheet = (_book, state) => { store = clone(state); };
context.syncAtomicSheet = () => {};
context.writeTabs = () => {};

const mutate = (body) => context.withStateLock(() => context.mutateState({
  token: '7979', role: 'member', payload: {}, ...body,
}));

// Different members edit different logical cells from stale clients.
mutate({ mutationId: 'a-equip', actor: '멤버A', kind: 'equipment.set', payload: { memberId: 1, slot: '주무기', value: { star: 5, tier: 4.5, enhance: 8 } } });
mutate({ mutationId: 'b-equip', actor: '멤버B', kind: 'equipment.set', payload: { memberId: 2, slot: '투구', value: { star: 4, tier: 3.5, enhance: 6 } } });
mutate({ mutationId: 'a-skill', actor: '멤버A', kind: 'skill.toggle', payload: { memberId: 1, category: '주문석', key: 'A스킬' } });
mutate({ mutationId: 'a-skill', actor: '멤버A', kind: 'skill.toggle', payload: { memberId: 1, category: '주문석', key: 'A스킬' } });
mutate({ mutationId: 'b-board', actor: '멤버B', kind: 'board.toggle', payload: { memberId: 2, boardId: 'board-1', column: '모바일' } });
assert.equal(store.members[0].equip['주무기'].enhance, 8);
assert.equal(store.members[1].equip['투구'].tier, 3.5);
assert.equal(store.members[0].skills['주문석']['A스킬'], true);
assert.equal(store.statusBoards[0].data['2']['모바일'], true);

// Delta actions never lose increments, and a retried request is applied once.
for (let i = 0; i < 8; i++) mutate({ mutationId: `a-count-${i}`, actor: '멤버A', kind: 'skill.adjust', payload: { memberId: 1, key: '공용석__5', delta: 1 } });
mutate({ mutationId: 'a-count-7', actor: '멤버A', kind: 'skill.adjust', payload: { memberId: 1, key: '공용석__5', delta: 1 } });
assert.equal(store.members[0].skills['공용주문석']['공용석__5'], 8, 'retry must not double increment');

// Concurrent bids append independently; server-side close uses the latest set.
mutate({ mutationId: 'bid-a', actor: '멤버A', kind: 'sale.bid', payload: { saleId: 'sale-1', memberId: 1, amount: 100 } });
mutate({ mutationId: 'bid-b', actor: '멤버B', kind: 'sale.bid', payload: { saleId: 'sale-1', memberId: 2, amount: 250 } });
assert.deepEqual(store.sales[0].bids.map((b) => b.name), ['멤버A', '멤버B']);
assert.throws(() => mutate({ mutationId: 'cancel-cross', actor: '멤버B', kind: 'sale.cancelBid', payload: { saleId: 'sale-1', memberId: 1 } }), /본인 데이터/);
mutate({ mutationId: 'cancel-a', actor: '멤버A', kind: 'sale.cancelBid', payload: { saleId: 'sale-1', memberId: 1 } });
assert.deepEqual(clone(context.loadState(false)).sales.find((s) => s.id === 'sale-1').bids.map((b) => b.name), ['멤버B'],
  '새로고침으로 다시 읽어도 삭제한 입찰이 없어야 한다');
mutate({ mutationId: 'rebid-a', actor: '멤버A', kind: 'sale.bid', payload: { saleId: 'sale-1', memberId: 1, amount: 150 } });
assert.deepEqual(store.sales[0].bids.map((b) => b.name), ['멤버B', '멤버A']);
mutate({ mutationId: 'cancel-stale-admin', actor: '멤버C', role: 'admin', kind: 'sale.cancelBid',
  payload: { saleId: 'sale-stale', memberName: '탈퇴한멤버' } });
assert.equal(clone(context.loadState(false)).sales.find((s) => s.id === 'sale-stale').bids.length, 0,
  '관리자는 현재 명단에 없는 과거 입찰도 삭제할 수 있어야 한다');
mutate({ mutationId: 'cancel-sale-admin', actor: '멤버C', role: 'admin', kind: 'sale.cancel', payload: { saleId: 'sale-stale' } });
assert.equal(clone(context.loadState(false)).sales.some((s) => s.id === 'sale-stale'), false,
  '내판 삭제 후 새로고침 상태에서도 복구되지 않아야 한다');
const closed = mutate({ mutationId: 'close-1', actor: '관리자', role: 'admin', kind: 'sale.close', payload: { saleId: 'sale-1' } });
assert.equal(closed.result.winner.name, '멤버B');
assert.equal(store.sales.length, 0);
assert.equal(store.distributionLog[0].member, '멤버B');

// Member identity scope is enforced by the mutation engine.
assert.throws(() => mutate({ mutationId: 'cross-member', actor: '멤버A', kind: 'equipment.set', payload: { memberId: 2, slot: '장갑', value: { star: 6 } } }), /본인 데이터/);

// A late admin full save preserves atomic domains, then optimistic revision stops
// a second stale admin save instead of silently overwriting the first.
const staleAdmin = clone(store);
staleAdmin.distributionRules = '관리자 변경 1';
staleAdmin.members[0].equip = {}; // stale client did not see A's equipment
const adminBase = staleAdmin.meta.adminRevision;
const saved = context.withStateLock(() => context.saveState(staleAdmin, adminBase));
assert.equal(saved.adminRevision, adminBase + 1);
assert.equal(store.members[0].equip['주무기'].enhance, 8, 'late full save must preserve member equipment');
assert.equal(store.members[0].skills['주문석']['A스킬'], true, 'late full save must preserve member skills');
assert.equal(store.statusBoards[0].data['2']['모바일'], true, 'late full save must preserve member board cells');
const secondStale = clone(staleAdmin); secondStale.distributionRules = '관리자 변경 2';
assert.throws(() => context.withStateLock(() => context.saveState(secondStale, adminBase)), /conflict:/);

// Even chunked state reads are serialized with writes.
const beforeReadLocks = lockAcquires;
context.doGet({ parameter: { action: 'getAll' } });
assert.equal(lockAcquires, beforeReadLocks + 1, 'getAll must use the same ScriptLock as writes');

// Matrix-backed member data updates only the addressed member cell, preserving
// every neighboring member/column value in the editable sheet.
const matrix = [
  ['닉네임', '주무기', '투구'],
  ['멤버A', 'old-A', 'keep-A'],
  ['멤버B', 'keep-B', 'keep-B2'],
];
const sheet = {
  getLastRow: () => matrix.length,
  getLastColumn: () => matrix[0].length,
  getRange(row, col, rows = 1, cols = 1) {
    return {
      getValues: () => matrix.slice(row - 1, row - 1 + rows).map((r) => r.slice(col - 1, col - 1 + cols)),
      setValue: (value) => { matrix[row - 1][col - 1] = value; },
    };
  },
};
let sheetFallback = false;
context.matrixCell({ getSheetByName: () => sheet }, '장비현황', '멤버A', '주무기', 'new-A', () => { sheetFallback = true; });
assert.equal(sheetFallback, false);
assert.deepEqual(matrix, [
  ['닉네임', '주무기', '투구'],
  ['멤버A', 'new-A', 'keep-A'],
  ['멤버B', 'keep-B', 'keep-B2'],
]);

assert.equal(lockDepth, 0);
assert.ok(lockAcquires >= 18, 'all reads/writes should pass through ScriptLock');
console.log(`✅ concurrency invariants passed (${lockAcquires} locked writes, revision ${store.meta.revision})`);
