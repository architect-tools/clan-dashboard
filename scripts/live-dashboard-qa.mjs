#!/usr/bin/env node
// Live dashboard QA loop.
// Creates temporary data in the live Apps Script state, verifies read/write/edit
// paths, then restores the original state. Designed to fail closed with a
// backup file path if restore does not complete.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONFIG } from '../docs/js/config.js';
import { computeSettlement } from '../docs/js/calc.js';

const token = process.env.CLANDASH_TOKEN || CONFIG.GATE_PASSWORD || '';
const url = CONFIG.APPS_SCRIPT_URL;
if (!url) throw new Error('APPS_SCRIPT_URL is empty');

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const marker = `__LIVE_QA_${stamp}__`;
const backupPath = join(tmpdir(), `clandash-live-backup-${stamp}.json`);
const qaLockWho = `live-dashboard-qa:${marker}`;
const qaLockPages = ['members', 'participation', 'diamond', 'dist-params', 'settings', 'rotation', 'gear'];
const log = [];
const ok = (name, detail = '') => {
  log.push({ ok: true, name, detail });
  console.log(`OK ${name}${detail ? ' - ' + detail : ''}`);
};
const warn = (name, detail = '') => {
  log.push({ ok: true, warning: true, name, detail });
  console.log(`WARN ${name}${detail ? ' - ' + detail : ''}`);
};
const fail = (name, detail = '') => {
  log.push({ ok: false, name, detail });
  throw new Error(`${name}${detail ? ': ' + detail : ''}`);
};

let original = null;
let originalText = '';
let restoreNeeded = false;
let qaLocksAcquired = false;

try {
  await assertNoActiveEditors('preflight');
  await acquireQaLocks();

  original = await getAll({ merge: false });
  originalText = stable(original);
  await writeFile(backupPath, JSON.stringify(original, null, 2) + '\n', 'utf8');
  ok('backup live state', backupPath);

  await checkReads(original);
  await checkFullStateCrud(original);
  await checkLockEndpoint();
  await checkConcurrentFullSave();
  await checkQaWorkflowRace();

  await restoreOriginal();
  const final = await getAll({ merge: false });
  if (stable(final) !== originalText) {
    await writeFile(join(tmpdir(), `clandash-live-after-restore-${stamp}.json`), JSON.stringify(final, null, 2) + '\n', 'utf8');
    warn('restore equality', 'state changed outside QA; temp QA data was cleaned and non-QA changes were preserved');
  } else {
    ok('restore equality');
  }
  await releaseQaLocks();
  console.log('\nLIVE DASHBOARD QA PASS');
} catch (err) {
  console.error('\nLIVE DASHBOARD QA FAIL:', err.message || err);
  if (restoreNeeded && original) {
    try {
      await restoreOriginal();
      console.error('Restore attempted after failure. Backup:', backupPath);
    } catch (restoreErr) {
      console.error('RESTORE FAILED. Manual backup:', backupPath);
      console.error(restoreErr.message || restoreErr);
    }
  }
  await releaseQaLocks();
  process.exit(1);
}

async function checkReads(state) {
  if (!Array.isArray(state.members) || state.members.length < 1) fail('read members', 'empty roster');
  if (!state.settings || !Array.isArray(state.tiers) || !Array.isArray(state.contentCatalog)) fail('read core settings');
  const merged = await getAll({ merge: true });
  if (!Array.isArray(merged.members) || merged.members.length < 1) fail('read merge members', 'empty roster');
  ok('read getAll/getAll merge', `${state.members.length} members`);
  const settlement = computeSettlement(state);
  if (settlement.verification.status !== '정상') {
    warn('settlement verification', `${settlement.verification.status}, remaining=${settlement.verification.remaining}`);
  } else {
    ok('settlement verification');
  }
  ok('compute settlement', `distributed ${settlement.totals.distributed}`);
}

