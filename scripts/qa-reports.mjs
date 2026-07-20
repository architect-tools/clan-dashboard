#!/usr/bin/env node
// QA report helper for the local Codex CLI workflow.
// Reads/writes the same DB state used by the dashboard.

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { supabaseServiceHeaders } from './load-env.mjs';
import { CONFIG } from '../docs/js/config.js';

const STATUS_LABEL = {
  open: '접수',
  in_progress: '처리중',
  resolved: '해결',
  blocked: '보류',
  closed: '종료',
};
const SEVERITY_LABEL = {
  low: '낮음',
  normal: '보통',
  high: '높음',
  critical: '긴급',
};
const TYPE_LABEL = {
  bug: '버그 리포트',
  improvement: '건의/개선사항',
};
const VALID_STATUS = new Set(Object.keys(STATUS_LABEL));

const { command, positionals, options } = parseArgs(process.argv.slice(2));

try {
  if (!command || command === 'help' || options.help) usage(0);
  const store = await loadState();
  const reports = store.state.qaReports ||= [];

  if (command === 'list') {
    const rows = filterReports(reports, options)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    if (!rows.length) {
      console.log('QA 리포트가 없습니다.');
    } else {
      for (const r of rows) console.log(formatRow(r));
    }
  } else if (command === 'show') {
    const r = requireReport(reports, positionals[0]);
    console.log(formatReport(r));
  } else if (command === 'prompt') {
    const r = requireReport(reports, positionals[0]);
    console.log(buildPrompt(r));
  } else if (command === 'create') {
    const title = options.title || positionals.join(' ') || '[E2E] QA 리포트 검증';
    const r = await store.add({
      title,
      type: options.type === 'improvement' ? 'improvement' : 'bug',
      status: 'open',
      automationStatus: 'queued',
      severity: options.severity || 'low',
      area: options.area || 'DB/동기화',
      reporter: options.reporter || process.env.USERNAME || process.env.USER || 'Codex',
      environment: options.environment || 'qa-reports CLI',
      steps: options.steps || '',
      expected: options.expected || '',
      actual: options.actual || '',
      note: options.note || '',
    });
    console.log(`${r.slot} 생성됨`);
  } else if (command === 'claim') {
    const r = requireReport(reports, positionals[0]);
    const rec = await store.update(r.slot || r.id, {
      status: 'in_progress',
      automationStatus: 'running',
      automationStartedAt: new Date().toISOString(),
      assignee: options.assignee || positionals[1] || process.env.USERNAME || process.env.USER || 'Codex',
    });
    console.log(`${rec.slot} 처리중: ${rec.assignee}`);
  } else if (command === 'requeue') {
    const r = requireReport(reports, positionals[0]);
    const rec = await store.update(r.slot || r.id, {
      type: options.type === 'improvement' ? 'improvement' : options.type === 'bug' ? 'bug' : (r.type || 'bug'),
      status: 'open',
      automationStatus: 'queued',
      automationStartedAt: '',
      automationCompletedAt: '',
      automationBranch: '',
      automationCommit: '',
      automationWorktree: '',
      assignee: '',
      reply: '',
      resolvedAt: '',
    });
    console.log(`${rec.slot} 자동 처리 대기열에 다시 등록됨`);
  } else if (command === 'reply' || command === 'resolve') {
    const r = requireReport(reports, positionals[0]);
    const status = normalizeStatus(options.status || (command === 'resolve' ? 'resolved' : 'resolved'));
    const message = await replyMessage(options);
    if (['resolved', 'closed'].includes(status) && !message.trim()) {
      throw new Error('해결/종료 응답에는 --message, --file, 또는 stdin 내용이 필요합니다.');
    }
    const rec = await store.update(r.slot || r.id, {
      status,
      automationStatus: ['resolved', 'closed'].includes(status) ? 'completed' : status === 'blocked' ? 'failed' : r.automationStatus,
      automationCompletedAt: ['resolved', 'closed', 'blocked'].includes(status) ? new Date().toISOString() : '',
      reply: message.trim(),
      assignee: options.assignee || r.assignee || process.env.USERNAME || process.env.USER || 'Codex',
    });
    console.log(`${rec.slot} ${STATUS_LABEL[rec.status]} 응답 저장됨`);
  } else if (command === 'delete' || command === 'remove') {
    const r = requireReport(reports, positionals[0]);
    await store.remove(r.slot || r.id);
    console.log(`${r.slot} 삭제됨`);
  } else {
    usage(1, `알 수 없는 명령: ${command}`);
  }
} catch (err) {
  console.error('ERROR:', err.message || err);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { command: argv[0], positionals: [], options: {} };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out.positionals.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    if (eq >= 0) {
      out.options[raw.slice(0, eq)] = raw.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) out.options[raw] = argv[++i];
      else out.options[raw] = true;
    }
  }
  return out;
}

