// participation.js — weekly participation grid + OCR screenshot check-in.
// The flagship convenience feature: drop a screenshot, OCR reads nicknames,
// fuzzy-matches the roster, and ticks the chosen content for everyone found.
import { DB, Mutations } from '../db.js';
import { scoreFromAttendance, tierForScore, maxWeeklyScore } from '../calc.js';
import { el, fmt, toast, clear } from '../util.js';
import { CATEGORY_ORDER } from '../config.js';
import { loadImage, extractLines, matchRoster } from '../ocr.js';
import { page, card, btn, modal, select, tierBadge } from './ui.js';

let showInactive = false;

function activeContents() {
  return DB.state.contentCatalog.filter((c) => showInactive || c.active);
}
function groupByCategory(list) {
  const g = {};
  for (const c of list) (g[c.category] ||= []).push(c);
  const cats = [...new Set(list.map((c) => c.category))]
    .sort((a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99));
  return cats.map((cat) => ({ cat, items: g[cat] }));
}

export function renderParticipation() {
  const s = DB.state;
  const part = s.participation;
  const week = part.weeks.find((w) => w.id === part.current) || part.weeks[0];
  const wd = part.data[week.id] || {};
  const members = s.members.filter((m) => m.active !== false);
  const contents = activeContents();
  const maxScore = maxWeeklyScore(s.contentCatalog);

  const weekSel = select(part.weeks.map((w) => ({ value: w.id, label: w.label })), week.id,
    { onchange: (e) => { part.current = e.target.value; DB.commit(); renderParticipation(); } });

  const body = page('주간 참여도', {
    subtitle: `${week.label} · 콘텐츠 참여 체크 → 참여점수 자동 산정 (주간 만점 ${fmt(maxScore)})`,
    actions: [
      btn('📷 스크린샷 체크인', () => openOcrCheckin(), { kind: 'primary' }),
      btn('+ 새 주차', () => { const id = Mutations.addWeek('새 주차 ' + (part.weeks.length + 1)); DB.commit(); renderParticipation(); }),
    ],
  });

  body.appendChild(el('div.toolbar', {}, [
    el('label.field-inline', {}, [el('span', { text: '주차' }), weekSel]),
    el('label.field-inline', {}, [
      el('input', { type: 'checkbox', checked: showInactive, onchange: (e) => { showInactive = e.target.checked; renderParticipation(); } }),
      el('span', { text: '비활성 콘텐츠 포함' }),
    ]),
    btn('참여점수 → 명단 반영', () => applyScores(week.id), { kind: 'ghost', title: '계산된 주간 점수를 각 클랜원의 참여점수로 복사' }),
  ]));

  // ── grid: members × contents, grouped by category ──
  const groups = groupByCategory(contents);
  const tbl = el('table.tbl.grid-tbl');
  // header row 1: category spans
  const h1 = el('tr', {}, [el('th.sticky-col.gh', { rowspan: 2, text: '닉네임' })]);
  groups.forEach((g) => h1.appendChild(el('th.cat-h', { colspan: g.items.length, text: g.cat })));
  h1.appendChild(el('th.gh', { rowspan: 2, text: '주간점수', style: { textAlign: 'right' } }));
  h1.appendChild(el('th.gh', { rowspan: 2, text: '티어' }));
  // header row 2: content names
  const h2 = el('tr');
  groups.forEach((g) => g.items.forEach((c) =>
    h2.appendChild(el('th.cnt-h', { title: `${c.name} · ${c.points}점 · 주${c.weekly}회`, text: c.name }))));
  tbl.appendChild(el('thead', {}, [h1, h2]));

  const tb = el('tbody');
  members.forEach((m) => {
    const att = wd[m.id] || {};
    const sc = scoreFromAttendance(att, s.contentCatalog);
    const tr = el('tr');
    tr.appendChild(el('td.sticky-col', {}, [el('b', { text: m.name })]));
    groups.forEach((g) => g.items.forEach((c) => {
      const n = att[c.name] || 0;
      const cell = el('td.cell', {
        class: n > 0 ? 'hit' : '', title: `${m.name} · ${c.name} (좌클릭 +1 / 우클릭 -1, 최대 ${c.weekly})`,
        onclick: () => { const v = Mutations.bumpAttendance(m.id, c.name, +1, week.id); if (v > c.weekly) Mutations.setAttendance(m.id, c.name, c.weekly, week.id); DB.commit(); renderParticipation(); },
        oncontextmenu: (e) => { e.preventDefault(); Mutations.bumpAttendance(m.id, c.name, -1, week.id); DB.commit(); renderParticipation(); },
      }, [n > 0 ? (c.weekly > 1 ? String(n) : '✓') : '']);
      tr.appendChild(cell);
    }));
    tr.appendChild(el('td', { style: { textAlign: 'right' }, text: fmt(sc) }));
    tr.appendChild(el('td', { style: { textAlign: 'center' } }, [tierBadge(tierForScore(sc, s.tiers))]));
    tb.appendChild(tr);
  });
  tbl.appendChild(tb);

  body.appendChild(card(null, el('div.grid-scroll', {}, [tbl]), { className: 'card-flush' }));
}

