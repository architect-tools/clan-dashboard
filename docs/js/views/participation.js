// participation.js — weekly participation grid + OCR screenshot check-in.
// The flagship convenience feature: drop a screenshot, OCR reads nicknames,
// fuzzy-matches the roster, and ticks the chosen content for everyone found.
import { DB, Mutations } from '../db.js';
import { scoreFromAttendance, tierForScore, maxWeeklyScore } from '../calc.js';
import { el, fmt, toast, clear } from '../util.js';
import { CATEGORY_ORDER } from '../config.js';
import { imageToBase64, extractLines, matchRoster } from '../ocr.js';
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
  let target = contents[0].name;
  const contentSel = select(contents.map((c) => ({ value: c.name, label: `${c.category} · ${c.name}` })), target,
    { onchange: (e) => { target = e.target.value; } });

  modal('스크린샷으로 참여 체크인', (close) => {
    const drop = el('div.drop', {}, [
      el('div.drop-icon', { text: '📷' }),
      el('div', { text: '스크린샷을 끌어다 놓거나 클릭해서 선택' }),
      el('div.drop-sub', { text: '여러 장 가능 · 붙여넣기(Ctrl+V)도 지원' }),
    ]);
    const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' } });
    const result = el('div.ocr-result');
    const progress = el('div.ocr-progress');

    drop.onclick = () => fileInput.click();
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); handleFiles(e.dataTransfer.files); };
    fileInput.onchange = () => handleFiles(fileInput.files);
    const onPaste = (e) => {
      const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
      if (items.length) handleFiles(items.map((i) => i.getAsFile()));
    };
    document.addEventListener('paste', onPaste);

    async function handleFiles(files) {
      const roster = s.members.filter((m) => m.active !== false);
      const allMatched = new Map(); // memberId -> {member, score}
      const allUnmatched = [];
      clear(result);
      for (const f of [...files]) {
        if (!f || !f.type.startsWith('image/')) continue;
        progress.textContent = '이미지 처리 중…';
        const img = await imageToBase64(f);
        let engine = '';
        try {
          const out = await extractLines(img, (p) => { progress.textContent = `${p.stage} (${Math.round(p.progress * 100)}%)`; });
          engine = out.engine;
          const { matched, unmatched } = matchRoster(out.lines, roster);
          matched.forEach((mm) => { if (!allMatched.has(mm.member.id) || mm.score > allMatched.get(mm.member.id).score) allMatched.set(mm.member.id, mm); });
          unmatched.forEach((u) => allUnmatched.push(u));
        } catch (e) { console.error(e); toast('OCR 실패: ' + e.message, 'error'); }
        progress.textContent = `인식 완료 (엔진: ${engine || '-'})`;
      }
      renderMatches([...allMatched.values()], allUnmatched);
    }

    function renderMatches(matched, unmatched) {
      clear(result);
      if (!matched.length && !unmatched.length) { result.appendChild(el('div.empty', { text: '인식된 닉네임이 없습니다.' })); return; }
      const checks = new Map();
      result.appendChild(el('div.ocr-head', { text: `인식: ${matched.length}명 매칭 / 미매칭 ${unmatched.length}` }));
      const list = el('div.match-list');
      matched.forEach((mm) => {
        const cb = el('input', { type: 'checkbox', checked: true });
        checks.set(mm.member.id, cb);
        list.appendChild(el('label.match-row', { class: mm.score < 0.78 ? 'low' : '' }, [
          cb, el('b', { text: mm.member.name }),
          el('span.match-token', { text: `“${mm.token}”` }),
          el('span.match-score', { text: Math.round(mm.score * 100) + '%' }),
        ]));
      });
      // unmatched → manual assign
      const roster = s.members.filter((m) => m.active !== false);
      unmatched.slice(0, 30).forEach((tok) => {
        const sel = select([{ value: '', label: '— 무시 —' }, ...roster.map((m) => ({ value: m.id, label: m.name }))], '');
        list.appendChild(el('label.match-row.unmatched', {}, [
          el('span.match-token', { text: `“${tok}”` }), el('span', { text: '→' }), sel,
        ]));
        checks.set('manual:' + tok, sel);
      });
      result.appendChild(list);
      result.appendChild(el('div.modal-actions', {}, [
        btn('취소', close),
        btn(`체크인 적용 (${target})`, () => {
          let n = 0;
          for (const [key, ctrl] of checks) {
            if (typeof key === 'number' && ctrl.checked) { Mutations.bumpAttendance(key, target, +1, week.id); n++; }
            else if (typeof key === 'string' && key.startsWith('manual:') && ctrl.value) { Mutations.bumpAttendance(+ctrl.value, target, +1, week.id); n++; }
          }
          DB.commit();
          document.removeEventListener('paste', onPaste);
          toast(`${target}: ${n}명 체크인 완료`);
          close(); renderParticipation();
        }, { kind: 'primary' }),
      ]));
    }

    return el('div', {}, [
      el('div.field', {}, [el('span.field-label', { text: '체크인할 콘텐츠' }), contentSel]),
      drop, fileInput, progress, result,
    ]);
  }, { wide: true, onClose: () => {} });
}
