/**
 * 불면증 클랜 관리 — Apps Script 백엔드 (Web App) · 양방향 동기화 + 소프트 락
 *
 * 저장 구조:
 *   • _state (A1)  : 전체 상태 JSON (권위 저장소). 시트에 없는 깊은 데이터(스킬/장비/참여/정산 등)는 여기에만.
 *   • 편집 탭들     : 명단·분배내역·콘텐츠·티어컷·운영진·고투·설정·분배기준
 *                    ·QA리포트·장비현황·주문석보유·공용주문석보유·엘릭서보유·보드-*
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
var STATE_CHUNK = 45000;       // 셀당 글자 한도(5만) 회피 — _state JSON 을 A1,A2,… 청크로 분할 저장
var P = PropertiesService.getScriptProperties();

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';
  try {
    if (action === 'ping') return json({ data: { ok: true, ts: Date.now() } });
    // merge=1 일 때만 편집 탭 병합(느림). 기본은 _state 만 빠르게 반환(시트 13탭 read 생략).
    if (action === 'getAll') return json({ data: loadState(e.parameter && e.parameter.merge) });
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
    if (action === 'qaAdd') { return json({ data: addQaReport(body.report) }); }
    if (action === 'qaUpdate') { return json({ data: updateQaReport(body.idOrSlot, body.patch) }); }
    if (action === 'qaDelete') { return json({ data: deleteQaReport(body.idOrSlot) }); }
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

function loadState(doMerge) {
  var book = ss();
  var sh = book.getSheetByName(STATE_SHEET);
  if (!sh) return null;
  var last = sh.getLastRow();
  // A 열의 청크들을 순서대로 이어붙임(구버전 단일 A1 도 청크 1개로 호환).
  var raw = '';
  if (last >= 1) {
    var col = sh.getRange(1, 1, last, 1).getValues();
    for (var i = 0; i < col.length; i++) raw += (col[i][0] == null ? '' : col[i][0]);
  }
  if (!raw) return null;
  var state;
  try { state = JSON.parse(raw); } catch (_) { return null; }
  // 편집 탭 병합은 비용이 큼(13탭 read ~수초) → merge 요청 시에만. 기본 getAll 은 _state 만 빠르게 반환.
  if (doMerge) {
    mergeTabs(book, state);
    // 시트에서 읽은 변경을 권위 저장소에도 반영한다. 그래야 다음 빠른 getAll/재접속 때도 되밀리지 않는다.
    writeStateSheet(book, state);
  }
  return state;
}

function writeStateSheet(book, state) {
  var sh = book.getSheetByName(STATE_SHEET) || book.insertSheet(STATE_SHEET);
  var str = JSON.stringify(state);
  var chunks = [];
  for (var i = 0; i < str.length; i += STATE_CHUNK) chunks.push([str.substring(i, i + STATE_CHUNK)]);
  if (!chunks.length) chunks = [['']];
  var last = sh.getLastRow();
  if (last >= 1) sh.getRange(1, 1, last, 1).clearContent();   // 이전 청크 모두 비움
  var rng = sh.getRange(1, 1, chunks.length, 1);
  rng.setNumberFormat('@');                                    // 텍스트 강제(= + - 등 수식/숫자 해석 방지)
  rng.setValues(chunks);
}

function saveState(state) {
  var book = ss();
  writeStateSheet(book, state);
  writeTabs(book, state);
}

/* 편집 탭 정의: [탭이름, 헤더[], 행생성(state)→rows, 병합(state, rows)] */
function num(v) { var n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; }
// 시트가 날짜형으로 자동 변환한 셀(Date 객체)을 yyyy-MM-dd 로 되돌림. 텍스트면 그대로.
function ymd(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v == null ? '' : v).trim();
}
function truthyActive(v) { return !(v === '휴면' || v === false || v === 'FALSE' || v === 'x' || v === '' ); }
function txt(v) { return String(v == null ? '' : v).trim(); }
function dts(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX");
  return txt(v);
}

