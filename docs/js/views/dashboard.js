// dashboard.js — overview: clan stats, tier distribution, top lists.
import { DB, Mutations } from '../db.js';
import { Roles } from '../roles.js';
import { computeSettlement, tierForScore } from '../calc.js';
import { el, fmt, toast, clear } from '../util.js';
import { CONFIG, TIER_COLORS, CLASSES, CLASS_LIST } from '../config.js';
import { page, card, statCard, table, classBadge, tierBadge, btn, modal, select, field, input } from './ui.js';

const QA_STATUS = {
  open: { label: '접수', cls: 'open' },
  in_progress: { label: '처리중', cls: 'in-progress' },
  resolved: { label: '해결', cls: 'resolved' },
  blocked: { label: '보류', cls: 'blocked' },
  closed: { label: '종료', cls: 'closed' },
};
const QA_SEVERITY = {
  low: '낮음',
  normal: '보통',
  high: '높음',
  critical: '긴급',
};
const QA_AREAS = ['대시보드', '클랜원', '참여 기록', '다이아 정산', '전리품', '장비/캐릭터 현황', '분배 파라미터', '설정', 'DB/동기화', '기타'];
const ROUTE_AREA = {
  dashboard: '대시보드',
  members: '클랜원',
  participation: '참여 기록',
  diamond: '다이아 정산',
  rotation: '전리품',
  gear: '장비/캐릭터 현황',
  'dist-params': '분배 파라미터',
  settings: '설정',
};

export function renderDashboard() {
  const s = DB.state;
  const members = s.members.filter((m) => m.active !== false);
  const res = computeSettlement(s);
  const live = !!CONFIG.APPS_SCRIPT_URL;

  const body = page(`${s.meta?.clanName || ''} 클랜 대시보드`, {
    subtitle: new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }),
    actions: [
      el('span.mode-pill', { class: live ? 'live' : 'local', text: live ? '클라우드 동기화' : '로컬 저장' }),
      Roles.isAdmin() ? btn('QA 히스토리', () => openQaHistory(), { kind: 'ghost', admin: true }) : null,
      Roles.isAdmin() ? btn('콘텐츠 점수표', () => location.hash = '#/dist-params', { kind: 'ghost', admin: true }) : null,
      Roles.isAdmin() ? btn('직업 수정', () => openClassEditor(), { kind: 'ghost', admin: true }) : null,
    ],
  });

  // ── top stats ──
  const tierCount = res.tierCount;
  body.appendChild(el('div.stat-grid', {}, [
    statCard('클랜원', fmt(members.length), { sub: `휴면 ${s.members.length - members.length}명` }),
    statCard('총 다이아', fmt(s.settings.totalDiamonds)),
    statCard('평균 전투력', fmt(members.reduce((a, m) => a + m.power, 0) / (members.length || 1))),
    statCard('S/A 티어', fmt((tierCount.S || 0) + (tierCount.A || 0)), { sub: `S ${tierCount.S || 0} · A ${tierCount.A || 0}` }),
  ]));
  if (Roles.isAdmin()) body.appendChild(qaSummaryCard());

  // ── tier distribution bar ──
  const tierBar = el('div.tier-bar');
  s.tiers.forEach((t) => {
    const n = tierCount[t.tier] || 0;
    if (!n) return;
    tierBar.appendChild(el('div.tier-seg', {
      style: { flex: n, background: TIER_COLORS[t.tier] }, title: `${t.tier}: ${n}명`,
    }, [el('span', { text: `${t.tier} ${n}` })]));
  });

  // ── class distribution ──
  const byClass = {};
  members.forEach((m) => { byClass[m.cls] = (byClass[m.cls] || 0) + 1; });
  const classBar = el('div.tier-bar');
  Object.entries(byClass).sort((a, b) => b[1] - a[1]).forEach(([cls, n]) => {
    classBar.appendChild(el('div.tier-seg', { style: { flex: n, background: (CLASSES[cls] || {}).color || '#888' }, title: `${cls}: ${n}명` }, [el('span', { text: `${(CLASSES[cls] || {}).tag || cls} ${n}` })]));
  });

  body.appendChild(el('div.col-2', {}, [
    card('티어 분포', tierBar, { className: 'card-compact' }),
    card('직업 분포', classBar, { className: 'card-compact' }),
  ]));

  // ── top combat power & top participation ──
  const topPower = [...members].sort((a, b) => b.power - a.power).slice(0, 10);
  const topPart = [...members].sort((a, b) => b.score - a.score).slice(0, 10);
  body.appendChild(el('div.col-2', {}, [
    card('전투력 TOP 10', table([
      { label: '#', align: 'center', width: '36px', render: (_, i) => i + 1 },
      { key: 'name', label: '닉네임', render: (m) => el('b', { text: m.name }) },
      { label: '직업', render: (m) => classBadge(m.cls) },
      { key: 'power', label: '전투력', align: 'right', render: (m) => m.power.toLocaleString() },
    ], topPower), { className: 'card-compact', actions: btn('명단 전체', () => location.hash = '#/members', { kind: 'ghost' }) }),
    card('참여점수 TOP 10', table([
      { label: '#', align: 'center', width: '36px', render: (_, i) => i + 1 },
      { key: 'name', label: '닉네임', render: (m) => el('b', { text: m.name }) },
      { label: '티어', align: 'center', render: (m) => tierBadge(tierForScore(m.score, s.tiers)) },
      { key: 'score', label: '점수', align: 'right', render: (m) => fmt(m.score) },
    ], topPart), { className: 'card-compact', actions: btn('참여도 관리', () => location.hash = '#/participation', { kind: 'ghost' }) }),
  ]));
}

