#!/usr/bin/env node
// QA report helper for the local Codex CLI workflow.
// Reads/writes the same DB state used by the dashboard.

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
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
  } else if (command === 'claim') {
    const r = requireReport(reports, positionals[0]);
    r.status = 'in_progress';
    r.assignee = options.assignee || positionals[1] || process.env.USERNAME || process.env.USER || 'Codex';
    r.updatedAt = new Date().toISOString();
    await store.save();
    console.log(`${r.slot} 처리중: ${r.assignee}`);
  } else if (command === 'reply' || command === 'resolve') {
    const r = requireReport(reports, positionals[0]);
    const status = normalizeStatus(options.status || (command === 'resolve' ? 'resolved' : 'resolved'));
    const message = await replyMessage(options);
    if (['resolved', 'closed'].includes(status) && !message.trim()) {
      throw new Error('해결/종료 응답에는 --message, --file, 또는 stdin 내용이 필요합니다.');
    }
    r.status = status;
    r.reply = message.trim();
    r.assignee = options.assignee || r.assignee || process.env.USERNAME || process.env.USER || 'Codex';
    r.updatedAt = new Date().toISOString();
    if (['resolved', 'closed'].includes(status) && !r.resolvedAt) r.resolvedAt = r.updatedAt;
    await store.save();
    console.log(`${r.slot} ${STATUS_LABEL[r.status]} 응답 저장됨`);
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
  node scripts/qa-reports.mjs claim <slot-or-id> [assignee]
  node scripts/qa-reports.mjs reply <slot-or-id> [--status resolved] [--message "..."]
  node scripts/qa-reports.mjs reply <slot-or-id> --file reply.txt

Options:
  --state-file path   Use a local JSON state file instead of Apps Script.
  --assignee name     Set the 담당 field.
  --all               Include resolved/closed reports in list.

Environment:
  CLANDASH_TOKEN      Apps Script write token. Defaults to docs/js/config.js GATE_PASSWORD.
  CLANDASH_STATE_FILE Same as --state-file.`);
  process.exit(code);
}

async function loadState() {
  const stateFile = options['state-file'] || process.env.CLANDASH_STATE_FILE;
  if (stateFile) {
    const raw = (await readFile(stateFile, 'utf8')).replace(/^\uFEFF/, '');
    const state = JSON.parse(raw);
    return {
      state,
      save: async () => writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8'),
    };
  }
  if (!CONFIG.APPS_SCRIPT_URL) {
    throw new Error('APPS_SCRIPT_URL이 비어 있습니다. --state-file 또는 CLANDASH_STATE_FILE을 지정하세요.');
  }
  const state = await fetchJson(`${CONFIG.APPS_SCRIPT_URL}?${new URLSearchParams({ action: 'getAll', _ts: String(Date.now()) })}`);
  if (!state || typeof state !== 'object') throw new Error('원격 DB 상태를 불러오지 못했습니다.');
  return {
    state,
    save: async () => {
      const token = process.env.CLANDASH_TOKEN || CONFIG.GATE_PASSWORD || '';
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'save', token, data: state }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
    },
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.data;
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
  const date = formatDate(r.createdAt);
  return `${r.slot || r.id} [${status}/${severity}] ${r.title || '(제목 없음)'} · ${r.area || '기타'} · ${date}`;
}

function formatReport(r) {
  return `${formatRow(r)}

id: ${r.id || '-'}
제보자: ${r.reporter || '-'}
담당: ${r.assignee || '-'}
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
  return `ClanDashboard QA 리포트를 처리하세요.

슬롯: ${report.slot}
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
1. 현재 워크트리에서 원인을 찾아 수정하세요.
2. 가능한 검증 명령을 실행하세요.
3. 완료 후 다음 명령으로 QA 히스토리에 응답을 남기세요.

node scripts/qa-reports.mjs reply ${report.slot} --status resolved --message "수정 내용과 검증 결과"`;
}