function usage(code = 0, message = '') {
  if (message) console.error(message);
  console.log(`Usage:
  node scripts/qa-reports.mjs list [--all] [--status open]
  node scripts/qa-reports.mjs show <slot-or-id>
  node scripts/qa-reports.mjs prompt <slot-or-id>
  node scripts/qa-reports.mjs create --type bug|improvement --title "..."
  node scripts/qa-reports.mjs claim <slot-or-id> [assignee]
  node scripts/qa-reports.mjs requeue <slot-or-id> [--type bug|improvement]
  node scripts/qa-reports.mjs reply <slot-or-id> [--status resolved] [--message "..."]
  node scripts/qa-reports.mjs reply <slot-or-id> --file reply.txt
  node scripts/qa-reports.mjs delete <slot-or-id>

Options:
  --state-file path   Use a local JSON state file instead of the remote DB.
  --assignee name     Set the 담당 field.
  --all               Include resolved/closed reports in list.

Environment:
  SUPABASE_URL              Supabase project URL.
  SUPABASE_SERVICE_ROLE_KEY Server-only key for QA automation.
  CLAN_SLUG                 Clan slug. Defaults to docs/js/config.js.
  CLANDASH_TOKEN            Legacy Apps Script write token.
  CLANDASH_STATE_FILE       Same as --state-file.`);
  process.exit(code);
}

