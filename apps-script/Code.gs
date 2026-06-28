/**
 * 불면증 클랜 관리 — Apps Script 백엔드 (Web App) · 양방향 동기화 + 소프트 락
 *
 * 저장 구조:
 *   • _state (A1)  : 전체 상태 JSON (권위 저장소). 시트에 없는 깊은 데이터(스킬/장비/참여/정산 등)는 여기에만.
 *   • 편집 탭들     : 명단·분배내역·콘텐츠·티어컷·운영진·고투·설정·분배기준
 *                    → 시트에서 직접 편집 가능. getAll 때 읽어서 _state 위에 덮어(병합) 반환.
 *   • _locks       : 소프트 락(페이지 편집 중 표시). page|who|ts.
 *
 * 동작:
 *   save  : _state 저장 + 편집 탭 재생성(대시보드 변경 → 시트 반영)
 *   getAll: _state 로드 + 편집 탭 병합(시트 변경 → 대시보드 반영). 충돌은 last-write-wins.
 *
 * 스크립트 속성: GATE_PASSWORD(= 대시보드 비번, 쓰기 인증). NAVER_OCR_URL/SECRET(선택).
 * 배포: 새 배포 ▸ 웹 앱 ▸ 실행: 나, 액세스: 모든 사용자 ▸ URL 을 config.js APPS_SCRIPT_URL 에.
 */

var STATE_SHEET = '_state';
var LOCK_SHEET = '_locks';
var LOCK_TTL_MS = 40 * 1000;   // 락 자동 만료(하트비트 없으면 해제)
var P = PropertiesService.getScriptProperties();

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';
  try {
    if (action === 'ping') return json({ data: { ok: true, ts: Date.now() } });
    if (action === 'getAll') return json({ data: loadState() });
    if (action === 'getLocks') return json({ data: activeLocks() });
    return json({ error: 'unknown action: ' + action });
  } catch (err) { return json({ error: String(err) }); }
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (_) {}
  try {
    if (!checkToken(body.token)) return json({ error: 'unauthorized' });
    var action = body.action;
    if (action === 'save') { saveState(body.data); return json({ data: { ok: true } }); }
    if (action === 'lock') { return json({ data: setLock(body.page, body.who) }); }
    if (action === 'unlock') { return json({ data: clearLock(body.page, body.who) }); }
    if (action === 'ocr') { return json({ data: { lines: naverOcr(body.image) } }); }
    return json({ error: 'unknown action: ' + action });
  } catch (err) { return json({ error: String(err) }); }
}

/* ── auth ─────────────────────────────────────────────────────────── */
function checkToken(token) {
  var pw = P.getProperty('GATE_PASSWORD');
  if (!pw) return true;
  return token === pw;
}

/* ── state store + 양방향 병합 ───────────────────────────────────── */
function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

function loadState() {
  var sh = ss().getSheetByName(STATE_SHEET);
  if (!sh) return null;
  var raw = sh.getRange('A1').getValue();
  if (!raw) return null;
  var state;
  try { state = JSON.parse(raw); } catch (_) { return null; }
  try { mergeTabs(ss(), state); } catch (e) { /* 병합 실패 시 _state 그대로 */ }
  return state;
}

function saveState(state) {
  var book = ss();
  var sh = book.getSheetByName(STATE_SHEET) || book.insertSheet(STATE_SHEET);
  sh.getRange('A1').setValue(JSON.stringify(state));
  try { writeTabs(book, state); } catch (e) { /* 미러 실패 무시 */ }
}

/* 편집 탭 정의: [탭이름, 헤더[], 행생성(state)→rows, 병합(state, rows)] */
function num(v) { var n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; }
function truthyActive(v) { return !(v === '휴면' || v === false || v === 'FALSE' || v === 'x' || v === '' ); }

function readSheet(book, name) {
  var sh = book.getSheetByName(name);
  if (!sh) return null;
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];   // 헤더만 있거나 빈 경우 → 빈 배열(전부 삭제로 간주하지 않도록 호출부에서 처리)
  return vals.slice(1).filter(function (r) { return r.join('').trim() !== ''; });
}
function writeSheet(book, name, head, rows) {
  var sh = book.getSheetByName(name) || book.insertSheet(name);
  sh.clearContents();
  sh.getRange(1, 1, 1, head.length).setValues([head]);
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  sh.setFrozenRows(1);
}