/** Copy computed weekly scores into each member's stored 참여점수. */
function applyScores(weekId) {
  const wd = DB.state.participation.data[weekId] || {};
  let n = 0;
  for (const m of DB.state.members) {
    const sc = scoreFromAttendance(wd[m.id] || {}, DB.state.contentCatalog);
    if ((wd[m.id] && Object.keys(wd[m.id]).length) || sc) { m.score = sc; n++; }
  }
  DB.commit();
  toast(`${n}명의 참여점수를 명단에 반영했습니다`);
  renderParticipation();
}

// ── OCR check-in flow ───────────────────────────────────────────────
function openOcrCheckin() {
  const s = DB.state;
  const contents = activeContents();
  if (!contents.length) return toast('먼저 콘텐츠를 설정하세요', 'error');
  const week = s.participation.weeks.find((w) => w.id === s.participation.current);
  const roster = s.members.filter((m) => m.active !== false);
  let target = contents[0].name;

  // accumulated across multiple screenshots within one session
  const picked = new Map();          // memberId -> { member, score, token, checked }
  const unmatchedSet = new Set();    // leftover OCR tokens for manual assignment
  let curImg = null, crop = null;    // current image + crop (natural px)

  const contentSel = select(contents.map((c) => ({ value: c.name, label: `${c.category} · ${c.name}` })), target,
    { onchange: (e) => { target = e.target.value; applyBtn.textContent = `체크인 적용 (${target})`; } });

  modal('스크린샷으로 참여 체크인', (close) => {
    const drop = el('div.drop', {}, [
      el('div.drop-icon', { text: '📷' }),
      el('div', { text: '클랜 부대/참여자 스크린샷을 끌어다 놓거나 클릭해서 선택' }),
      el('div.drop-sub', { text: '붙여넣기(Ctrl+V)도 지원 · 여러 장 순서대로 인식 가능' }),
    ]);
    const fileInput = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    const previewWrap = el('div.ocr-preview', { style: { display: 'none' } });
    const progress = el('div.ocr-progress');
    const result = el('div.ocr-result');

    const runBtn = btn('🔍 인식 시작', () => runOcr(), { kind: 'primary' });
    const fullBtn = btn('전체 영역', () => { crop = null; drawSel(); }, { kind: 'ghost' });
    const moreBtn = btn('다른 스크린샷', () => fileInput.click(), { kind: 'ghost' });
    const controls = el('div.ocr-controls', { style: { display: 'none' } }, [runBtn, fullBtn, moreBtn]);
    const applyBtn = btn(`체크인 적용 (${target})`, () => applyCheckin(), { kind: 'primary' });

    drop.onclick = () => fileInput.click();
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files[0]); };
    fileInput.onchange = () => pick(fileInput.files[0]);
    const onPaste = (e) => {
      const it = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
      if (it) pick(it.getAsFile());
    };
    document.addEventListener('paste', onPaste);
    const cleanup = () => document.removeEventListener('paste', onPaste);

    // ── load + preview with draggable crop box ──
    async function pick(file) {
      if (!file || !file.type.startsWith('image/')) return;
      try { curImg = await loadImage(file); } catch { return toast('이미지를 열 수 없습니다', 'error'); }
      crop = null;
      drop.style.display = 'none';
      controls.style.display = 'flex';
      buildPreview();
    }

    let selBox = null, dragging = null;
    function buildPreview() {
      clear(previewWrap); previewWrap.style.display = 'block';
      const dispW = Math.min(560, curImg.naturalWidth);
      const img = el('img.ocr-img', { src: curImg.src, style: { width: dispW + 'px' } });
      selBox = el('div.crop-box', { style: { display: 'none' } });
      const stage = el('div.crop-stage', {}, [img, selBox]);
      previewWrap.appendChild(el('div.ocr-hint', { text: '이름이 있는 영역을 드래그하면 인식률이 올라갑니다 (선택). “전체 영역”으로 초기화.' }));
      previewWrap.appendChild(stage);

      const ptr = (e) => { const r = img.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, r }; };
      stage.onmousedown = (e) => { const p = ptr(e); dragging = { x0: p.x, y0: p.y }; };
      stage.onmousemove = (e) => {
        if (!dragging) return;
        const p = ptr(e);
        const x = Math.max(0, Math.min(dragging.x0, p.x)), y = Math.max(0, Math.min(dragging.y0, p.y));
        const w = Math.min(p.r.width, Math.abs(p.x - dragging.x0)), h = Math.min(p.r.height, Math.abs(p.y - dragging.y0));
        Object.assign(selBox.style, { display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
        const sx = curImg.naturalWidth / p.r.width, sy = curImg.naturalHeight / p.r.height;
        if (w > 8 && h > 8) crop = { x: x * sx, y: y * sy, w: w * sx, h: h * sy };
      };
      const end = () => { dragging = null; };
      stage.onmouseup = end; stage.onmouseleave = end;
      drawSel();
    }
    function drawSel() { if (selBox) selBox.style.display = crop ? 'block' : 'none'; }

    // ── run OCR on current image/crop, merge into picked ──
    async function runOcr() {
      if (!curImg) return;
      runBtn.disabled = true;
      try {
        const out = await extractLines(curImg, crop, (p) => { progress.textContent = `${p.stage} (${Math.round(p.progress * 100)}%)`; });
        const { matched, maybe, unmatched } = matchRoster(out.lines, roster);
        for (const m of matched) mergePick(m, true);
        for (const m of maybe) mergePick(m, false);
        unmatched.forEach((u) => unmatchedSet.add(u));
        progress.textContent = `인식 완료 — 신뢰 ${matched.length} · 확인필요 ${maybe.length} (엔진: ${out.engine})`;
        renderReview();
      } catch (e) { console.error(e); toast('OCR 실패: ' + e.message, 'error'); progress.textContent = ''; }
      runBtn.disabled = false;
    }
    function mergePick(m, checked) {
      const prev = picked.get(m.member.id);
      if (!prev || m.score > prev.score) picked.set(m.member.id, { ...m, checked: prev ? prev.checked : checked });
    }

    function renderReview() {
      clear(result);
      const items = [...picked.values()].sort((a, b) => b.score - a.score);
      const leftovers = [...unmatchedSet];
      if (!items.length && !leftovers.length) { result.appendChild(el('div.empty', { text: '인식된 닉네임이 없습니다. 영역을 좁혀 다시 시도해 보세요.' })); return; }
      const checkedN = items.filter((i) => i.checked).length;
      result.appendChild(el('div.ocr-head', { text: `선택 ${checkedN}명 / 인식 ${items.length}명 · 미매칭 ${leftovers.length}` }));
      const list = el('div.match-list');
      items.forEach((mm) => {
        const cb = el('input', { type: 'checkbox', checked: mm.checked, onchange: (e) => { mm.checked = e.target.checked; } });
        list.appendChild(el('label.match-row', { class: mm.score < 0.72 ? 'low' : '' }, [
          cb, el('b', { text: mm.member.name }),
          el('span.match-token', { text: `“${mm.token}”` }),
          el('span.match-score', { text: Math.round(mm.score * 100) + '%' }),
        ]));
      });
      leftovers.slice(0, 40).forEach((tok) => {
        const sel = select([{ value: '', label: '— 무시 —' }, ...roster.map((m) => ({ value: m.id, label: m.name }))], '',
          { onchange: (e) => { manual.set(tok, e.target.value); } });
        list.appendChild(el('label.match-row.unmatched', {}, [
          el('span.match-token', { text: `“${tok}”` }), el('span', { text: '→' }), sel,
        ]));
      });
      result.appendChild(list);
    }
    const manual = new Map(); // token -> memberId (manual assignments)

    function applyCheckin() {
      let n = 0;
      for (const mm of picked.values()) if (mm.checked) { Mutations.bumpAttendance(mm.member.id, target, +1, week.id); n++; }
      for (const [, id] of manual) if (id) { Mutations.bumpAttendance(+id, target, +1, week.id); n++; }
      DB.commit(); cleanup();
      toast(`${target}: ${n}명 체크인 완료`);
      close(); renderParticipation();
    }

    return el('div', {}, [
      el('div.field', {}, [el('span.field-label', { text: '체크인할 콘텐츠' }), contentSel]),
      drop, fileInput, previewWrap, controls, progress, result,
      el('div.modal-actions', {}, [btn('취소', () => { cleanup(); close(); }), applyBtn]),
    ]);
  }, { wide: true });
}