async function loadState() {
  const stateFile = options['state-file'] || process.env.CLANDASH_STATE_FILE;
  if (stateFile) {
    const raw = (await readFile(stateFile, 'utf8')).replace(/^\uFEFF/, '');
    const state = JSON.parse(raw);
    return {
      state,
      add: async (report) => {
        const rec = { id: 'qa-' + Date.now(), slot: report.slot || `QA-LOCAL-${Date.now()}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...report };
        state.qaReports ||= [];
        state.qaReports.unshift(rec);
        await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
        return rec;
      },
      update: async (idOrSlot, patch) => {
        const rec = requireReport(state.qaReports ||= [], idOrSlot);
        Object.assign(rec, patch, { updatedAt: new Date().toISOString() });
        if (['resolved', 'closed'].includes(rec.status) && !rec.resolvedAt) rec.resolvedAt = rec.updatedAt;
        await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
        return rec;
      },
      remove: async (idOrSlot) => {
        state.qaReports = (state.qaReports || []).filter((r) => r.id !== idOrSlot && r.slot !== idOrSlot);
        await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
        return true;
      },
    };
  }
  const supabaseUrl = String(process.env.SUPABASE_URL || CONFIG.SUPABASE_URL || '').replace(/\/$/, '');
  if (supabaseUrl) {
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY가 필요합니다. 브라우저용 publishable key를 사용하지 마세요.');
    const slug = process.env.CLAN_SLUG || CONFIG.CLAN_SLUG || 'insomnia';
    const headers = supabaseServiceHeaders(serviceKey);
    const clans = await fetchSupabaseJson(`${supabaseUrl}/rest/v1/clans?slug=eq.${encodeURIComponent(slug)}&select=id`, { headers });
    const clanId = clans?.[0]?.id;
    if (!clanId) throw new Error(`Supabase 클랜을 찾을 수 없습니다: ${slug}`);
    const rpc = (name, body) => fetchSupabaseJson(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const qaRpc = serviceKey.startsWith('sb_secret_') ? 'dashboard_service_qa_service' : 'dashboard_service_qa';
    const state = await rpc('dashboard_state_for', { p_clan_id: clanId });
    if (!state || typeof state !== 'object') throw new Error('Supabase DB 상태를 불러오지 못했습니다.');
    return {
      state,
      add: async (report) => rpc(qaRpc, { p_slug: slug, p_action: 'add', p_id_or_slot: '', p_data: report }),
      update: async (idOrSlot, patch) => rpc(qaRpc, { p_slug: slug, p_action: 'update', p_id_or_slot: idOrSlot, p_data: patch }),
      remove: async (idOrSlot) => rpc(qaRpc, { p_slug: slug, p_action: 'delete', p_id_or_slot: idOrSlot, p_data: {} }),
    };
  }
  if (!CONFIG.APPS_SCRIPT_URL) {
    throw new Error('Supabase 또는 Apps Script 연결값이 없습니다. --state-file을 지정할 수도 있습니다.');
  }
  const state = await fetchJson(`${CONFIG.APPS_SCRIPT_URL}?${new URLSearchParams({ action: 'getAll', _ts: String(Date.now()) })}`);
  if (!state || typeof state !== 'object') throw new Error('원격 DB 상태를 불러오지 못했습니다.');
  return {
    state,
    add: async (report) => postAction('qaAdd', { report }),
    update: async (idOrSlot, patch) => postAction('qaUpdate', { idOrSlot, patch }),
    remove: async (idOrSlot) => postAction('qaDelete', { idOrSlot }),
  };
}

async function fetchSupabaseJson(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

async function postAction(action, payload) {
  const body = JSON.stringify({ action, token: process.env.CLANDASH_TOKEN || CONFIG.GATE_PASSWORD || '', ...payload });
  return fetchJson(CONFIG.APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)) },
    body,
  });
}

async function fetchJson(url, opts = { cache: 'no-store' }, tries = 3) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    const res = await fetch(url, opts.method === 'POST' ? { ...opts, redirect: 'manual' } : opts);
    if (opts.method === 'POST' && res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const redirected = await fetch(res.headers.get('location'), { method: 'GET', cache: 'no-store' });
      const text = await redirected.text();
      if (redirected.ok && text.trim().startsWith('{')) {
        const json = JSON.parse(text);
        if (json.error) throw new Error(json.error);
        return json.data;
      }
      last = `HTTP ${redirected.status} ${text.slice(0, 120).replace(/\s+/g, ' ')}`;
      await new Promise((resolve) => setTimeout(resolve, 500 * i));
      continue;
    }
    const text = await res.text();
    if (res.ok && text.trim().startsWith('{')) {
      const json = JSON.parse(text);
      if (json.error) throw new Error(json.error);
      return json.data;
    }
    last = `HTTP ${res.status} ${text.slice(0, 120).replace(/\s+/g, ' ')}`;
    await new Promise((resolve) => setTimeout(resolve, 500 * i));
  }
  throw new Error(last || 'empty response');
}

function filterReports(reports, opts) {
  let rows = reports;
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);
  if (!opts.all && !opts.status) rows = rows.filter((r) => !['resolved', 'closed'].includes(r.status));
  return rows;
}

function requireReport(reports, id) {
  if (!id) usage(1, 'slot-or-id가 필요합니다.');
  const report = reports.find((r) => r.id === id || r.slot === id);
  if (!report) throw new Error(`QA 리포트를 찾을 수 없습니다: ${id}`);
  return report;
}

function normalizeStatus(status) {
  const s = String(status || 'resolved');
  if (!VALID_STATUS.has(s)) throw new Error(`지원하지 않는 status: ${status}`);
  return s;
}

async function replyMessage(opts) {
  if (opts.message != null) return String(opts.message);
  if (opts.file) return readFile(String(opts.file), 'utf8');
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  return '';
}

function formatRow(r) {
  const status = STATUS_LABEL[r.status] || r.status || '접수';
  const severity = SEVERITY_LABEL[r.severity] || r.severity || '보통';
  const type = TYPE_LABEL[r.type] || TYPE_LABEL.bug;
  const date = formatDate(r.createdAt);
  return `${r.slot || r.id} [${type}/${status}/${severity}] ${r.title || '(제목 없음)'} · ${r.area || '기타'} · ${date}`;
}

function formatReport(r) {
  return `${formatRow(r)}

id: ${r.id || '-'}
유형: ${TYPE_LABEL[r.type] || TYPE_LABEL.bug}
제보자: ${r.reporter || '-'}
담당: ${r.assignee || '-'}
자동 처리: ${r.automationStatus || '-'}
수정: ${formatDate(r.updatedAt || r.createdAt)}
해결: ${formatDate(r.resolvedAt)}

환경:
${r.environment || '-'}

재현 절차:
${r.steps || '-'}

기대 결과:
${r.expected || '-'}

실제 결과:
${r.actual || '-'}

추가 메모:
${r.note || '-'}

Codex 응답:
${r.reply || '-'}`;
}

function formatDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}

function buildPrompt(report) {
  const typeLabel = TYPE_LABEL[report.type] || TYPE_LABEL.bug;
  const handling = report.type === 'improvement'
    ? '현재 구조와 요청 의도를 확인하고, 기존 동작을 보존하면서 개선사항을 구현하세요.'
    : '재현 가능한 원인을 찾고 회귀를 막는 방식으로 수정하세요.';
  return `ClanDashboard ${typeLabel}을 처리하세요.

슬롯: ${report.slot}
유형: ${typeLabel}
상태: ${STATUS_LABEL[report.status] || report.status || '접수'}
심각도: ${SEVERITY_LABEL[report.severity] || report.severity || '보통'}
영역: ${report.area || '-'}
제보자: ${report.reporter || '-'}
제목: ${report.title || '-'}

환경:
${report.environment || '-'}

재현 절차:
${report.steps || '-'}

기대 결과:
${report.expected || '-'}

실제 결과:
${report.actual || '-'}

추가 메모:
${report.note || '-'}

요청:
1. ${handling}
2. 가능한 검증 명령을 실행하세요.
3. 완료 후 다음 명령으로 QA 히스토리에 응답을 남기세요.

node scripts/qa-reports.mjs reply ${report.slot} --status resolved --message "수정 내용과 검증 결과"`;
}
