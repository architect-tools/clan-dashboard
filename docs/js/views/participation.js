// participation.js — date-driven participation tracking.
// Flow: pick a date on the calendar → pick a content (buttons by category) →
// drop a screenshot (OCR) or pick members manually → confirm → recorded for that
// date+content. Scores are computed from the event log over a settlement period.
import { DB, Mutations } from '../db.js';
import { computeScores, tierForScore } from '../calc.js';
import { el, fmt, toast, clear } from '../util.js';
import { CATEGORY_ORDER } from '../config.js';
import { loadImage, extractLines, extractSlots, matchRoster } from '../ocr.js';
import { page, card, btn, tierBadge, classBadge } from './ui.js';

const todayISO = () => new Date().toISOString().slice(0, 10);
let selDate = todayISO();
let selContent = null;
let viewMonth = null; // {y, m} 0-based month

function catGroups(catalog, includeInactive = false) {
  const list = catalog.filter((c) => includeInactive || c.active);
  const g = {};
  for (const c of list) (g[c.category] ||= []).push(c);
  return [...new Set(list.map((c) => c.category))]
    .sort((a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99))
    .map((cat) => ({ cat, items: g[cat] }));
}

export function renderParticipation() {
  const s = DB.state;
  if (!viewMonth) { const d = new Date(selDate); viewMonth = { y: d.getFullYear(), m: d.getMonth() }; }

  const body = page('주간 참여도', {
    subtitle: '날짜 선택 → 콘텐츠 선택 → 스크린샷으로 참여자 자동 기록',
    actions: [btn('📊 참여점수 산정', () => location.hash = '#/participation?score', { kind: 'ghost' })],
  });

  // two-column: calendar (left) + day detail (right)
  const calCol = el('div.part-cal');
  const dayCol = el('div.part-day');
  body.appendChild(el('div.part-layout', {}, [calCol, dayCol]));

  renderCalendar(calCol);
  renderDay(dayCol);

  // score panel toggled via hash query
  if ((location.hash.split('?')[1] || '') === 'score') body.appendChild(renderScorePanel());
}

// ── calendar ────────────────────────────────────────────────────────
function renderCalendar(host) {
  clear(host);
  const { y, m } = viewMonth;
  const first = new Date(y, m, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday=0
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const byDate = DB.state.participation.byDate;

  const head = el('div.cal-head', {}, [
    btn('‹', () => { viewMonth = m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }; renderParticipation(); }, { kind: 'ghost' }),
    el('div.cal-title', { text: `${y}년 ${m + 1}월` }),
    btn('›', () => { viewMonth = m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }; renderParticipation(); }, { kind: 'ghost' }),
    btn('오늘', () => { selDate = todayISO(); const d = new Date(selDate); viewMonth = { y: d.getFullYear(), m: d.getMonth() }; renderParticipation(); }, { kind: 'ghost' }),
  ]);
  host.appendChild(card(null, el('div', {}, [head, calGrid()]), { className: 'card-compact' }));

  function calGrid() {
    const grid = el('div.cal-grid');
    ['월', '화', '수', '목', '금', '토', '일'].forEach((d, i) =>
      grid.appendChild(el('div.cal-dow', { class: i >= 5 ? 'weekend' : '', text: d })));
    for (let i = 0; i < startDow; i++) grid.appendChild(el('div.cal-cell.empty'));
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const recs = byDate[iso] ? Object.keys(byDate[iso]).length : 0;
      const cell = el('div.cal-cell', {
        class: (iso === selDate ? 'sel' : '') + (iso === todayISO() ? ' today' : ''),
        onclick: () => { selDate = iso; selContent = null; renderParticipation(); },
      }, [el('span.cal-num', { text: day }), recs ? el('span.cal-badge', { text: recs }) : null]);
      grid.appendChild(cell);
    }
    return grid;
  }
}

