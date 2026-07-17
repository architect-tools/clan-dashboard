#!/usr/bin/env node
// Minimal reversible production check: anonymous Auth, admin claim, idempotent
// QA mutation, cleanup, and final state verification.
import './load-env.mjs';
import { CONFIG } from '../docs/js/config.js';
import { supabaseServiceHeaders } from './load-env.mjs';

const url = CONFIG.SUPABASE_URL.replace(/\/$/, '');
const publicKey = CONFIG.SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const adminPassword = process.env.CLAN_ADMIN_PASSWORD || '';
if (!url || !publicKey || !secretKey || !adminPassword) throw new Error('Supabase live-test configuration is incomplete');

const publicHeaders = { apikey: publicKey, 'content-type': 'application/json' };
const signup = await fetch(`${url}/auth/v1/signup`, {
  method: 'POST', headers: publicHeaders, body: JSON.stringify({ data: {} }),
});
const signupText = await signup.text();
if (!signup.ok) throw new Error(`Anonymous Auth failed: HTTP ${signup.status} ${signupText.slice(0, 300)}`);
const session = JSON.parse(signupText);
const userId = session.user?.id;
const accessToken = session.access_token;
if (!userId || !accessToken) throw new Error('Anonymous Auth returned no session');

const authHeaders = { ...publicHeaders, authorization: `Bearer ${accessToken}` };
const rpc = async (name, body) => {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: authHeaders, body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} failed: HTTP ${res.status} ${text.slice(0, 400)}`);
  return JSON.parse(text);
};

let reportKey = '';
let released = false;
try {
  const roster = await rpc('dashboard_roster', { p_slug: CONFIG.CLAN_SLUG });
  if (roster.length !== 50 || !roster[0]?.name) throw new Error(`Roster mismatch: ${roster.length}`);
  const claim = await rpc('dashboard_claim', {
    p_slug: CONFIG.CLAN_SLUG, p_member_name: roster[0].name, p_password: adminPassword,
  });
  if (claim.role !== 'admin') throw new Error('Admin claim failed');

  const before = await rpc('dashboard_state', {});
  const beforeQa = (before.qaReports || []).length;
  const mutationId = `live-qa-${Date.now()}-${crypto.randomUUID()}`;
  const added = await rpc('dashboard_mutate', {
    p_kind: 'qa.add',
    p_payload: { report: { title: '[E2E] Supabase cutover test', severity: 'low', area: 'DB/동기화', reporter: 'migration-test' } },
    p_mutation_id: mutationId,
  });
  reportKey = added.result?.slot || added.result?.id || '';
  if (!reportKey || (added.state?.qaReports || []).length !== beforeQa + 1) throw new Error('QA add verification failed');

  const duplicate = await rpc('dashboard_mutate', {
    p_kind: 'qa.add', p_payload: { report: { title: 'must not be inserted' } }, p_mutation_id: mutationId,
  });
  if (!duplicate.duplicate || (duplicate.state?.qaReports || []).length !== beforeQa + 1) throw new Error('Mutation idempotency failed');

  const removed = await rpc('dashboard_mutate', {
    p_kind: 'qa.delete', p_payload: { idOrSlot: reportKey }, p_mutation_id: `${mutationId}-cleanup`,
  });
  reportKey = '';
  if ((removed.state?.qaReports || []).length !== beforeQa) throw new Error('QA cleanup verification failed');
  await rpc('dashboard_release', {});
  released = true;

  console.log(JSON.stringify({ anonymousAuth: true, roster: roster.length, adminClaim: true,
    idempotency: true, cleanup: true, revisionBefore: before.meta?.revision,
    revisionAfter: removed.state?.meta?.revision }, null, 2));
} finally {
  if (reportKey) {
    try {
      await rpc('dashboard_mutate', { p_kind: 'qa.delete', p_payload: { idOrSlot: reportKey },
        p_mutation_id: `live-qa-emergency-cleanup-${crypto.randomUUID()}` });
    } catch (error) { console.error('WARN QA cleanup failed:', error.message); }
  }
  if (!released) {
    try { await rpc('dashboard_release', {}); } catch { /* profile may not exist */ }
  }
  const del = await fetch(`${url}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE', headers: supabaseServiceHeaders(secretKey),
  });
  if (!del.ok) console.error(`WARN anonymous test user cleanup failed: HTTP ${del.status}`);
}