function qaStatusText(v) {
  var s = txt(v);
  var m = { open: '접수', in_progress: '처리중', resolved: '해결', blocked: '보류', closed: '종료' };
  return m[s] || s || '접수';
}
function qaStatusValue(v) {
  var s = txt(v);
  var m = { '접수': 'open', '처리중': 'in_progress', '해결': 'resolved', '보류': 'blocked', '종료': 'closed',
    open: 'open', in_progress: 'in_progress', resolved: 'resolved', blocked: 'blocked', closed: 'closed' };
  return m[s] || 'open';
}
function qaSeverityText(v) {
  var s = txt(v);
  var m = { low: '낮음', normal: '보통', high: '높음', critical: '긴급' };
  return m[s] || s || '보통';
}
function qaSeverityValue(v) {
  var s = txt(v);
  var m = { '낮음': 'low', '보통': 'normal', '높음': 'high', '긴급': 'critical',
    low: 'low', normal: 'normal', high: 'high', critical: 'critical' };
  return m[s] || 'normal';
}
function qaNow() { return new Date().toISOString(); }
function qaSlotDay() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd'); }
function nextQaSlot(list) {
  var day = qaSlotDay();
  var taken = {};
  (list || []).forEach(function (r) { if (r && r.slot) taken[String(r.slot)] = true; });
  var n = 1, slot;
  do { slot = 'QA-' + day + '-' + ('000' + n).slice(-3); n++; } while (taken[slot]);
  return slot;
}
function normalizeQaReport(r, existing) {
  r = r || {};
  existing = existing || {};
  var created = dts(r.createdAt) || existing.createdAt || qaNow();
  return {
    id: txt(r.id) || existing.id || ('qa-' + Utilities.getUuid()),
    slot: txt(r.slot) || existing.slot || '',
    status: qaStatusValue(r.status || existing.status),
    severity: qaSeverityValue(r.severity || existing.severity),
    area: txt(r.area) || existing.area || '',
    title: txt(r.title) || existing.title || '',
    reporter: txt(r.reporter) || existing.reporter || '',
    assignee: txt(r.assignee) || existing.assignee || '',
    createdAt: created,
    updatedAt: dts(r.updatedAt) || existing.updatedAt || created,
    resolvedAt: dts(r.resolvedAt) || existing.resolvedAt || '',
    environment: txt(r.environment) || existing.environment || '',
    steps: txt(r.steps) || existing.steps || '',
    expected: txt(r.expected) || existing.expected || '',
    actual: txt(r.actual) || existing.actual || '',
    note: txt(r.note) || existing.note || '',
    reply: txt(r.reply) || existing.reply || ''
  };
}
function writeQaSheet(book, s) {
  writeSheet(book, 'QA리포트', ['id', '슬롯', '상태', '심각도', '영역', '제목', '제보자', '담당', '접수일', '수정일', '해결일', '재현 절차', '기대 결과', '실제 결과', '메모', 'Codex 응답'],
    (s.qaReports || []).map(function (r) {
      return [r.id || '', r.slot || '', qaStatusText(r.status), qaSeverityText(r.severity), r.area || '', r.title || '',
        r.reporter || '', r.assignee || '', r.createdAt || '', r.updatedAt || '', r.resolvedAt || '',
        r.steps || '', r.expected || '', r.actual || '', r.note || '', r.reply || ''];
    }));
}

function loadQaState() {
  var book = ss();
  var state = loadState(false);
  if (!state) throw new Error('state not initialized');
  state.qaReports = state.qaReports || [];
  return { book: book, state: state };
}
function persistQaState(ctx) {
  writeStateSheet(ctx.book, ctx.state);
  writeQaSheet(ctx.book, ctx.state);
}
function addQaReport(report) {
  var ctx = loadQaState();
  var now = qaNow();
  var rec = normalizeQaReport(report);
  rec.id = rec.id || ('qa-' + Utilities.getUuid());
  rec.slot = rec.slot || nextQaSlot(ctx.state.qaReports);
  rec.status = 'open';
  rec.createdAt = now;
  rec.updatedAt = now;
  ctx.state.qaReports.unshift(rec);
  persistQaState(ctx);
  return rec;
}
function updateQaReport(idOrSlot, patch) {
  var ctx = loadQaState();
  var key = txt(idOrSlot);
  var found = null;
  for (var i = 0; i < ctx.state.qaReports.length; i++) {
    var r = ctx.state.qaReports[i];
    if (r && (String(r.id) === key || String(r.slot) === key)) { found = r; break; }
  }
  if (!found) throw new Error('QA report not found: ' + key);
  patch = patch || {};
  var merged = {};
  Object.keys(found).forEach(function (k) { merged[k] = found[k]; });
  Object.keys(patch).forEach(function (k) { merged[k] = patch[k]; });
  var rec = normalizeQaReport(merged, found);
  rec.updatedAt = qaNow();
  if ((rec.status === 'resolved' || rec.status === 'closed') && !rec.resolvedAt) rec.resolvedAt = rec.updatedAt;
  Object.keys(found).forEach(function (k) { delete found[k]; });
  Object.keys(rec).forEach(function (k) { found[k] = rec[k]; });
  persistQaState(ctx);
  return found;
}
function deleteQaReport(idOrSlot) {
  var ctx = loadQaState();
  var key = txt(idOrSlot);
  var before = ctx.state.qaReports.length;
  ctx.state.qaReports = ctx.state.qaReports.filter(function (r) { return !(r && (String(r.id) === key || String(r.slot) === key)); });
  if (ctx.state.qaReports.length === before) throw new Error('QA report not found: ' + key);
  persistQaState(ctx);
  return { ok: true, idOrSlot: key };
}

