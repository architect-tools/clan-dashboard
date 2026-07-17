#!/usr/bin/env node
// Export a consistent Supabase state snapshot using the service role.
import { writeFile } from 'node:fs/promises';
import { supabaseServiceHeaders } from './load-env.mjs';
import { CONFIG } from '../docs/js/config.js';

const url = (process.env.SUPABASE_URL || CONFIG.SUPABASE_URL || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const slug = process.env.CLAN_SLUG || CONFIG.CLAN_SLUG || 'insomnia';
const statePath = process.argv[2] || '';
const summaryPath = process.argv[3] || '';
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

const headers = supabaseServiceHeaders(key);
const clanRes = await fetch(`${url}/rest/v1/clans?slug=eq.${encodeURIComponent(slug)}&select=id`, { headers });
const clanText = await clanRes.text();
if (!clanRes.ok) throw new Error(`Clan lookup failed: HTTP ${clanRes.status} ${clanText.slice(0, 300)}`);
const clanId = JSON.parse(clanText)[0]?.id;
if (!clanId) throw new Error(`Clan not found: ${slug}`);

const stateRes = await fetch(`${url}/rest/v1/rpc/dashboard_state_for`, {
  method: 'POST', headers, body: JSON.stringify({ p_clan_id: clanId }),
});
const stateText = await stateRes.text();
if (!stateRes.ok) throw new Error(`State export failed: HTTP ${stateRes.status} ${stateText.slice(0, 300)}`);
const state = JSON.parse(stateText);
if (!Array.isArray(state?.members) || !state.members.length) throw new Error('Exported state has no members');
const summary = {
  members: state.members.length,
  participationDays: Object.keys(state.participation?.byDate || {}).length,
  distributions: (state.distributionLog || []).length,
  settlements: (state.settlements || []).length,
  qaReports: (state.qaReports || []).length,
  equipMembers: state.members.filter((m) => Object.keys(m.equip || {}).length).length,
  revision: +(state.meta?.revision || 0),
};

if (statePath) await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
else process.stdout.write(JSON.stringify(state, null, 2) + '\n');
if (summaryPath) await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
else console.error('Snapshot summary:', summary);