function writeTabs(book, s) {
  writeSheet(book, '명단', ['id', '순번', '닉네임', '직업', '전투력', '참여점수', '등급', '활동', '메모'],
    (s.members || []).map(function (m) { return [m.id, m.order, m.name, m.cls, m.power, m.score, m.grade || '정회원', m.active === false ? '휴면' : '활동', m.note || '']; }));
  writeSheet(book, '분배내역', ['id', '날짜', '아이템', '구분', '받은 사람', '인계자', '내판가', '메모'],
    (s.distributionLog || []).map(function (d) { return [d.id, d.date, d.item, d.type, d.member, d.from || '', d.price || 0, d.note || '']; }));
  writeSheet(book, '콘텐츠', ['분류', '콘텐츠', '점수', '주간횟수', '활성'],
    (s.contentCatalog || []).map(function (c) { return [c.category, c.name, c.points, c.weekly, c.active ? 'O' : '']; }));
  writeSheet(book, '티어컷', ['티어', '최소점수', '배수'],
    (s.tiers || []).map(function (t) { return [t.tier, t.minScore, t.mult]; }));
  writeSheet(book, '운영진', ['닉네임', '비율(%)'],
    (s.staff || []).map(function (st) { return [st.name, (st.ratio * 100)]; }));
  writeSheet(book, '고투', ['순위', '비율(%)'],
    (s.powerRanks || []).map(function (r) { return [r.rank, (r.pct * 100)]; }));
  var sset = s.settings || {};
  writeSheet(book, '설정', ['항목', '값'], [
    ['총 다이아', sset.totalDiamonds || 0], ['운영진 비율(%)', (sset.staffRatio || 0) * 100],
    ['투력 비율(%)', (sset.powerRatio || 0) * 100], ['참여 비율(%)', (sset.participationRatio || 0) * 100]]);
  var rsh = book.getSheetByName('분배기준') || book.insertSheet('분배기준');
  rsh.clearContents(); rsh.getRange('A1').setValue(s.distributionRules || '');
  // 보유 현황(롱포맷: 닉네임·직업·스킬 1행씩) — 행 추가/삭제로 보유 관리
  writeSheet(book, '주문석보유', ['닉네임', '직업', '주문석'], ownRows(s, '주문석'));
  writeSheet(book, '엘릭서보유', ['닉네임', '직업', '엘릭서'], ownRows(s, '엘릭서'));
  // 상태 보드(성좌·탈것·플랫폼): 멤버×컬럼 매트릭스, 셀에 O = 보유/가능
  (s.statusBoards || []).forEach(function (b) {
    var cols = b.columns || [];
    var rows = (s.members || []).filter(function (m) { return m.active !== false; }).map(function (m) {
      var rec = (b.data || {})[m.id] || (b.data || {})[String(m.id)] || {};
      return [m.name].concat(cols.map(function (c) { return rec[c] ? 'O' : ''; }));
    });
    writeSheet(book, '보드-' + b.name, ['닉네임'].concat(cols), rows);
  });
}
function ownRows(s, cat) {
  var out = [];
  (s.members || []).forEach(function (m) {
    var o = (m.skills || {})[cat] || {};
    Object.keys(o).forEach(function (k) { if (o[k]) out.push([m.name, m.cls || '', k]); });
  });
  return out;
}
function memberByName(s) { var x = {}; (s.members || []).forEach(function (m) { x[String(m.name)] = m; }); return x; }

/* 시트 편집 → state 병합. 탭이 비어있으면(헤더만) 그 영역은 _state 유지(실수로 전체 삭제 방지). */
function mergeTabs(book, s) {
  // 명단: id로 기존 멤버 매칭(스킬/장비/순번 보존), 시트가 권위(추가·수정·삭제 반영)
  var mrows = readSheet(book, '명단');
  if (mrows && mrows.length) {
    var byId = {}; (s.members || []).forEach(function (m) { byId[String(m.id)] = m; });
    var maxId = (s.members || []).reduce(function (a, m) { return Math.max(a, +m.id || 0); }, 0);
    s.members = mrows.map(function (r) {
      var id = r[0]; var ex = byId[String(id)];
      if (!ex) { ex = { id: id || (++maxId), skills: {}, equip: {} }; }
      ex.order = num(r[1]); ex.name = String(r[2] || ''); ex.cls = String(r[3] || '');
      ex.power = num(r[4]); ex.score = num(r[5]); ex.grade = String(r[6] || '정회원');
      ex.active = truthyActive(r[7]); ex.note = String(r[8] || '');
      return ex;
    });
  }
  var drows = readSheet(book, '분배내역');
  if (drows && drows.length) s.distributionLog = drows.map(function (r) {
    return { id: r[0] || ('id' + Math.random().toString(36).slice(2)), date: String(r[1] || ''), item: String(r[2] || ''), type: String(r[3] || ''), member: String(r[4] || ''), from: String(r[5] || ''), price: num(r[6]), note: String(r[7] || '') };
  });
  var crows = readSheet(book, '콘텐츠');
  if (crows && crows.length) s.contentCatalog = crows.map(function (r) {
    return { category: String(r[0] || '기타'), name: String(r[1] || ''), points: num(r[2]), weekly: num(r[3]) || 1, active: truthyActive(r[4]) && num(r[2]) >= 0 };
  });
  var trows = readSheet(book, '티어컷');
  if (trows && trows.length) s.tiers = trows.map(function (r) { return { tier: String(r[0] || ''), minScore: num(r[1]), mult: num(r[2]) }; });
  var srows = readSheet(book, '운영진');
  if (srows && srows.length) s.staff = srows.map(function (r) { return { name: String(r[0] || ''), ratio: num(r[1]) / 100 }; });
  var grows = readSheet(book, '고투');
  if (grows && grows.length) s.powerRanks = grows.map(function (r) { return { rank: num(r[0]), pct: num(r[1]) / 100 }; });
  var setrows = readSheet(book, '설정');
  if (setrows && setrows.length) {
    s.settings = s.settings || {};
    setrows.forEach(function (r) {
      var k = String(r[0] || ''); var v = num(r[1]);
      if (k.indexOf('총') === 0) s.settings.totalDiamonds = v;
      else if (k.indexOf('운영진') === 0) s.settings.staffRatio = v / 100;
      else if (k.indexOf('투력') === 0) s.settings.powerRatio = v / 100;
      else if (k.indexOf('참여') === 0) s.settings.participationRatio = v / 100;
    });
  }
  var rsh = book.getSheetByName('분배기준');
  if (rsh) { var rv = rsh.getRange('A1').getValue(); if (rv) s.distributionRules = String(rv); }
  // 보유 현황 read-back(탭이 권위 → 닉네임으로 멤버 찾아 스킬 재구성)
  ['주문석', '엘릭서'].forEach(function (cat) {
    var rows = readSheet(book, cat === '주문석' ? '주문석보유' : '엘릭서보유');
    if (rows && rows.length) {
      var mb = memberByName(s);
      (s.members || []).forEach(function (m) { if (m.skills && m.skills[cat]) m.skills[cat] = {}; });
      rows.forEach(function (r) {
        var m = mb[String(r[0]).trim()]; var k = String(r[2]).trim();
        if (m && k) { m.skills = m.skills || {}; m.skills[cat] = m.skills[cat] || {}; m.skills[cat][k] = true; }
      });
    }
  });
  (s.statusBoards || []).forEach(function (b) {
    var rows = readSheet(book, '보드-' + b.name);
    if (rows && rows.length) {
      var mb = memberByName(s); var cols = b.columns || []; b.data = {};
      rows.forEach(function (r) {
        var m = mb[String(r[0]).trim()]; if (!m) return;
        var rec = {}; cols.forEach(function (c, ci) { if (String(r[ci + 1] || '').trim()) rec[c] = true; });
        if (Object.keys(rec).length) b.data[String(m.id)] = rec;
      });
    }
  });
}

