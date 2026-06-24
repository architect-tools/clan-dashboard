// participation.js — date-driven participation tracking.
// Flow: pick a date on the calendar → pick a content (buttons by category) →
// drop a screenshot (OCR) or pick members manually → confirm → recorded for that
// date+content. Scores are computed from the event log over a settlement period.
import { DB, Mutations } from '../db.js';
import { computeScores, tierForScore } from '../calc.js';
import { el, fmt, toast, clear } from '../util.js';
import { CATEGORY_ORDER } from '../config.js';
import { loadImage, extractLines, consensusMatch, buildAnchor, detectByAnchor } from '../ocr.js';
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
    // 1) OpenCV anchor auto-detect (handles different window size/position).
    //    Timeout-guarded so a slow/unavailable OpenCV never blocks the check-in.
    if (DB.state.ocrAnchor) {
      progress.textContent = '패널 자동 탐지 중…';
      try {
        const det = await Promise.race([
          detectByAnchor(curImg, DB.state.ocrAnchor, (p) => { progress.textContent = p.stage; }),
          new Promise((r) => setTimeout(() => r('timeout'), 15000)),
        ]);
        if (det === 'timeout') { progress.textContent = '자동 탐지 지연 — 기억된 영역으로 진행'; }
        else if (det && det.score >= 0.5) { crop = det; toast(`패널 자동 감지 (신뢰 ${Math.round(det.score * 100)}%)`); }
      } catch (e) { console.warn('auto-detect failed', e); }
    }
    // 2) fall back to remembered fractions
    if (!crop) crop = cropFromMemory();
    buildControls(); drawMemoryBox();
    runOcr();
  }
  function cropFromMemory() {
    const rc = DB.state.ocrCrop;
    if (!rc) return null;
    return { x: rc.x * curImg.naturalWidth, y: rc.y * curImg.naturalHeight, w: rc.w * curImg.naturalWidth, h: rc.h * curImg.naturalHeight };
  }

  // Drag to select the name area; OCR reads text wherever it is (no grid assumed)
  let selBox = null, dragging = null;
  function buildPreview() {
    clear(previewWrap); previewWrap.style.display = 'block';
    const dispW = Math.min(620, curImg.naturalWidth);
    imgEl = el('img.ocr-img', { src: curImg.src, style: { width: dispW + 'px' } });
    selBox = el('div.crop-box', { style: { display: 'none' } });
    const stage = el('div.crop-stage', {}, [imgEl, selBox]);
    previewWrap.appendChild(el('div.ocr-hint', {
      html: (DB.state.ocrAnchor || DB.state.ocrCrop)
        ? '✅ 패널 영역을 자동으로 잡았습니다(창 크기·위치 달라도 인식). 빗나가면 다시 드래그 후 “이 영역 기억”.'
        : '💡 명단 영역을 드래그한 뒤 “이 영역 기억”을 누르면, 이후 스크린샷에서 패널을 자동 감지합니다(OpenCV).' }));
    previewWrap.appendChild(stage);
    imgEl.onload = drawMemoryBox;
    buildControls();
    const ptr = (e) => { const r = imgEl.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, r }; };
    stage.onmousedown = (e) => { const p = ptr(e); dragging = { x0: p.x, y0: p.y }; };
    stage.onmousemove = (e) => {
      if (!dragging) return; const p = ptr(e);
      const x = Math.max(0, Math.min(dragging.x0, p.x)), y = Math.max(0, Math.min(dragging.y0, p.y));
      const w = Math.min(p.r.width, Math.abs(p.x - dragging.x0)), h = Math.min(p.r.height, Math.abs(p.y - dragging.y0));
      Object.assign(selBox.style, { display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      const sx = curImg.naturalWidth / p.r.width, sy = curImg.naturalHeight / p.r.height;
      if (w > 8 && h > 8) { crop = { x: x * sx, y: y * sy, w: w * sx, h: h * sy }; buildControls(); }
    };
    const end = () => { dragging = null; }; stage.onmouseup = end; stage.onmouseleave = end;
    drawMemoryBox();
  }
  function drawMemoryBox() { // show the (remembered) crop rect on the preview
    if (!selBox || !imgEl || !crop) return;
    const r = imgEl.getBoundingClientRect(); if (!r.width) return;
    const sx = r.width / curImg.naturalWidth, sy = r.height / curImg.naturalHeight;
    Object.assign(selBox.style, { display: 'block', left: crop.x * sx + 'px', top: crop.y * sy + 'px', width: crop.w * sx + 'px', height: crop.h * sy + 'px' });
  }

  function buildControls() {
    clear(controls); controls.style.display = 'flex';
    controls.appendChild(btn('🔍 선택영역 인식', () => runOcr(), { kind: 'primary' }));
    controls.appendChild(btn('전체 영역', () => { crop = null; if (selBox) selBox.style.display = 'none'; runOcr(); }, { kind: 'ghost' }));
    if (crop) controls.appendChild(btn('📌 이 영역 기억(자동감지)', () => {
      DB.state.ocrCrop = { x: crop.x / curImg.naturalWidth, y: crop.y / curImg.naturalHeight, w: crop.w / curImg.naturalWidth, h: crop.h / curImg.naturalHeight };
      try { DB.state.ocrAnchor = buildAnchor(curImg, crop); } catch (e) { console.warn(e); DB.state.ocrAnchor = null; }
      DB.commit(); toast('영역+앵커 기억 — 다음부터 패널 자동 감지');
    }, { kind: 'ghost' }));
    if (DB.state.ocrCrop || DB.state.ocrAnchor) controls.appendChild(btn('기억 해제', () => { DB.state.ocrCrop = null; DB.state.ocrAnchor = null; DB.commit(); toast('영역 기억을 해제했습니다'); }, { kind: 'ghost' }));
    controls.appendChild(btn('다른 스크린샷', () => fileInput.click(), { kind: 'ghost' }));
  }

  const picked = new Map(); // memberId -> {member, score, token, checked}
  const manual = new Map();
  async function runOcr() {
    if (!curImg) return;
    try {
      const out = await extractLines(curImg, crop, (p) => { progress.textContent = `${p.stage} (${Math.round(p.progress * 100)}%)`; });
      const { matched, maybe } = consensusMatch(out.perScale, roster);
      picked.clear();
      for (const mm of matched) picked.set(mm.member.id, { ...mm, checked: true });
      for (const mm of maybe) if (!picked.has(mm.member.id)) picked.set(mm.member.id, { ...mm, checked: false });
      progress.textContent = `인식 완료 — 신뢰 ${matched.length}명(자동 체크) · 확인필요 ${maybe.length}명. 못 찾은 인원은 아래 “명단에서 직접 선택”으로 추가하세요.`;
      renderResult([]);
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
