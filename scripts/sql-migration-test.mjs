#!/usr/bin/env node
// Executes the Supabase migration in an ephemeral Postgres/WASM instance.
// Supabase-owned auth helpers and pgcrypto are represented by minimal test doubles;
// tables, RLS, PL/pgSQL functions, constraints and transactional behavior are real Postgres.
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create schema extensions;
    create table auth.users(id uuid primary key);
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create or replace function extensions.gen_salt(text) returns text language sql immutable as $$ select $1 $$;
    create or replace function extensions.crypt(text, text) returns text language sql immutable as $$ select $1 $$;
    create publication supabase_realtime;
  `);

  const migration = (await readFile(new URL('../supabase/migrations/001_clan_dashboard.sql', import.meta.url), 'utf8'))
    .replace(/^create extension if not exists pgcrypto with schema extensions;\s*$/m, '');
  await db.exec(migration);
  await db.exec(await readFile(new URL('../supabase/migrations/002_opaque_secret_keys.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/003_request_automation.sql', import.meta.url), 'utf8'));

  const seed = JSON.parse(await readFile(new URL('../docs/data/seed.json', import.meta.url), 'utf8'));
  await db.query(`select set_config('request.jwt.claim.role','service_role',false)`);
  const boot = await db.query(
    `select public.dashboard_bootstrap_service($1,$2::jsonb,$3,$4) as result`,
    ['insomnia', JSON.stringify(seed), '7979', 'admin-password'],
  );
  const bootState = boot.rows[0].result.state;
  if (bootState.members.length !== seed.members.length) throw new Error('bootstrap member count mismatch');

  const userId = '00000000-0000-4000-8000-000000000001';
  await db.query('insert into auth.users(id) values($1)', [userId]);
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [userId]);
  const memberName = seed.members.find((m) => m.active !== false)?.name;
  const claim = await db.query(`select public.dashboard_claim($1,$2,$3) as result`, ['insomnia', memberName, '7979']);
  if (claim.rows[0].result.role !== 'member') throw new Error('member claim failed');

  const memberId = claim.rows[0].result.memberId;
  const mutation = await db.query(
    `select public.dashboard_mutate('equipment.set',$1::jsonb,$2) as result`,
    [JSON.stringify({ memberId, slot: '주무기', value: { star: 4, tier: 5.5, enhance: 1 } }), 'sql-test-1'],
  );
  if (mutation.rows[0].result.result.member.equip['주무기'].star !== 4) throw new Error('atomic mutation failed');
  const duplicate = await db.query(
    `select public.dashboard_mutate('equipment.set',$1::jsonb,$2) as result`,
    [JSON.stringify({ memberId, slot: '주무기', value: { star: 1 } }), 'sql-test-1'],
  );
  if (!duplicate.rows[0].result.duplicate) throw new Error('mutation idempotency failed');

  await db.query(`select set_config('request.jwt.claim.role','service_role',false)`);
  const qa = await db.query(
    `select public.dashboard_service_qa_service($1,'add','',$2::jsonb) as result`,
    ['insomnia', JSON.stringify({ title: 'SQL migration test' })],
  );
  if (!qa.rows[0].result.id || !qa.rows[0].result.slot) throw new Error('service QA normalization failed');

  const requestMutation = await db.query(
    `select public.dashboard_service_request_mutate_service($1,'content.upsert',$2::jsonb) as result`,
    ['insomnia', JSON.stringify({ category: '거인의 탑', name: 'SQL 자동화 테스트', points: 3, weekly: 1, active: true })],
  );
  if (requestMutation.rows[0].result.name !== 'SQL 자동화 테스트') throw new Error('request mutation failed');
  const requestState = await db.query(
    `select public.dashboard_state_for((select id from public.clans where slug=$1)) as state`,
    ['insomnia'],
  );
  if (!requestState.rows[0].state.contentCatalog.some((item) => item.name === 'SQL 자동화 테스트')) {
    throw new Error('request content mutation was not persisted');
  }

  console.log(`Supabase SQL migration PASS (${seed.members.length} members, RPC/RLS schema, atomic write, duplicate guard, QA automation)`);
} finally {
  await db.close();
}