function qaReports() {
  return [...(DB.state.qaReports || [])].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function currentArea() {
  const route = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  return ROUTE_AREA[route] || '기타';
}

function isDashboardRoute() {
  return (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0] === 'dashboard';
}

function qaStatusBadge(report) {
  const meta = QA_STATUS[report.status] || QA_STATUS.open;
  return el('span.qa-status', { class: meta.cls, text: meta.label });
}

function qaSeverityBadge(report) {
  return el('span.qa-severity', { class: report.severity || 'normal', text: QA_SEVERITY[report.severity] || '보통' });
}

function formatQaDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function qaSummaryCard() {
  const reports = qaReports();
  const pending = reports.filter((r) => !['resolved', 'closed'].includes(r.status)).length;
  const resolved = reports.filter((r) => r.status === 'resolved' || r.status === 'closed').length;
  const latest = reports.slice(0, 4);
  return card('QA 리포트', el('div.qa-summary', {}, [
    el('div.qa-metrics', {}, [
      qaMetric('대기', pending),
      qaMetric('해결', resolved),
      qaMetric('전체', reports.length),
    ]),
    latest.length
      ? el('div.qa-mini-list', {}, latest.map((r) => el('button.qa-mini', { type: 'button', onclick: () => openQaHistory(r.id) }, [
        el('span.qa-mini-main', {}, [el('b', { text: r.slot }), qaStatusBadge(r)]),
        el('span.qa-mini-title', { text: r.title || '(제목 없음)' }),
      ])))
      : el('div.empty.small', { text: '등록된 QA 리포트가 없습니다.' }),
  ]), {
    actions: [
      btn('작성', () => openBugReportForm(), { kind: 'ghost', admin: true }),
      btn('내역', () => openQaHistory(), { kind: 'primary', admin: true }),
    ],
  });
}

function qaMetric(label, value) {
  return el('div.qa-metric', {}, [
    el('div.qa-metric-value', { text: fmt(value) }),
    el('div.qa-metric-label', { text: label }),
  ]);
}

function textarea(attrs = {}) {
  const { value, ...rest } = attrs;
  const node = el('textarea.input', rest);
  if (value != null) node.value = value;
  return node;
}

export function openBugReportForm() {
  const title = input({ placeholder: '예: 참여 기록 저장 후 새로고침 시 인원이 사라짐' });
  const area = select(QA_AREAS, currentArea());
  const severity = select(Object.entries(QA_SEVERITY).map(([value, label]) => ({ value, label })), 'normal');
  const environment = input({ value: `${navigator.platform || 'browser'} · ${location.href}` });
  const steps = textarea({ rows: 5, placeholder: '1. ...\n2. ...\n3. ...' });
  const expected = textarea({ rows: 3, placeholder: '기대했던 결과' });
  const actual = textarea({ rows: 3, placeholder: '실제로 발생한 문제' });
  const note = textarea({ rows: 3, placeholder: '관련 데이터, 계정, 스크린샷 위치 등' });

  modal('버그 리포트 작성', (close) => el('div.form.qa-form', {}, [
    el('div.form-grid', {}, [field('영역', area), field('심각도', severity)]),
    field('제목', title),
    field('환경', environment),
    field('재현 절차', steps),
    field('기대 결과', expected),
    field('실제 결과', actual),
    field('추가 메모', note),
    el('div.modal-actions', {}, [
      btn('취소', close),
      btn('제출', () => {
        if (!title.value.trim()) return toast('제목을 입력하세요', 'error');
        if (!steps.value.trim() && !actual.value.trim()) return toast('재현 절차 또는 실제 결과를 입력하세요', 'error');
        const rec = Mutations.addQaReport({
          title: title.value.trim(),
          area: area.value,
          severity: severity.value,
          environment: environment.value.trim(),
          steps: steps.value.trim(),
          expected: expected.value.trim(),
          actual: actual.value.trim(),
          note: note.value.trim(),
          reporter: Roles.me(),
        });
        DB.commit({ immediate: true });
        toast(`${rec.slot} 리포트가 접수되었습니다`);
        close();
        if (isDashboardRoute()) renderDashboard();
      }, { kind: 'primary' }),
    ]),
  ]), { wide: true });
}

function openQaHistory(initialId) {
  let selectedId = initialId || qaReports()[0]?.id || '';
  const host = el('div.qa-history');
  const render = () => {
    const reports = qaReports();
    if (!selectedId || !reports.some((r) => r.id === selectedId)) selectedId = reports[0]?.id || '';
    const selected = reports.find((r) => r.id === selectedId);
    clear(host);
    host.appendChild(el('div.qa-history-layout', {}, [
      reports.length ? el('div.qa-slot-list', {}, reports.map((r) => qaSlotButton(r, r.id === selectedId, () => { selectedId = r.id; render(); })))
        : el('div.empty.small', { text: '등록된 QA 리포트가 없습니다.' }),
      selected ? qaDetail(selected, render) : el('div.qa-detail.empty-detail', { text: '선택된 리포트가 없습니다.' }),
    ]));
  };
  modal('QA 리포트 히스토리', () => host, {
    wide: 'x',
    headerActions: (close) => [btn('새 리포트', () => { close(); openBugReportForm(); }, { kind: 'primary', admin: true })],
  });
  render();
}

function qaSlotButton(report, active, onclick) {
  return el('button.qa-slot', { type: 'button', class: active ? 'active' : '', onclick }, [
    el('span.qa-slot-head', {}, [el('b', { text: report.slot }), qaStatusBadge(report)]),
    el('span.qa-slot-title', { text: report.title || '(제목 없음)' }),
    el('span.qa-slot-meta', { text: `${QA_SEVERITY[report.severity] || '보통'} · ${report.area || '기타'} · ${formatQaDate(report.createdAt)}` }),
  ]);
}

function qaDetail(report, rerender) {
  return el('div.qa-detail', {}, [
    el('div.qa-detail-head', {}, [
      el('div', {}, [
        el('div.qa-detail-slot', { text: report.slot }),
        el('h3.qa-detail-title', { text: report.title || '(제목 없음)' }),
      ]),
      el('div.qa-detail-badges', {}, [qaStatusBadge(report), qaSeverityBadge(report)]),
    ]),
    el('div.qa-meta-grid', {}, [
      qaMeta('영역', report.area || '-'),
      qaMeta('제보자', report.reporter || '-'),
      qaMeta('담당', report.assignee || '-'),
      qaMeta('접수', formatQaDate(report.createdAt)),
      qaMeta('수정', formatQaDate(report.updatedAt || report.createdAt)),
      qaMeta('해결', formatQaDate(report.resolvedAt)),
    ]),
    qaBlock('환경', report.environment),
    qaBlock('재현 절차', report.steps),
    qaBlock('기대 결과', report.expected),
    qaBlock('실제 결과', report.actual),
    qaBlock('추가 메모', report.note),
    el('div.modal-sec', { text: 'Codex 응답' }),
    report.reply ? el('div.qa-reply', { text: report.reply }) : el('div.empty.small', { text: '아직 응답이 없습니다.' }),
    Roles.isAdmin() ? el('div.row-actions', { class: 'qa-detail-actions' }, [
      btn('프롬프트 복사', () => copyText(buildCodexPrompt(report)), { kind: 'ghost' }),
      !['resolved', 'closed'].includes(report.status) ? btn('처리중 표시', () => {
        Mutations.updateQaReport(report.id, { status: 'in_progress', assignee: Roles.me() });
        DB.commit({ immediate: true });
        toast('처리중으로 표시했습니다');
        rerender();
      }, { kind: 'ghost' }) : null,
      btn(report.reply ? '응답 수정' : '응답 작성', () => openQaReplyEditor(report, rerender), { kind: 'primary' }),
    ]) : null,
  ]);
}

function qaMeta(label, value) {
  return el('div.qa-meta', {}, [el('span', { text: label }), el('b', { text: value })]);
}

function qaBlock(label, value) {
  if (!value) return null;
  return el('div.qa-block', {}, [
    el('div.qa-block-label', { text: label }),
    el('div.qa-block-text', { text: value }),
  ]);
}

function openQaReplyEditor(report, onSaved) {
  const defaultStatus = ['open', 'in_progress'].includes(report.status) ? 'resolved' : (report.status || 'resolved');
  const status = select(Object.entries(QA_STATUS).map(([value, meta]) => ({ value, label: meta.label })), defaultStatus);
  const assignee = input({ value: report.assignee || Roles.me() || 'Codex' });
  const reply = textarea({ rows: 8, placeholder: '수정 내용, 영향 범위, 검증 결과를 남기세요.', value: report.reply || '' });
  modal(`${report.slot} 응답`, (close) => el('div.form', {}, [
    el('div.form-grid', {}, [field('상태', status), field('담당', assignee)]),
    field('응답', reply),
    el('div.modal-actions', {}, [
      btn('취소', close),
      btn('저장', () => {
        if (['resolved', 'closed'].includes(status.value) && !reply.value.trim()) return toast('해결/종료 상태에는 응답을 입력하세요', 'error');
        Mutations.updateQaReport(report.id, {
          status: status.value,
          assignee: assignee.value.trim(),
          reply: reply.value.trim(),
        });
        DB.commit({ immediate: true });
        toast('QA 응답을 저장했습니다');
        close();
        onSaved();
      }, { kind: 'primary' }),
    ]),
  ]), { wide: true });
}

function buildCodexPrompt(report) {
  return `ClanDashboard QA 리포트를 처리하세요.

슬롯: ${report.slot}
상태: ${(QA_STATUS[report.status] || QA_STATUS.open).label}
심각도: ${QA_SEVERITY[report.severity] || '보통'}
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

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el('textarea', { value: text, style: { position: 'fixed', left: '-9999px' } });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Codex 프롬프트를 복사했습니다');
}

function openClassEditor() {
  const rows = [...DB.state.members]
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ko'));
  modal('클랜원 직업 수정', () => table([
    { key: 'name', label: '닉네임', render: (m) => el('b', { text: m.name || '-' }) },
    { label: '직업', render: (m) => select(CLASS_LIST, m.cls, {
      onchange: (e) => {
        m.cls = e.target.value;
        DB.commit();
        toast(`${m.name} 직업을 변경했습니다`);
      },
    }) },
    { label: '상태', align: 'center', render: (m) => el('span.dot', { class: m.active !== false ? 'on' : 'off', title: m.active !== false ? '활동' : '휴면' }) },
  ], rows), { wide: true, onClose: () => renderDashboard() });
}