async function checkFullStateCrud(base) {
  const s = clone(base);
  const maxId = Math.max(0, ...(s.members || []).map((m) => +m.id || 0));
  const memberId = maxId + 999;
  const date = '2099-12-31';

  s.members.push({
    id: memberId,
    order: (s.members || []).length + 1,
    name: marker,
    cls: '전사',
    power: 123.4,
    score: 77,
    grade: '신입',
    equip: { 주무기: { star: 4, tier: 5.5, enhance: 8 } },
    skills: { 주문석: { 다중_궤적: true }, 공용주문석: {}, 엘릭서: { 테스트: true } },
    active: true,
    note: marker,
  });
  s.participation ||= {};
  s.participation.byDate ||= {};
  s.participation.byDate[date] = { [marker]: [memberId] };
  s.tiers = [...(s.tiers || [])];
  if (s.tiers[0]) s.tiers[0] = { ...s.tiers[0], minScore: s.tiers[0].minScore };
  s.staff = [...(s.staff || []), { name: marker, ratio: 0 }];
  s.contentCatalog = [...(s.contentCatalog || []), { category: '기타', name: marker, points: 1, weekly: 1, active: true }];
  s.rotationQueues = [...(s.rotationQueues || []), { name: marker, items: [{ name: marker }] }];
  s.dropLog = [{ id: marker + '-drop', date, content: marker, item: marker, note: marker }, ...(s.dropLog || [])];
  s.distributionLog = [{ id: marker + '-dist', date, item: marker, type: '기타', member: marker, from: '', price: 1, note: marker }, ...(s.distributionLog || [])];
  s.sales = [{ id: marker + '-sale', item: marker, bidType: '경매', basePrice: 1, deadline: Date.now() + 3600000, bids: [{ name: marker, amount: 1 }] }, ...(s.sales || [])];
  s.settlements = [{ id: marker + '-settle', date, from: date, to: date, total: 1, distributed: 1, entries: [{ memberId, name: marker, cls: '전사', powerDia: 0, partDia: 1, staffDia: 0, total: 1, score: 77, tier: 'F' }] }, ...(s.settlements || [])];
  s.statusBoards ||= [];
  if (s.statusBoards[0]) {
    s.statusBoards[0].data ||= {};
    s.statusBoards[0].data[String(memberId)] = { [(s.statusBoards[0].columns || ['테스트'])[0]]: true };
  }

  await assertNoActiveEditors('before temp full-state save');
  restoreNeeded = true;
  await post('save', { data: s });
  ok('write full state temp data');

  const fast = await waitForState('read back full state temp data', (state) => assertTempState(state, memberId));
  assertTempState(fast, memberId);
  ok('read back full state temp data');

  const merged = await waitForState('read back merge after writeTabs', (state) => assertTempState(state, memberId), { merge: true });
  assertTempState(merged, memberId);
  ok('read back merge after writeTabs');

  const edited = clone(merged);
  const m = edited.members.find((x) => x.id === memberId);
  m.power = 124.5;
  m.note = marker + '-edited';
  await assertNoActiveEditors('before temp member edit save');
  await post('save', { data: edited });
  const reread = await waitForState('edit temp member', (state) => {
    const em = (state.members || []).find((x) => x.id === memberId);
    if (!em || em.power !== 124.5 || em.note !== marker + '-edited') throw new Error('edited member not visible yet');
  });
  const em = reread.members.find((x) => x.id === memberId);
  if (!em || em.power !== 124.5 || em.note !== marker + '-edited') fail('edit temp member');
  ok('edit temp member');
}

function assertTempState(state, memberId) {
  const member = (state.members || []).find((m) => m.id === memberId || m.name === marker);
  if (!member) fail('temp member persisted');
  if (!state.participation?.byDate?.['2099-12-31']?.[marker]?.includes(memberId)) fail('temp participation persisted');
  if (!(state.dropLog || []).some((x) => x.id === marker + '-drop')) fail('temp drop persisted');
  if (!(state.distributionLog || []).some((x) => x.id === marker + '-dist')) fail('temp distribution persisted');
  if (!(state.rotationQueues || []).some((x) => x.name === marker)) fail('temp queue persisted');
  if (!(state.sales || []).some((x) => x.id === marker + '-sale')) fail('temp sale persisted');
  if (!(state.settlements || []).some((x) => x.id === marker + '-settle')) fail('temp settlement persisted');
  if (!(state.contentCatalog || []).some((x) => x.name === marker)) fail('temp content persisted');
}

