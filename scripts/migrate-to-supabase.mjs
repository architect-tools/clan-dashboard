#!/usr/bin/env node
// One-time, fail-closed migration from the current Apps Script state to Supabase.
// The service-role key is read only from the environment and is never printed.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { supabaseServiceHeaders } from './load-env.mjs';
import { CONFIG } from '../docs/js/config.js';

const apply = process.argv.includes('--apply');
const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CLAN_MEMBER_PASSWORD', 'CLAN_ADMIN_PASSWORD'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Missing environment values: ${missing.join(', ')}`);

const supabaseUrl = process.env.SUPABASE_URL.replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const slug = process.env.CLAN_SLUG || CONFIG.CLAN_SLUG || 'insomnia';
const LEGACY_SOURCE_URL = 'https://script.google.com/macros/s/AKfycbx6GJnd7PitETPxym-CZv_LIqL5h_MTEZ0mECcRtk6Rwo0p3f1c7xBZrrhUpoywDB9w/exec';
const sourceUrl = process.env.APPS_SCRIPT_URL || CONFIG.APPS_SCRIPT_URL || LEGACY_SOURCE_URL;
if (!sourceUrl) throw new Error('APPS_SCRIPT_URL is required for the source snapshot');

const sourceRes = await fetch(`${sourceUrl}?action=getAll&_ts=${Date.now()}`);
const sourceText = await sourceRes.text();
if (!sourceRes.ok || !sourceText.trim().startsWith('{')) {
  throw new Error(`Invalid source response: HTTP ${sourceRes.status} ${sourceText.slice(0, 160)}`);
}
const sourceJson = JSON.parse(sourceText);
if (sourceJson.error) throw new Error(sourceJson.error);
const sourceState = sourceJson.data;
if (!Array.isArray(sourceState?.members) || !sourceState.members.length) throw new Error('Source state has no members');
const state = JSON.parse(JSON.stringify(sourceState));

// Legacy JSON allowed duplicate board IDs. Postgres correctly requires a stable
// primary key, so remap only later duplicates; board cell data remains attached.
const seenBoardIds = new Set();
for (const [index, board] of (state.statusBoards || []).entries()) {
  const original = String(board?.id || `board-${index + 1}`);
  let id = original;
  let suffix = 2;
  while (seenBoardIds.has(id)) id = `${original}-migrated-${suffix++}`;
  if (id !== board.id) console.log(`Migration repair: duplicate board id ${original} -> ${id} (${board?.name || index + 1})`);
  board.id = id;
  seenBoardIds.add(id);
}

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const backupPath = join(tmpdir(), `clandashboard-before-supabase-${stamp}.json`);
await writeFile(backupPath, JSON.stringify(sourceState, null, 2) + '\n', 'utf8');

const summarize = (value) => {
  const days = Object.values(value.participation?.byDate || {});
  return {
    members: (value.members || []).length,
    participationDays: days.length,
    participationEvents: days.reduce((n, day) => n + Object.keys(day || {}).length, 0),
    participationAssignments: days.reduce((n, day) => n + Object.values(day || {}).reduce((m, ids) => m + (ids || []).length, 0), 0),
    distributions: (value.distributionLog || []).length,
    settlements: (value.settlements || []).length,
    boards: (value.statusBoards || []).length,
    boardCells: (value.statusBoards || []).reduce((n, board) => n + Object.values(board.data || {}).reduce((m, cols) => m + Object.keys(cols || {}).length, 0), 0),
    sales: (value.sales || []).length,
    bids: (value.sales || []).reduce((n, sale) => n + (sale.bids || []).length, 0),
    qaReports: (value.qaReports || []).length,
  };
};
const summary = summarize(state);
console.log('Source snapshot:', summary);
console.log('Safety backup:', backupPath);

if (!apply) {
  console.log('Dry run only. Re-run with --apply after applying supabase/migrations/001_clan_dashboard.sql.');
  process.exit(0);
}

const bootstrapRpc = serviceKey.startsWith('sb_secret_') ? 'dashboard_bootstrap_service' : 'dashboard_bootstrap';
const migrateRes = await fetch(`${supabaseUrl}/rest/v1/rpc/${bootstrapRpc}`, {
  method: 'POST',
  headers: supabaseServiceHeaders(serviceKey),
  body: JSON.stringify({
    p_slug: slug,
    p_state: state,
    p_member_password: process.env.CLAN_MEMBER_PASSWORD,
    p_admin_password: process.env.CLAN_ADMIN_PASSWORD,
  }),
});
const migrateText = await migrateRes.text();
if (!migrateRes.ok) throw new Error(`Supabase bootstrap failed: HTTP ${migrateRes.status} ${migrateText.slice(0, 400)}`);
const result = JSON.parse(migrateText);
const migrated = result.state || {};
const migratedSummary = summarize(migrated);
if (JSON.stringify(migratedSummary) !== JSON.stringify(summary)) {
  throw new Error(`Migration verification mismatch: source=${JSON.stringify(summary)} target=${JSON.stringify(migratedSummary)}`);
}
console.log('Migration verified:', migratedSummary);
console.log('Supabase clan id:', result.clanId);
