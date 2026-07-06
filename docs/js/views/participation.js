// participation.js — date-driven participation tracking.
// Flow: pick a date on the calendar → pick a content (buttons by category) →
// drop a screenshot (OCR) or pick members manually → confirm → recorded for that
// date+content. Scores are computed from the event log over a settlement period.
import { DB, Mutations } from '../db.js';
import { Roles } from '../roles.js';
import { computeScores, tierForScore } from '../calc.js';
import { el, fmt, toast, clear } from '../util.js';
import { CATEGORY_ORDER } from '../config.js';
import { loadImage, extractLines, consensusMatch, CHECK_AT } from '../ocr.js';
import { page, card, btn, modal, busyOverlay, tierBadge, classBadge, comboSelect } from './ui.js';

const todayISO = () => new Date().toISOString().slice(0, 10);
let selDate = todayISO();
let selContent = null;
let viewMonth = null; // {y, m} 0-based month

function categoryRank(cat) {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i >= 0 ? i : 99;
}

function groupNumber(name) {
  const m = String(name || '').match(/^(\d+)\s*그룹/);
  return m ? +m[1] : null;
}

function contentCompare(a, b) {
  const ca = typeof a === 'string' ? DB.state.contentCatalog.find((c) => c.name === a) : a;
  const cb = typeof b === 'string' ? DB.state.contentCatalog.find((c) => c.name === b) : b;
  const catA = ca?.category || '';
  const catB = cb?.category || '';
  const catDiff = categoryRank(catA) - categoryRank(catB);
  if (catDiff) return catDiff;
  const nameA = ca?.name || String(a || '');
  const nameB = cb?.name || String(b || '');
  const ga = groupNumber(nameA);
  const gb = groupNumber(nameB);
  if (catA === '필드 보스' && ga != null && gb != null && ga !== gb) return ga - gb;
  return nameA.localeCompare(nameB, 'ko', { numeric: true });
}

function catGroups(catalog, includeInactive = false) {
  const list = catalog.filter((c) => includeInactive || c.active);
  const g = {};
  for (const c of list) (g[c.category] ||= []).push(c);
  return [...new Set(list.map((c) => c.category))]
    .sort((a, b) => categoryRank(a) - categoryRank(b))
    .map((cat) => ({ cat, items: [...g[cat]].sort(contentCompare) }));
}

export function renderParticipation() {
  const s = DB.state;
  if (!viewMonth) { const d = new Date(selDate); viewMonth = { y: d.getFullYear(), m: d.getMonth() }; }

  const body = page('참여 기록', {
    subtitle: '날짜 선택 → 콘텐츠 선택 → 스크린샷으로 참여자 자동 기록',
    actions: [btn('참여점수 집계', () => openScorePanel(), { kind: 'primary', admin: true })],
  });

  // two-column: calendar (left) + day detail (right)
  const calCol = el('div.part-cal');
  const dayCol = el('div.part-day');
  body.appendChild(el('div.part-layout', {}, [calCol, dayCol]));

  renderCalendar(calCol);
  renderDay(dayCol);
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
  const byId = Object.fromEntries(s.members.map((m) => [m.id, m]));
  const contents = Object.keys(day).filter((cn) => (day[cn] || []).length);
  if (!contents.length) return el('div.empty', { text: '위에서 콘텐츠를 선택해 참여자를 기록하세요.' });
  // arrange recorded contents as slots, ordered by catalog category then content order
  contents.sort(contentCompare);

  const grid = el('div.slot-grid');
  contents.forEach((cn) => {
    const ids = day[cn];
    const c = s.contentCatalog.find((x) => x.name === cn);
    const preview = ids.slice(0, 3).map((id) => byId[id]?.name || '?').join(', ') + (ids.length > 3 ? ` 외 ${ids.length - 3}명` : '');
    grid.appendChild(el('div.day-slot', {
      onclick: () => openSlot(cn, ids, byId),
      title: `${cn} — 참여자 ${ids.length}명 (클릭해서 보기)`,
    }, [
      c ? el('span.slot-cat', { text: c.category }) : null,
      el('div.slot-name', { text: cn }),
      el('div.slot-count', {}, [el('b', { text: ids.length }), '명']),
      el('div.slot-preview', { text: preview }),
    ]));
  });
  return el('div', {}, [
    el('div.slot-hint', { text: '슬롯을 클릭하면 참여자 전체가 보입니다.' }),
    grid,
  ]);
}