// ── day detail: content buttons + drop area ──────────────────────────
function renderDay(host) {
  clear(host);
  const s = DB.state;
  const dstr = new Date(selDate).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
  const groups = catGroups(s.contentCatalog);

  const btnWrap = el('div.content-cats');
  groups.forEach((g) => {
    const row = el('div.content-cat', {}, [el('div.content-cat-label', { text: g.cat })]);
    const btns = el('div.content-btns');
    g.items.forEach((c) => {
      const n = Mutations.getEvent(selDate, c.name).length;
      btns.appendChild(el('button.content-btn', {
        class: (selContent === c.name ? 'active' : '') + (n ? ' has' : ''),
        onclick: () => { selContent = selContent === c.name ? null : c.name; renderParticipation(); },
        title: `${c.name} · ${c.points}점`,
      }, [el('span', { text: c.name }), n ? el('span.cbadge', { text: n }) : null]));
    });
    row.appendChild(btns); btnWrap.appendChild(row);
  });

  const head = el('div.day-head', {}, [
    el('h3', { text: dstr }),
    el('span.day-sub', { text: `기록 ${Object.keys(s.participation.byDate[selDate] || {}).length}종` }),
  ]);

  const panel = el('div.day-panel');
  if (selContent) panel.appendChild(checkinPanel(selContent));
  else panel.appendChild(daySummaryPanel());

  host.appendChild(card(null, el('div', {}, [head, btnWrap, panel])));
}

function daySummaryPanel() {
  const s = DB.state;
  const day = s.participation.byDate[selDate] || {};
  const contents = Object.keys(day);
  if (!contents.length) return el('div.empty', { text: '위에서 콘텐츠를 선택해 참여자를 기록하세요.' });
  const byId = Object.fromEntries(s.members.map((m) => [m.id, m]));
  const wrap = el('div.day-records');
  contents.forEach((cn) => {
    const ids = day[cn];
    wrap.appendChild(el('div.rec-block', {}, [
      el('div.rec-head', {}, [
        el('b', { text: cn }), el('span.rec-count', { text: `${ids.length}명` }),
        btn('편집', () => { selContent = cn; renderParticipation(); }, { kind: 'ghost' }),
      ]),
      el('div.chips', {}, ids.map((id) => el('span.chip', { text: byId[id]?.name || '?' }))),
    ]));
  });
  return wrap;
}

