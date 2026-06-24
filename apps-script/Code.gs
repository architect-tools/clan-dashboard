/**
 * 불면증 클랜 관리 — Apps Script 백엔드 (Web App).
 *
 * 역할:
 *   • 대시보드의 데이터 저장소(이 스프레드시트)에 대한 읽기/쓰기 API
 *   • 네이버 CLOVA OCR 프록시 (시크릿 키를 서버에 보관)
 *   • 토큰(비밀번호) 기반 쓰기 인증
 *
 * 배포 전 설정 (프로젝트 설정 ▸ 스크립트 속성):
 *   GATE_PASSWORD   대시보드 비밀번호와 동일하게 (쓰기 인증용)
 *   NAVER_OCR_URL   CLOVA OCR APIGW Invoke URL (선택, OCR 사용 시)
 *   NAVER_OCR_SECRET CLOVA OCR Secret Key       (선택, OCR 사용 시)
 *
 * 배포: 배포 ▸ 새 배포 ▸ 웹 앱 ▸ 실행: 나, 액세스: 모든 사용자 ▸ URL 복사
 *       → docs/js/config.js 의 APPS_SCRIPT_URL 에 붙여넣기.
 */

var STATE_SHEET = '_state';   // 단일 셀(A1)에 전체 상태를 JSON으로 저장 (권위 저장소)
var P = PropertiesService.getScriptProperties();

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';
  try {
    if (action === 'ping') return json({ data: { ok: true, ts: Date.now() } });
    if (action === 'getAll') return json({ data: loadState() });
    return json({ error: 'unknown action: ' + action });
  } catch (err) {
    return json({ error: String(err) });
  }
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (_) {}
  var action = body.action;
  try {
    // OCR 은 토큰 없이도 동작 가능하게 둘 수 있으나, 여기서는 쓰기/OCR 모두 인증 요구
    if (!checkToken(body.token)) return json({ error: 'unauthorized' });

    if (action === 'save') { saveState(body.data); return json({ data: { ok: true } }); }
    if (action === 'ocr')  { return json({ data: { lines: naverOcr(body.image) } }); }
    return json({ error: 'unknown action: ' + action });
  } catch (err) {
    return json({ error: String(err) });
  }
}

/* ── auth ─────────────────────────────────────────────────────────── */
function checkToken(token) {
  var pw = P.getProperty('GATE_PASSWORD');
  if (!pw) return true;            // 비밀번호 미설정 시 통과(초기 테스트용)
  return token === pw;
}

/* ── state store ──────────────────────────────────────────────────── */
function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

function loadState() {
  var sh = ss().getSheetByName(STATE_SHEET);
  if (!sh) return null;            // 없으면 프런트가 seed.json 으로 폴백
  var raw = sh.getRange('A1').getValue();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function saveState(state) {
  var book = ss();
  var sh = book.getSheetByName(STATE_SHEET) || book.insertSheet(STATE_SHEET);
  sh.getRange('A1').setValue(JSON.stringify(state));
  // 사람이 보기 쉬운 미러 탭들 (대시보드에서 수정, 아래는 읽기 전용 뷰)
  try { mirrorMembers(book, state); } catch (e) { /* 미러 실패는 무시 */ }
  try { mirrorLog(book, state); } catch (e) {}
}

function mirrorMembers(book, state) {
  var sh = book.getSheetByName('명단(미러)') || book.insertSheet('명단(미러)');
  sh.clearContents();
  var head = ['순번', '닉네임', '직업', '전투력', '참여점수', '활동'];
  var rows = (state.members || []).map(function (m) {
    return [m.order, m.name, m.cls, m.power, m.score, m.active === false ? '휴면' : '활동'];
  });
  sh.getRange(1, 1, 1, head.length).setValues([head]);
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
}

function mirrorLog(book, state) {
  var sh = book.getSheetByName('분배내역(미러)') || book.insertSheet('분배내역(미러)');
  sh.clearContents();
  var head = ['날짜', '아이템', '구분', '받은 사람', '메모'];
  var rows = (state.distributionLog || []).map(function (d) {
    return [d.date, d.item, d.type, d.member, d.note];
  });
  sh.getRange(1, 1, 1, head.length).setValues([head]);
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
}

/* ── Naver CLOVA OCR proxy ────────────────────────────────────────── */
function naverOcr(base64) {
  var url = P.getProperty('NAVER_OCR_URL');
  var secret = P.getProperty('NAVER_OCR_SECRET');
  if (!url || !secret) throw new Error('OCR not configured (NAVER_OCR_URL/SECRET)');

  var payload = {
    version: 'V2',
    requestId: Utilities.getUuid(),
    timestamp: Date.now(),
    images: [{ format: 'png', name: 'clan', data: base64 }]
  };
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-OCR-SECRET': secret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error('Naver OCR ' + code + ': ' + res.getContentText().slice(0, 300));
  var data = JSON.parse(res.getContentText());
  var lines = [];
  (data.images || []).forEach(function (img) {
    (img.fields || []).forEach(function (f) { if (f.inferText) lines.push(f.inferText); });
  });
  return lines;
}

/* ── helpers ──────────────────────────────────────────────────────── */
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