// popup the full participant list for a content slot (+ jump to edit)
function openSlot(cn, ids, byId) {
  const c = DB.state.contentCatalog.find((x) => x.name === cn);
  modal(`${cn} · 참여자 ${ids.length}명`, (close) => el('div', {}, [
    c ? el('div.muted', { text: `${c.points}점 · ${c.category}` }) : null,
    el('div.chips', { style: { marginTop: '10px' } }, ids.map((id) => el('span.chip', { text: byId[id]?.name || '?' }))),
    el('div.modal-actions', {}, [
      btn('닫기', close),
      Roles.isAdmin() ? btn('편집', () => { close(); selContent = cn; renderParticipation(); }, { kind: 'primary' }) : null,
    ]),
  ]));
}

// ── check-in panel for a chosen content ──────────────────────────────
function checkinPanel(content) {
  const s = DB.state;
  const roster = s.members.filter((m) => m.active !== false);
  const cat = s.contentCatalog.find((c) => c.name === content);
  // 멤버: 기록 편집 불가 — 현재 참여자만 읽기 전용으로 표시
  if (!Roles.isAdmin()) {
    const ids = Mutations.getEvent(selDate, content);
    const byId = Object.fromEntries(s.members.map((m) => [m.id, m]));
    return el('div.checkin', {}, [
      el('div.checkin-head', {}, [el('b', { text: `${content} 참여자 ${ids.length}명` }), cat ? el('span.muted', { text: `${cat.points}점 · ${cat.category}` }) : null]),
      ids.length ? el('div.chips', { style: { marginTop: '10px' } }, ids.map((id) => el('span.chip', { text: byId[id]?.name || '?' }))) : el('div.empty.small', { text: '아직 기록이 없습니다.' }),
      el('div.checkin-actions', {}, [btn('닫기', () => { selContent = null; renderParticipation(); }, { kind: 'ghost' })]),
    ]);
  }
  const current = new Set(Mutations.getEvent(selDate, content)); // memberIds already recorded
  let curImg = null, crop = null, imgEl = null;
  const selectedBadge = el('span.cbadge', { text: '선택 0명' });

  const wrap = el('div.checkin');
  wrap.appendChild(el('div.checkin-head', {}, [
    el('b', { text: `${content} 참여 기록` }),
    cat ? el('span.muted', { text: `${cat.points}점 · ${cat.category}` }) : null,
    selectedBadge,
  ]));

  const drop = el('div.drop', {}, [
    el('div.drop-icon', { text: '' }),
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
    // reset any prior recognition (so replacing the screenshot always starts clean).
    // selected 도 기존 기록(current) 기준으로 되돌려 이전 인식의 잔여 체크가 누적되지 않게.
    crop = null; resetRecognitionState();
    drop.style.display = 'none'; buildPreview();
    // apply the remembered region (resolution-independent fractions) — cheap, no
    // OpenCV. Panel auto-detect is OPT-IN via a button: it loads a ~10MB WASM and
    // runs synchronous template matching that would otherwise freeze the page on
    // every drop. Recognition itself runs only when the user presses [인식].
    crop = cropFromMemory();
    buildControls(); drawMemoryBox(); setReadyHint();
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
      html: DB.state.ocrCrop
        ? '기억된 영역을 적용했습니다. 화면 구성이 다르면 다시 드래그하세요.'
        : '인식할 명단 영역을 드래그하세요. “이 영역 기억”을 누르면 다음 스크린샷에 자동 적용됩니다.' }));
    previewWrap.appendChild(stage);
    imgEl.draggable = false; // stop the browser's native image-drag from hijacking region selection
    // replace the screenshot by dropping an EXTERNAL image file onto the preview
    // (gated to file drags so it never fires during in-image region dragging)
    const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    previewWrap.ondragover = (e) => { if (!isFileDrag(e)) return; e.preventDefault(); stage.classList.add('replace-over'); };
    previewWrap.ondragleave = () => stage.classList.remove('replace-over');
    previewWrap.ondrop = (e) => { stage.classList.remove('replace-over'); if (e.dataTransfer.files[0]) { e.preventDefault(); pick(e.dataTransfer.files[0]); } };
    imgEl.onload = drawMemoryBox;
    buildControls();
    // drag on the image to select the name region. Tracked on window (not the
    // stage) so a fast drag that leaves the image keeps selecting smoothly.
    const ptr = (e) => { const r = imgEl.getBoundingClientRect(); return { x: Math.max(0, Math.min(r.width, e.clientX - r.left)), y: Math.max(0, Math.min(r.height, e.clientY - r.top)), r }; };
    stage.onmousedown = (e) => {
      e.preventDefault(); const s0 = ptr(e); dragging = { x0: s0.x, y0: s0.y };
      const move = (ev) => {
        const p = ptr(ev);
        const x = Math.min(dragging.x0, p.x), y = Math.min(dragging.y0, p.y);
        const w = Math.abs(p.x - dragging.x0), h = Math.abs(p.y - dragging.y0);
        Object.assign(selBox.style, { display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
        const sx = curImg.naturalWidth / p.r.width, sy = curImg.naturalHeight / p.r.height;
        if (w > 8 && h > 8) crop = { x: x * sx, y: y * sy, w: w * sx, h: h * sy };
      };
      const up = () => { dragging = null; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); buildControls(); setReadyHint(); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    };
    drawMemoryBox();
  }
  function drawMemoryBox() { // show the (remembered) crop rect on the preview
    if (!selBox || !imgEl || !crop) return;
    const r = imgEl.getBoundingClientRect(); if (!r.width) return;
    const sx = r.width / curImg.naturalWidth, sy = r.height / curImg.naturalHeight;
    Object.assign(selBox.style, { display: 'block', left: crop.x * sx + 'px', top: crop.y * sy + 'px', width: crop.w * sx + 'px', height: crop.h * sy + 'px' });
  }
  // tell the user recognition is a deliberate step (no auto-run on upload)
  function setReadyHint() {
    progress.innerHTML = crop
      ? '인식 영역이 지정됐습니다(드래그로 조정 가능). <b>[인식]</b>을 누르세요.'
      : '인식할 <b>명단 영역을 드래그</b>로 지정한 뒤 <b>[인식]</b>을 누르세요. (영역을 안 잡으면 전체 이미지로 인식)';
  }

  function buildControls() {
    clear(controls); controls.style.display = 'flex';
    // single recognize button — uses the current region: your drag if you made
    // one, else the remembered/auto-detected area, else the whole image.
    controls.appendChild(btn('인식', () => runOcr(), { kind: 'primary' }));
    controls.appendChild(el('span.ocr-ctrl-sep'));
    controls.appendChild(btn('다른 스크린샷', () => fileInput.click()));
    // NOTE: OpenCV 패널 자동감지는 제거됨 — 10MB WASM 로딩이 메인스레드를 막아 페이지가
    // 멈추고(응답 없음) 스피너가 무한 회전했음. 기억된 영역(비율)만 가볍게 적용.
    if (crop) controls.appendChild(btn('이 영역 기억', () => {
      DB.state.ocrCrop = { x: crop.x / curImg.naturalWidth, y: crop.y / curImg.naturalHeight, w: crop.w / curImg.naturalWidth, h: crop.h / curImg.naturalHeight };
      DB.state.ocrAnchor = null; // 더 이상 사용 안 함(스테일 앵커 정리)
      DB.commit(); buildControls(); toast('영역 기억 — 다음 스크린샷에 자동 적용');
    }));
    if (DB.state.ocrCrop || DB.state.ocrAnchor) controls.appendChild(btn('기억 해제', () => { DB.state.ocrCrop = null; DB.state.ocrAnchor = null; DB.commit(); buildControls(); toast('영역 기억을 해제했습니다'); }, { kind: 'ghost' }));
  }

  // 단일 선택 소스(selected): OCR 결과 목록과 '명단 직접선택' 목록이 "같은" 집합을
  // 보게 하여, 두 곳의 체크가 서로 다른 사람으로 어긋나던 버그를 없앤다. 이미 기록된
  // 인원(current)에서 시작. (이전엔 picked.checked ↔ manualPick DOM 이 단방향·재실행
  // 시 미초기화로 누적돼 어긋났음.)
  const selected = new Set(current);        // 기록될 최종 memberId 집합 = 단일 진실
  const picked = new Map();                 // OCR 인식결과 표시용: id -> {member, score, token}
  const manual = new Map();                 // 미매칭 토큰 드롭다운: token -> memberId
  let saveBtn = null;
  const toggle = (id, on) => { if (on) selected.add(id); else selected.delete(id); syncChecks(); };
  function resetRecognitionState() {
    picked.clear(); manual.clear(); clear(ocrResult);
    selected.clear(); current.forEach((id) => selected.add(id));
    syncChecks();
  }
  // 두 목록(OCR 결과 · 명단 직접선택)의 모든 체크박스를 selected 기준으로 일치시킴
  function syncChecks() {
    ocrResult.querySelectorAll('input[data-mid]').forEach((cb) => {
      const on = selected.has(+cb.dataset.mid); cb.checked = on; cb.closest('.match-row')?.classList.toggle('on', on);
    });
    manualPick.querySelectorAll('input[data-mid]').forEach((cb) => {
      const on = selected.has(+cb.dataset.mid); cb.checked = on; cb.closest('.pick-item')?.classList.toggle('on', on);
    });
    selectedBadge.textContent = `선택 ${selected.size}명`;
    if (saveBtn) saveBtn.textContent = `참여 기록 (${selected.size}명)`;
  }
  async function runOcr() {
    if (!curImg) return;
    resetRecognitionState();
    const busy = busyOverlay('참여자 인식 중…', 'OCR 엔진 준비 중');
    try {
      const out = await extractLines(curImg, crop, (p) => {
        const pct = Math.round(p.progress * 100);
        busy.update(p.stage, `${pct}%`);
        progress.textContent = `${p.stage} (${pct}%)`;
      });
      const { matched, maybe } = consensusMatch(out.perScale, roster);
      for (const mm of matched) { picked.set(mm.member.id, mm); selected.add(mm.member.id); } // 신뢰 → 자동 선택
      for (const mm of maybe) if (!picked.has(mm.member.id)) picked.set(mm.member.id, mm);      // 확인필요 → 표시만(선택 X)
      manualPick.open = true; // 동기화된 목록을 바로 펼쳐 보여줌
      progress.textContent = `인식 완료 — 신뢰 ${matched.length}명(자동 체크) · 확인필요 ${maybe.length}명. 못 찾은 인원은 아래 “명단에서 직접 선택”으로 추가하세요.`;
      renderResult([]);
      syncChecks(); // 두 목록의 체크를 selected 기준으로 일치
    } catch (e) { console.error(e); toast('OCR 실패: ' + e.message, 'error'); progress.textContent = ''; }
    finally { busy.close(); }
  }

  // manual roster picker (always available, even without screenshot)
  const rosterByName = [...roster].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ko'));
  const manualPick = el('details.manual-pick', {}, [
    el('summary', { text: '명단에서 직접 선택 / 추가' }),
    el('div.pick-grid', {}, rosterByName.map((m) => {
      const on = current.has(m.id);
      return el('label.pick-item', { class: on ? 'on' : '' }, [
        el('input', { type: 'checkbox', checked: on, dataset: { mid: m.id }, onchange: (e) => toggle(m.id, e.target.checked) }),
        el('span', { text: m.name + (Roles.isMe(m.name) ? ' (나)' : '') }),
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
        const on = selected.has(mm.member.id);
        const cb = el('input', { type: 'checkbox', checked: on, dataset: { mid: mm.member.id }, onchange: (e) => toggle(mm.member.id, e.target.checked) });
        list.appendChild(el('label.match-row', { class: (mm.score < CHECK_AT ? 'low' : '') + (on ? ' on' : '') }, [
          cb, el('b', { text: mm.member.name }), el('span.match-token', { text: `“${mm.token}”` }),
          el('span.match-score', { text: Math.round(mm.score * 100) + '%' }),
        ]));
      });
      unmatched.slice(0, 30).forEach((tok) => {
        const sel = comboSelect([{ value: '', label: '— 무시 —' }, ...roster.map((m) => ({ value: m.id, label: m.name }))], '', {
          placeholder: '닉네임 검색',
          onchange: (e) => { const prev = manual.get(tok); if (prev) selected.delete(prev); const id = +e.target.value || 0; manual.set(tok, id); if (id) selected.add(id); syncChecks(); },
        });
        list.appendChild(el('label.match-row.unmatched', {}, [el('span.match-token', { text: `“${tok}”` }), el('span', { text: '→' }), sel]));
      });
      ocrResult.appendChild(list);
    }
  }

  saveBtn = btn('참여 기록 (0명)', () => {
      // selected 가 단일 진실(기존 기록 + OCR 자동선택 + 수동 체크/해제 반영). 두 목록이
      // 같은 집합을 보므로 예전의 'added 가드 + DOM 스캔' 병합 로직이 필요 없다.
      Mutations.setEventMembers(selDate, content, [...selected]);
      DB.commit();
      toast(`${content}: ${selected.size}명 기록 완료`);
      selContent = null; renderParticipation();
    }, { kind: 'primary' });
  const actions = el('div.checkin-actions', {}, [
    btn('취소', () => { selContent = null; renderParticipation(); }, { kind: 'ghost' }),
    Mutations.getEvent(selDate, content).length
      ? btn('이 기록 삭제', () => { Mutations.setEventMembers(selDate, content, []); DB.commit(); toast('기록 삭제'); renderParticipation(); }, { kind: 'ghost-danger' })
      : null,
    saveBtn,
  ]);
  syncChecks();

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

// ── 참여점수 집계 (모달) ──────────────────────────────────────────────
function openScorePanel() {
  modal('참여점수 집계', (close) => scorePanelContent(close), { wide: true });
}
function scorePanelContent(close) {
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

  return el('div', {}, [
    el('p.hint', { text: '선택한 기간의 참여 기록을 합산해 참여점수를 계산합니다. “명단에 반영”을 누르면 각 클랜원의 참여점수가 갱신되어 다이아 정산에 반영됩니다.' }),
    el('div.toolbar', {}, [
      el('label.field-inline', {}, [el('span', { text: '시작' }), from]),
      el('label.field-inline', {}, [el('span', { text: '종료' }), to]),
      btn('계산', compute),
      btn('명단에 반영', () => {
        const range = { from: from.value, to: to.value };
        const scores = computeScores(s.participation.byDate, s.contentCatalog, s.members, range);
        s.members.forEach((m) => { m.score = scores[m.id] || 0; });
        s.participation.scoreFrom = from.value; s.participation.scoreTo = to.value;
        DB.commit(); toast('참여점수를 명단에 반영했습니다'); if (close) close(); location.hash = '#/diamond';
      }, { kind: 'primary' }),
    ]),
    out,
  ]);
}