// ── check-in panel for a chosen content ──────────────────────────────
function checkinPanel(content) {
  const s = DB.state;
  const roster = s.members.filter((m) => m.active !== false);
  const cat = s.contentCatalog.find((c) => c.name === content);
  const current = new Set(Mutations.getEvent(selDate, content)); // memberIds already recorded
  let curImg = null, crop = null, imgEl = null;
  let mode = 'full';                 // 'full' (영역 일괄, 권장·정확) | 'slot' (격자 정밀, 보조)
  let gridRows = 5, gridCols = 5, nameLeftPct = 0.18;

  const wrap = el('div.checkin');
  wrap.appendChild(el('div.checkin-head', {}, [
    el('b', { text: `${content} 참여 기록` }),
    cat ? el('span.muted', { text: `${cat.points}점 · ${cat.category}` }) : null,
  ]));

  const drop = el('div.drop', {}, [
    el('div.drop-icon', { text: '📷' }),
    el('div', { text: '참여자 스크린샷을 끌어다 놓거나 클릭' }),
    el('div.drop-sub', { text: '붙여넣기(Ctrl+V) 지원' }),
  ]);
  const fileInput = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  const previewWrap = el('div.ocr-preview', { style: { display: 'none' } });
  const controls = el('div.ocr-controls', { style: { display: 'none' } });
  const progress = el('div.ocr-progress');
  const ocrResult = el('div.ocr-result');

  drop.onclick = () => fileInput.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files[0]); };
  fileInput.onchange = () => pick(fileInput.files[0]);

  async function pick(file) {
    if (!file || !file.type.startsWith('image/')) return;
    try { curImg = await loadImage(file); } catch { return toast('이미지를 열 수 없습니다', 'error'); }
    crop = null; drop.style.display = 'none'; buildPreview();
    if (mode === 'full') runOcr(); // auto-run on upload; user can crop the panel then re-run for higher accuracy
  }

  let selBox = null, gridLayer = null, dragging = null;
  function buildPreview() {
    clear(previewWrap); previewWrap.style.display = 'block';
    const dispW = Math.min(560, curImg.naturalWidth);
    imgEl = el('img.ocr-img', { src: curImg.src, style: { width: dispW + 'px' } });
    selBox = el('div.crop-box', { style: { display: 'none' } });
    gridLayer = el('div.grid-layer');
    const stage = el('div.crop-stage', {}, [imgEl, selBox, gridLayer]);
    previewWrap.appendChild(el('div.ocr-hint', {
      text: mode === 'slot' ? '① 명단이 있는 한 묶음(예: 1~5부대)을 드래그 → ② 빨간 칸이 닉네임에 맞게 행/열 조정 → ③ 격자 인식'
        : '💡 닉네임이 모두 보이도록 클랜 명단 영역을 드래그한 뒤 “선택영역 인식”을 누르면 정확도가 크게 올라갑니다 (배경·UI 제외).' }));
    previewWrap.appendChild(stage);
    imgEl.onload = drawGrid;
    buildControls();
    const ptr = (e) => { const r = imgEl.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, r }; };
    stage.onmousedown = (e) => { if (e.target.closest('.grid-layer')) return; const p = ptr(e); dragging = { x0: p.x, y0: p.y }; };
    stage.onmousemove = (e) => {
      if (!dragging) return; const p = ptr(e);
      const x = Math.max(0, Math.min(dragging.x0, p.x)), y = Math.max(0, Math.min(dragging.y0, p.y));
      const w = Math.min(p.r.width, Math.abs(p.x - dragging.x0)), h = Math.min(p.r.height, Math.abs(p.y - dragging.y0));
      Object.assign(selBox.style, { display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      const sx = curImg.naturalWidth / p.r.width, sy = curImg.naturalHeight / p.r.height;
      if (w > 8 && h > 8) crop = { x: x * sx, y: y * sy, w: w * sx, h: h * sy };
      drawGrid();
    };
    const end = () => { dragging = null; }; stage.onmouseup = end; stage.onmouseleave = end;
    drawGrid();
  }

  function buildControls() {
    clear(controls); controls.style.display = 'flex';
    const seg = el('div.seg', {}, [
      el('button.seg-btn', { class: mode === 'full' ? 'on' : '', text: '영역 일괄 (권장)', onclick: () => { mode = 'full'; buildControls(); drawGrid(); } }),
      el('button.seg-btn', { class: mode === 'slot' ? 'on' : '', text: '격자 정밀', onclick: () => { mode = 'slot'; buildControls(); drawGrid(); } }),
    ]);
    controls.appendChild(seg);
    if (mode === 'slot') {
      const num = (label, val, min, max, step, cb) => el('label.mini-field', {}, [el('span', { text: label }),
        el('input.input.mini-num', { type: 'number', value: val, min, max, step, onchange: (e) => { cb(+e.target.value); drawGrid(); } })]);
      controls.appendChild(num('열', gridCols, 1, 10, 1, (v) => gridCols = Math.max(1, v)));
      controls.appendChild(num('행', gridRows, 1, 12, 1, (v) => gridRows = Math.max(1, v)));
      controls.appendChild(num('좌측여백%', Math.round(nameLeftPct * 100), 0, 60, 2, (v) => nameLeftPct = Math.min(0.6, Math.max(0, v / 100))));
      controls.appendChild(btn('격자 인식', () => runOcr(), { kind: 'primary' }));
    } else {
      controls.appendChild(btn('🔍 선택영역 인식', () => runOcr(), { kind: 'primary' }));
      controls.appendChild(btn('전체 영역', () => { crop = null; if (selBox) selBox.style.display = 'none'; drawGrid(); runOcr(); }, { kind: 'ghost' }));
    }
    controls.appendChild(btn('다른 스크린샷', () => fileInput.click(), { kind: 'ghost' }));
  }

  function drawGrid() {
    if (!gridLayer || !imgEl) return;
    clear(gridLayer);
    if (mode !== 'slot') { gridLayer.style.display = 'none'; return; }
    gridLayer.style.display = 'block';
    const dw = imgEl.clientWidth, dh = imgEl.clientHeight;
    const sx = dw / curImg.naturalWidth, sy = dh / curImg.naturalHeight;
    const reg = crop ? { x: crop.x * sx, y: crop.y * sy, w: crop.w * sx, h: crop.h * sy } : { x: 0, y: 0, w: dw, h: dh };
    const cw = reg.w / gridCols, rh = reg.h / gridRows;
    for (let r = 0; r < gridRows; r++) for (let c = 0; c < gridCols; c++) {
      const cell = el('div.grid-cell', { style: {
        left: (reg.x + c * cw + cw * nameLeftPct) + 'px', top: (reg.y + r * rh + rh * 0.06) + 'px',
        width: (cw * (1 - nameLeftPct - 0.02)) + 'px', height: (rh * 0.88) + 'px' } });
      gridLayer.appendChild(cell);
    }
  }

  const picked = new Map(); // memberId -> {member, score, token, checked}
  const manual = new Map();
  async function runOcr() {
    if (!curImg) return;
    try {
      const prog = (p) => { progress.textContent = `${p.stage} (${Math.round(p.progress * 100)}%)`; };
      const out = mode === 'slot'
        ? await extractSlots(curImg, crop, { rows: gridRows, cols: gridCols, nameLeftPct }, prog)
        : await extractLines(curImg, crop, prog);
      const { matched, maybe, unmatched } = matchRoster(out.lines, roster);
      picked.clear();
      for (const mm of [...matched, ...maybe]) picked.set(mm.member.id, { ...mm, checked: mm.score >= 0.72 });
      progress.textContent = `인식 완료 — 신뢰 ${matched.length} · 확인필요 ${maybe.length} (${out.engine})`;
      renderResult(unmatched);
    } catch (e) { console.error(e); toast('OCR 실패: ' + e.message, 'error'); progress.textContent = ''; }
  }

  // manual roster picker (always available, even without screenshot)
  const manualPick = el('details.manual-pick', {}, [
    el('summary', { text: '명단에서 직접 선택 / 추가' }),
    el('div.pick-grid', {}, roster.map((m) => {
      const on = current.has(m.id);
      return el('label.pick-item', { class: on ? 'on' : '' }, [
        el('input', { type: 'checkbox', checked: on, dataset: { mid: m.id }, onchange: (e) => e.target.closest('.pick-item').classList.toggle('on', e.target.checked) }),
        el('span', { text: m.name }),
      ]);
    })),
  ]);

  function renderResult(unmatched = []) {
    clear(ocrResult);
    const items = [...picked.values()].sort((a, b) => b.score - a.score);
    if (items.length) {
      ocrResult.appendChild(el('div.ocr-head', { text: `인식 ${items.length}명 (체크된 인원만 기록)` }));
      const list = el('div.match-list');
      items.forEach((mm) => {
        const cb = el('input', { type: 'checkbox', checked: mm.checked, onchange: (e) => { mm.checked = e.target.checked; } });
        list.appendChild(el('label.match-row', { class: mm.score < 0.72 ? 'low' : '' }, [
          cb, el('b', { text: mm.member.name }), el('span.match-token', { text: `“${mm.token}”` }),
          el('span.match-score', { text: Math.round(mm.score * 100) + '%' }),
        ]));
      });
      unmatched.slice(0, 30).forEach((tok) => {
        const sel = el('select.input', { onchange: (e) => manual.set(tok, e.target.value) }, [
          el('option', { value: '', text: '— 무시 —' }), ...roster.map((m) => el('option', { value: m.id, text: m.name })),
        ]);
        list.appendChild(el('label.match-row.unmatched', {}, [el('span.match-token', { text: `“${tok}”` }), el('span', { text: '→' }), sel]));
      });
      ocrResult.appendChild(list);
    }
  }

  const actions = el('div.checkin-actions', {}, [
    btn('취소', () => { selContent = null; renderParticipation(); }, { kind: 'ghost' }),
    Mutations.getEvent(selDate, content).length
      ? btn('이 기록 삭제', () => { Mutations.setEventMembers(selDate, content, []); DB.commit(); toast('기록 삭제'); renderParticipation(); }, { kind: 'ghost-danger' })
      : null,
    btn('✓ 참여 기록', () => {
      const ids = new Set(Mutations.getEvent(selDate, content)); // keep existing, merge
      for (const mm of picked.values()) if (mm.checked) ids.add(mm.member.id);
      for (const [, id] of manual) if (id) ids.add(+id);
      manualPick.querySelectorAll('input[type=checkbox]').forEach((cb) => {
        const id = +cb.dataset.mid; if (cb.checked) ids.add(id); else ids.delete(id);
      });
      Mutations.setEventMembers(selDate, content, [...ids]);
      DB.commit();
      toast(`${content}: ${ids.size}명 기록 완료`);
      selContent = null; renderParticipation();
    }, { kind: 'primary' }),
  ]);

  // paste support while panel open
  const onPaste = (e) => { const it = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/')); if (it) pick(it.getAsFile()); };
  document.addEventListener('paste', onPaste);
  setTimeout(() => { // detach when panel leaves DOM
    const obs = new MutationObserver(() => { if (!document.body.contains(wrap)) { document.removeEventListener('paste', onPaste); obs.disconnect(); } });
    obs.observe(document.getElementById('app'), { childList: true, subtree: true });
  }, 0);

  wrap.append(drop, fileInput, previewWrap, controls, progress, ocrResult, manualPick, actions);
  return wrap;
}

// ── score settlement panel ───────────────────────────────────────────
function renderScorePanel() {
  const s = DB.state;
  const dates = Mutations.datesWithData();
  const defFrom = s.participation.scoreFrom || dates[0] || todayISO();
  const defTo = s.participation.scoreTo || dates[dates.length - 1] || todayISO();
  const from = el('input.input', { type: 'date', value: defFrom });
  const to = el('input.input', { type: 'date', value: defTo });
  const out = el('div');

  const compute = () => {
    const range = { from: from.value, to: to.value };
    const scores = computeScores(s.participation.byDate, s.contentCatalog, s.members, range);
    const rows = s.members.map((m) => ({ m, sc: scores[m.id] || 0 })).sort((a, b) => b.sc - a.sc);
    clear(out);
    const tbl = el('table.tbl');
    tbl.appendChild(el('thead', {}, el('tr', {}, ['#', '닉네임', '직업', '기간 참여점수', '예상 티어'].map((h) => el('th', { text: h })))));
    const tb = el('tbody');
    rows.forEach((r, i) => tb.appendChild(el('tr', {}, [
      el('td', { text: i + 1 }), el('td', {}, [el('b', { text: r.m.name })]),
      el('td', {}, [classBadge(r.m.cls)]), el('td', { style: { textAlign: 'right' }, text: fmt(r.sc) }),
      el('td', { style: { textAlign: 'center' } }, [tierBadge(tierForScore(r.sc, s.tiers))]),
    ])));
    tbl.appendChild(tb);
    out.appendChild(el('div.table-wrap', {}, [tbl]));
  };
  compute();

  return card('참여점수 산정', el('div', {}, [
    el('p.hint', { text: '선택한 기간의 참여 기록을 합산해 참여점수를 계산합니다. “명단 반영”을 누르면 각 클랜원의 참여점수가 갱신되어 다이아 정산에 반영됩니다.' }),
    el('div.toolbar', {}, [
      el('label.field-inline', {}, [el('span', { text: '시작' }), from]),
      el('label.field-inline', {}, [el('span', { text: '종료' }), to]),
      btn('계산', compute, { kind: 'ghost' }),
      btn('명단에 반영', () => {
        const range = { from: from.value, to: to.value };
        const scores = computeScores(s.participation.byDate, s.contentCatalog, s.members, range);
        s.members.forEach((m) => { m.score = scores[m.id] || 0; });
        s.participation.scoreFrom = from.value; s.participation.scoreTo = to.value;
        DB.commit(); toast('참여점수를 명단에 반영했습니다'); location.hash = '#/diamond';
      }, { kind: 'primary' }),
    ]),
    out,
  ]));
}