function readTable(book, name) {
  var sh = book.getSheetByName(name);
  if (!sh) return null;
  var vals = sh.getDataRange().getValues();
  if (!vals.length) return { head: [], rows: [] };
  var head = vals[0].map(function (v) { return txt(v); });
  var rows = vals.slice(1).filter(function (r) { return r.join('').trim() !== ''; });
  return { head: head, rows: rows };
}
function readSheet(book, name) {
  var table = readTable(book, name);
  if (!table) return null;
  if (!table.rows.length) return [];   // 헤더만 있거나 빈 경우 → 빈 배열(전부 삭제로 간주하지 않도록 호출부에서 처리)
  return table.rows;
}
function writeSheet(book, name, head, rows) {
  var sh = book.getSheetByName(name) || book.insertSheet(name);
  sh.clearContents();
  sh.getRange(1, 1, 1, head.length).setValues([head]);
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  sh.setFrozenRows(1);
}

var EQUIP_GROUPS = [
  { label: '무기', slots: ['주무기', '보조1', '보조2'] },
  { label: '방어구', slots: ['투구', '견갑', '상의', '하의', '벨트', '장갑', '신발', '망토'] },
  { label: '장신구', slots: ['목걸이', '귀걸이', '반지', '팔찌'] },
  { label: '성유물', slots: ['복종', '충성', '무한', '심연'] },
];
var EQUIP_SLOTS = (function () {
  var out = [];
  EQUIP_GROUPS.forEach(function (g) { g.slots.forEach(function (slot) { out.push(slot); }); });
  return out;
})();
var RELIC_SLOTS = (function () {
  var out = {};
  EQUIP_GROUPS[3].slots.forEach(function (slot) { out[slot] = true; });
  return out;
})();

function tierText(t) {
  var n = +t || 0;
  return n ? ((n % 1 === 0 ? String(n) : n.toFixed(1)) + 'T') : '';
}
function equipText(slot, it) {
  if (!it) return '';
  if (RELIC_SLOTS[slot]) return it.tier ? ('T' + it.tier) : '';
  var parts = [];
  if (it.star) parts.push(it.star + '성');
  if (it.tier) parts.push(tierText(it.tier));
  if (it.enhance) parts.push('+' + it.enhance);
  return parts.join(' ');
}
function parseEquipValue(slot, v) {
  var s = txt(v);
  if (!s) return null;
  if (RELIC_SLOTS[slot]) {
    var rm = s.match(/T?\s*(\d+)/i);
    var rt = rm ? num(rm[1]) : 0;
    return rt ? { tier: rt } : null;
  }
  var starM = s.match(/([1-6])\s*성/);
  var tierM = s.match(/(\d+(?:\.\d+)?)\s*T/i);
  var enhM = s.match(/[+＋]\s*(\d+)/);
  var star = starM ? num(starM[1]) : 0;
  var tier = tierM ? num(tierM[1]) : 0;
  var enhance = enhM ? num(enhM[1]) : 0;
  if (!star && !tier && !enhance) return null;
  return { star: star, tier: tier, enhance: enhance };
}
function commonStoneHead(mc) { return mc.name + ' (' + mc.star + '성)'; }
function parseCommonStoneHead(h) {
  var m = txt(h).match(/^(.*)\s*\((\d+)성\)\s*$/);
  if (!m) return null;
  return { name: txt(m[1]), star: num(m[2]) || 5 };
}
function commonStoneKey(mc) { return mc.name + '__' + mc.star; }