async function checkQaWorkflowRace() {
  await assertNoActiveEditors('before qa workflow race');
  const reports = await Promise.all(Array.from({ length: 3 }, (_, i) => post('qaAdd', {
    report: {
      title: `${marker} QA race ${i}`,
      severity: 'low',
      area: 'DB/동기화',
      reporter: 'live-dashboard-qa',
      environment: 'concurrent qaAdd',
      steps: 'concurrent create',
      expected: 'unique slots and no lost update',
      actual: 'running',
      note: marker,
    },
  })));
  const slots = reports.map((r) => r.slot);
  if (new Set(slots).size !== reports.length) fail('qa race unique slots', slots.join(','));
  ok('qa race unique slots', slots.join(','));

  const target = reports[0];
  const updated = await post('qaUpdate', {
    idOrSlot: target.slot,
    patch: { status: 'resolved', assignee: 'live-dashboard-qa', reply: marker + ' reply ok' },
  });
  if (updated.status !== 'resolved' || updated.reply !== marker + ' reply ok') fail('qa update reply');
  ok('qa update reply', target.slot);

  const state = await getAll({ merge: false });
  for (const r of reports) {
    if (!(state.qaReports || []).some((x) => x.slot === r.slot)) fail('qa report readable', r.slot);
  }
  ok('qa reports readable', String(reports.length));

  for (const r of reports) await post('qaDelete', { idOrSlot: r.slot });
  const after = await getAll({ merge: false });
  const left = (after.qaReports || []).filter((r) => String(r.note || '').includes(marker) || String(r.title || '').includes(marker));
  if (left.length) fail('qa cleanup', left.map((r) => r.slot).join(','));
  ok('qa cleanup');
}

async function checkLockEndpoint() {
  const page = `live-qa-${stamp}`;
  const a = await post('lock', { page, who: marker + '-A' });
  const b = await post('lock', { page, who: marker + '-B' });
  const locks = Array.isArray(b) ? b : a;
  const mine = locks.filter((l) => l.page === page && String(l.who || '').startsWith(marker));
  if (mine.length < 2) fail('soft lock race visibility', JSON.stringify(locks));
  await post('unlock', { page, who: marker + '-A' });
  await post('unlock', { page, who: marker + '-B' });
  ok('soft lock race visibility');
}

async function checkConcurrentFullSave() {
  await assertNoActiveEditors('before concurrent full save');
  const base = await waitForState('concurrent full save base', (state) => {
    if (!Array.isArray(state.members) || !state.members.some((m) => m.name === marker)) {
      throw new Error('temp member not visible before race');
    }
  });
  const a = clone(base);
  const b = clone(base);
  a.appSettings ||= {};
  b.appSettings ||= {};
  a.appSettings.liveQaRace = marker + '-A';
  b.appSettings.liveQaRace = marker + '-B';
  await Promise.all([post('save', { data: a }), post('save', { data: b })]);
  const after = await waitForState('concurrent full save serialized', (state) => {
    const value = state.appSettings?.liveQaRace;
    if (value !== marker + '-A' && value !== marker + '-B') throw new Error(`race marker not visible: ${value}`);
    if (!Array.isArray(state.members) || !state.members.some((m) => m.name === marker)) {
      throw new Error('temp member not preserved');
    }
  });
  const value = after.appSettings?.liveQaRace;
  if (value !== marker + '-A' && value !== marker + '-B') fail('concurrent full save result', String(value));
  if (!Array.isArray(after.members) || !after.members.some((m) => m.name === marker)) fail('concurrent full save preserved state');
  ok('concurrent full save serialized', value);
}

async function restoreOriginal() {
  const current = await getAll({ merge: false });
  const cleaned = cleanupTempState(current);
  await post('save', { data: cleaned });
  await waitForState('cleanup temp live QA state', (state) => {
    if (hasTempState(state)) throw new Error('temp QA data still visible');
  }, { timeoutMs: 30000 });
  restoreNeeded = false;
  ok('cleanup temp live QA state');
}

async function getAll({ merge }) {
  const params = new URLSearchParams({ action: 'getAll', _ts: String(Date.now()) });
  if (merge) params.set('merge', '1');
  return fetchJson(`${url}?${params}`);
}

async function getLocks() {
  return fetchJson(`${url}?${new URLSearchParams({ action: 'getLocks', _ts: String(Date.now()) })}`);
}

async function post(action, payload) {
  const body = JSON.stringify({ action, token, ...payload });
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)) },
    body,
  }, action === 'save' ? 1 : 3);
}

async function assertNoActiveEditors(stage) {
  const locks = await getLocks();
  const active = (Array.isArray(locks) ? locks : []).filter((l) => !isQaLock(l));
  if (active.length) {
    fail(`active editors present (${stage})`, active.map((l) => `${l.page}:${l.who}`).join(', '));
  }
}

