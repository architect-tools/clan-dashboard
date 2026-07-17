#!/usr/bin/env node
// Transport/DB integration test with an in-memory Supabase client double.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { CONFIG } from '../docs/js/config.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

CONFIG.SUPABASE_URL = 'https://test.supabase.co';
CONFIG.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
let state = JSON.parse(readFileSync('docs/data/seed.json', 'utf8'));
state.meta ||= {};
state.meta.revision = 1;
state.meta.adminRevision = 1;
let session = null;
let revisionHandler = null;
let applyAtomic = null;

const profile = { clanId: '00000000-0000-0000-0000-000000000001', memberId: state.members[0].id,
  name: state.members[0].name, role: 'admin' };

const client = {
  auth: {
    async getSession() { return { data: { session }, error: null }; },
    async signInAnonymously() { session = { user: { id: 'user-1', is_anonymous: true } }; return { data: { session }, error: null }; },
    async signOut() { session = null; return { error: null }; },
  },
  async rpc(name, params = {}) {
    if (name === 'dashboard_roster') return { data: state.members.map((m) => ({ name: m.name })), error: null };
    if (name === 'dashboard_claim' || name === 'dashboard_profile') return { data: profile, error: null };
    if (name === 'dashboard_state') return { data: structuredClone(state), error: null };
    if (name === 'dashboard_save') {
      state = structuredClone(params.p_state);
      state.meta.revision = +(state.meta.revision || 0) + 1;
      state.meta.adminRevision = +(state.meta.adminRevision || 0) + 1;
      return { data: { ok: true, state: structuredClone(state), revision: state.meta.revision,
        adminRevision: state.meta.adminRevision }, error: null };
    }
    if (name === 'dashboard_mutate') {
      const result = applyAtomic(state, params.p_kind, params.p_payload,
        { actor: localStorage.getItem(CONFIG.ME_KEY), role: localStorage.getItem(CONFIG.ROLE_KEY) });
      state.meta.revision = +(state.meta.revision || 0) + 1;
      return { data: { ok: true, result, state: structuredClone(state) }, error: null };
    }
    return { data: null, error: { message: `unexpected rpc: ${name}` } };
  },
  channel() {
    return {
      on(_type, _filter, fn) { revisionHandler = fn; return this; },
      subscribe() { return this; },
    };
  },
  async removeChannel() {},
};
globalThis.supabase = { createClient: () => client };

localStorage.setItem(CONFIG.ROLE_KEY, 'admin');
localStorage.setItem(CONFIG.ME_KEY, profile.name);
const { DB, applyAtomicAction } = await import('../docs/js/db.js');
applyAtomic = applyAtomicAction;
await DB.init();
assert.equal(DB.state.members.length, state.members.length);
assert.ok(revisionHandler, 'realtime revision subscription must be active');

const savingEvents = [];
DB.setCallbacks({ onSaving: (active, label, count) => savingEvents.push({ active, label, count }) });

localStorage.setItem(CONFIG.ROLE_KEY, 'member');
const target = DB.state.members[0];
const changed = await DB.atomicAction('equipment.set', { memberId: target.id, slot: '주무기', value: { star: 5, tier: 4.5, enhance: 7 } });
assert.equal(changed.ok, true);
assert.equal(DB.state.members[0].equip['주무기'].enhance, 7);
assert.equal(savingEvents[0]?.active, true, 'atomic write must show the saving overlay');
assert.equal(savingEvents.at(-1)?.active, false, 'atomic write must close the saving overlay');

// Consecutive writes share one busy period: finishing the first must not hide the overlay.
savingEvents.length = 0;
let releaseFirstWrite;
const firstQueuedWrite = DB._queueWrite(() => new Promise((resolve) => { releaseFirstWrite = resolve; }));
let releaseSecondWrite;
const secondQueuedWrite = DB._queueWrite(() => new Promise((resolve) => { releaseSecondWrite = resolve; }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(savingEvents.at(-1)?.count, 2, 'queued writes must be counted together');
releaseFirstWrite(true);
await firstQueuedWrite;
assert.equal(savingEvents.at(-1)?.active, true, 'overlay must remain while the next write is queued');
await new Promise((resolve) => setTimeout(resolve, 0));
releaseSecondWrite(true);
await secondQueuedWrite;
assert.equal(savingEvents.at(-1)?.active, false, 'overlay must close after the final queued write');

localStorage.setItem(CONFIG.ROLE_KEY, 'admin');
savingEvents.length = 0;
DB.state.meta.clanName = '실시간 테스트';
DB.commit();
assert.equal(await DB.flushSave(), true);
assert.equal(state.meta.clanName, '실시간 테스트');
assert.equal(savingEvents[0]?.active, true, 'admin save must show the saving overlay');
assert.equal(savingEvents.at(-1)?.active, false, 'admin save must close the saving overlay');

state.settings ||= {};
state.settings.totalDiamonds = 987654;
state.meta.revision += 1;
revisionHandler({ new: { revision: state.meta.revision } });
await new Promise((resolve) => setTimeout(resolve, 150));
assert.equal(DB.state.settings.totalDiamonds, 987654, 'realtime revision must refresh remote state');

console.log('✅ Supabase transport, atomic write, admin save, and realtime refresh passed');