function writeTabs(book, s) {
  // 구버전(읽기전용 미러) 탭 정리 — 더 이상 쓰지 않음.
  ['명단(미러)', '분배내역(미러)'].forEach(function (n) {
    var old = book.getSheetByName(n); if (old) book.deleteSheet(old);
  });
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
  writeQaSheet(book, s);
  var rsh = book.getSheetByName('분배기준') || book.insertSheet('분배기준');
  rsh.clearContents(); rsh.getRange('A1').setValue(s.distributionRules || '');
  writeEquipSheet(book, s);
  // 보유 현황(롱포맷: 닉네임·직업·스킬 1행씩) — 행 추가/삭제로 보유 관리
  writeSheet(book, '주문석보유', ['닉네임', '직업', '주문석'], ownRows(s, '주문석'));
  writeCommonStoneSheet(book, s);
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
function writeEquipSheet(book, s) {
  var rows = (s.members || []).filter(function (m) { return m.active !== false; }).map(function (m) {
    return [m.name, m.cls || ''].concat(EQUIP_SLOTS.map(function (slot) {
      return equipText(slot, (m.equip || {})[slot]);
    }));
  });
  writeSheet(book, '장비현황', ['닉네임', '직업'].concat(EQUIP_SLOTS), rows);
}
function writeCommonStoneSheet(book, s) {
  var app = s.appSettings || {};
  var managed = app.managedStones || [];
  var rows = (s.members || []).filter(function (m) { return m.active !== false; }).map(function (m) {
    var bag = ((m.skills || {})['공용주문석']) || {};
    return [m.name, m.cls || ''].concat(managed.map(function (mc) {
      return bag[commonStoneKey(mc)] || '';
    }));
  });
  writeSheet(book, '공용주문석보유', ['닉네임', '직업'].concat(managed.map(commonStoneHead)), rows);
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
    return { id: r[0] || ('id' + Math.random().toString(36).slice(2)), date: ymd(r[1]), item: String(r[2] || ''), type: String(r[3] || ''), member: String(r[4] || ''), from: String(r[5] || ''), price: num(r[6]), note: String(r[7] || '') };
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
  var qrows = readSheet(book, 'QA리포트');
  if (qrows && qrows.length) s.qaReports = qrows.map(function (r, i) {
    return {
      id: txt(r[0]) || txt(r[1]) || ('qa-' + Utilities.getUuid()),
      slot: txt(r[1]) || ('QA-SHEET-' + (i + 1)),
      status: qaStatusValue(r[2]),
      severity: qaSeverityValue(r[3]),
      area: txt(r[4]),
      title: txt(r[5]),
      reporter: txt(r[6]),
      assignee: txt(r[7]),
      createdAt: dts(r[8]),
      updatedAt: dts(r[9]),
      resolvedAt: dts(r[10]),
      steps: txt(r[11]),
      expected: txt(r[12]),
      actual: txt(r[13]),
      note: txt(r[14]),
      reply: txt(r[15])
    };
  });
  var rsh = book.getSheetByName('분배기준');
  if (rsh) { var rv = rsh.getRange('A1').getValue(); if (rv) s.distributionRules = String(rv); }
  mergeEquipSheet(book, s);
  mergeCommonStoneSheet(book, s);
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
    var table = readTable(book, '보드-' + b.name);
    if (table && table.rows.length) {
      var mb = memberByName(s);
      var cols = table.head.slice(1).map(txt).filter(function (c) { return c; });
      if (cols.length) b.columns = cols;
      b.data = {};
      table.rows.forEach(function (r) {
        var m = mb[txt(r[0])]; if (!m) return;
        var rec = {}; (b.columns || []).forEach(function (c, ci) { if (txt(r[ci + 1])) rec[c] = true; });
        if (Object.keys(rec).length) b.data[String(m.id)] = rec;
      });
    }
  });
}

function mergeEquipSheet(book, s) {
  var rows = readSheet(book, '장비현황');
  if (!rows || !rows.length) return;
  var mb = memberByName(s);
  rows.forEach(function (r) {
    var m = mb[txt(r[0])]; if (!m) return;
    m.equip = m.equip || {};
    EQUIP_SLOTS.forEach(function (slot, i) {
      var raw = r[i + 2];
      var parsed = parseEquipValue(slot, raw);
      if (txt(raw)) {
        if (parsed) m.equip[slot] = parsed;
      } else {
        delete m.equip[slot];
      }
    });
  });
}
function mergeCommonStoneSheet(book, s) {
  var table = readTable(book, '공용주문석보유');
  if (!table) return;
  var defs = [];
  table.head.slice(2).forEach(function (h) {
    var def = parseCommonStoneHead(h);
    if (def && def.name) defs.push(def);
  });
  if (!defs.length) return;
  s.appSettings = s.appSettings || {};
  s.appSettings.managedStones = defs;
  if (!table.rows.length) return;
  var mb = memberByName(s);
  table.rows.forEach(function (r) {
    var m = mb[txt(r[0])]; if (!m) return;
    m.skills = m.skills || {};
    m.skills['공용주문석'] = {};
    defs.forEach(function (def, i) {
      var count = num(r[i + 2]);
      if (count > 0) m.skills['공용주문석'][commonStoneKey(def)] = count;
    });
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