/* ── 소프트 락(편집 중 표시) ─────────────────────────────────────── */
function lockSheet() { var b = ss(); return b.getSheetByName(LOCK_SHEET) || b.insertSheet(LOCK_SHEET); }
function activeLocks() {
  var sh = lockSheet(); var vals = sh.getDataRange().getValues(); var now = Date.now(); var out = [];
  vals.forEach(function (r) { if (r[0] && now - (+r[2] || 0) < LOCK_TTL_MS) out.push({ page: String(r[0]), who: String(r[1]), ts: +r[2] }); });
  return out;
}
function setLock(page, who) {
  var lock = LockService.getScriptLock(); lock.tryLock(5000);
  try {
    var sh = lockSheet(); var vals = sh.getDataRange().getValues(); var now = Date.now(); var keep = [];
    vals.forEach(function (r) {
      if (!r[0]) return;
      if (String(r[0]) === String(page) && String(r[1]) === String(who)) return;   // 내 기존 것 제거(갱신)
      if (now - (+r[2] || 0) < LOCK_TTL_MS) keep.push([r[0], r[1], r[2]]);          // 남의 유효 락 유지
    });
    keep.push([page, who, now]);
    sh.clearContents(); if (keep.length) sh.getRange(1, 1, keep.length, 3).setValues(keep);
    return keep.filter(function (r) { return now - (+r[2]) < LOCK_TTL_MS; }).map(function (r) { return { page: String(r[0]), who: String(r[1]), ts: +r[2] }; });
  } finally { lock.releaseLock(); }
}
function clearLock(page, who) {
  var lock = LockService.getScriptLock(); lock.tryLock(5000);
  try {
    var sh = lockSheet(); var vals = sh.getDataRange().getValues(); var now = Date.now(); var keep = [];
    vals.forEach(function (r) {
      if (!r[0]) return;
      if (String(r[0]) === String(page) && String(r[1]) === String(who)) return;
      if (now - (+r[2] || 0) < LOCK_TTL_MS) keep.push([r[0], r[1], r[2]]);
    });
    sh.clearContents(); if (keep.length) sh.getRange(1, 1, keep.length, 3).setValues(keep);
    return true;
  } finally { lock.releaseLock(); }
}

/* ── Naver CLOVA OCR proxy ────────────────────────────────────────── */
function naverOcr(base64) {
  var url = P.getProperty('NAVER_OCR_URL'); var secret = P.getProperty('NAVER_OCR_SECRET');
  if (!url || !secret) throw new Error('OCR not configured');
  var payload = { version: 'V2', requestId: Utilities.getUuid(), timestamp: Date.now(), images: [{ format: 'png', name: 'clan', data: base64 }] };
  var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', headers: { 'X-OCR-SECRET': secret }, payload: JSON.stringify(payload), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Naver OCR ' + res.getResponseCode());
  var data = JSON.parse(res.getContentText()); var lines = [];
  (data.images || []).forEach(function (img) { (img.fields || []).forEach(function (f) { if (f.inferText) lines.push(f.inferText); }); });
  return lines;
}

function json(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