function isQaLock(lock) {
  const who = String(lock?.who || '');
  return who === qaLockWho || who.startsWith(marker) || who.includes('live-dashboard-qa');
}

async function acquireQaLocks() {
  qaLocksAcquired = true;
  for (const page of qaLockPages) await post('lock', { page, who: qaLockWho });
  ok('qa edit lock acquired', qaLockPages.join(','));
}

async function releaseQaLocks() {
  if (!qaLocksAcquired) return;
  for (const page of qaLockPages) {
    try { await post('unlock', { page, who: qaLockWho }); }
    catch (err) { warn('qa edit lock release failed', `${page}: ${err.message || err}`); }
  }
  qaLocksAcquired = false;
  ok('qa edit lock released');
}

async function waitForState(name, check, { merge = false, timeoutMs = 20000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() <= deadline) {
    const state = await getAll({ merge });
    try {
      check(state);
      return state;
    } catch (err) {
      last = err.message || String(err);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  fail(name, last || 'condition not met');
}

function cleanupTempState(state) {
  const s = clone(state);
  const memberIds = new Set((s.members || [])
    .filter((m) => isMarkerText(m.name) || isMarkerText(m.note))
    .map((m) => String(m.id)));

  s.members = (s.members || []).filter((m) => !(isMarkerText(m.name) || isMarkerText(m.note)));

  const byDate = s.participation?.byDate || {};
  for (const [date, events] of Object.entries(byDate)) {
    for (const [content, ids] of Object.entries(events || {})) {
      if (isMarkerText(content)) {
        delete events[content];
        continue;
      }
      if (Array.isArray(ids)) events[content] = ids.filter((id) => !memberIds.has(String(id)));
    }
    if (!Object.keys(events || {}).length) delete byDate[date];
  }

  s.staff = (s.staff || []).filter((x) => !isMarkerText(x.name));
  s.contentCatalog = (s.contentCatalog || []).filter((x) => !isMarkerText(x.name));
  s.rotationQueues = (s.rotationQueues || []).filter((x) => !isMarkerText(x.name));
  s.dropLog = (s.dropLog || []).filter((x) => !isMarkerRecord(x));
  s.distributionLog = (s.distributionLog || []).filter((x) => !isMarkerRecord(x));
  s.sales = (s.sales || []).filter((x) => !isMarkerRecord(x));
  s.settlements = (s.settlements || []).filter((x) => !isMarkerRecord(x));
  s.qaReports = (s.qaReports || []).filter((x) => !isMarkerRecord(x));

  for (const board of s.statusBoards || []) {
    if (!board?.data) continue;
    for (const id of memberIds) delete board.data[id];
  }

  if (s.appSettings?.liveQaRace && String(s.appSettings.liveQaRace).startsWith('__LIVE_QA_')) {
    delete s.appSettings.liveQaRace;
  }
  return s;
}

function hasTempState(state) {
  return stable(cleanupTempState(state)) !== stable(state);
}

function isMarkerRecord(value) {
  return isMarkerText(JSON.stringify(value || {}));
}

function isMarkerText(value) {
  return String(value || '').includes(marker);
}

async function fetchJson(target, opts = { cache: 'no-store' }, tries = 3) {
  let last = '';
  for (let i = 1; i <= tries; i++) {
    const res = await fetch(target, opts.method === 'POST' ? { ...opts, redirect: 'manual' } : opts);
    if (opts.method === 'POST' && res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const redirected = await fetch(res.headers.get('location'), { method: 'GET', cache: 'no-store' });
      const text = await redirected.text();
      if (redirected.ok && text.trim().startsWith('{')) {
        const json = JSON.parse(text);
        if (json.error) throw new Error(json.error);
        return json.data;
      }
      last = `HTTP ${redirected.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}`;
      await new Promise((resolve) => setTimeout(resolve, 700 * i));
      continue;
    }
    const text = await res.text();
    if (res.ok && text.trim().startsWith('{')) {
      const json = JSON.parse(text);
      if (json.error) throw new Error(json.error);
      return json.data;
    }
    last = `HTTP ${res.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}`;
    await new Promise((resolve) => setTimeout(resolve, 700 * i));
  }
  throw new Error(last || 'invalid response');
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function stable(v) {
  return JSON.stringify(v);
}
