// db.js — single source of truth + persistence adapter + undo/redo history.
//   • standalone mode (no APPS_SCRIPT_URL): state in localStorage, seeded from data/seed.json.
//   • live mode: state fetched from / saved to the Apps Script backend.
// Views read DB.state, mutate via Mutations, then call DB.commit().
// Every commit() creates an undo checkpoint.

import { CONFIG } from './config.js';
import { uid, toast } from './util.js';

const LIVE = () => !!CONFIG.APPS_SCRIPT_URL;
const clone = (o) => JSON.parse(JSON.stringify(o));

// 분배 기준(운영 시트 '분배 기준(NEW)' 기준)
const DEFAULT_RULES = `1. 보스님·페커리님·붉으래님 필요 시 최우선 분배
2. 전용 주문석·엘릭서·탈것·성좌: 투력 순 분배
3. 공용 주문석·마부핵: 고투 제외, 내판가 적용 (기준 투력 필요)

4. 드랍템
   · 무기   5.5티 (직업별 투력순 90만↑ 10원, 이하 내판)
            4.5티 (직업별 투력순 80만↑ 10원, 이하 내판)
            3.5티~3티 (내판·외판, 내판 시 참여도 우선)
   · 방어구 5성 1티 (최상위 우선 10원)
            5.5티 (투력순 90만↑ 10원, 이하 내판)
            4.5티 (투력순 80만↑ 10원, 이하 내판)
            3.5티~3티 (내판·외판, 내판 시 참여도 우선)
   · 장신구 4.5티 (투력순 90만↑ 10원, 이하 내판)
            3.5티 (투력순 80만↑ 10원, 이하 내판)
            3티 (투력순 80만↑ 10원, 이하 내판)

5. 설계도(도면)
   · 무기   5성 하급 (최상위 우선 10원)
            상급 (구간별 로테, 80만↑ 10원, 이하 내판)
            중급~하급 (내판·외판, 내판 시 참여도 우선)
   · 방어구 5성 하급 (최상위 우선 10원)
            상급 (구간별 로테, 80만↑ 10원, 이하 내판)
            중급~하급 (내판·외판, 내판 시 참여도 우선)
   · 장신구 상급 (구간별 투력순 로테, 90만↑ 10원, 이하 내판)
            중급 (구간별 투력순 로테, 80만↑ 10원, 이하 내판)
            하급 (내판·외판)

* 투표: 1순위 투력, 2순위 참여도
* 참여도 우선, 중복 입찰 시 1가지 상품만 (몰림 방지)
  — 시트 확인 후 직전 입찰자는 다음 순번으로`;

export const DB = {
  state: null,
  _subs: new Set(),
  _saveTimer: null,
  _undo: [],
  _redo: [],
  _snapshot: null,         // state as of the last commit (for building undo entries)
  _loadToken: 0,           // 백그라운드 새로고침 적용 가드용(새 로드/새 새로고침 시 증가)
  _pendingSave: false,     // 미저장(또는 저장 중) 로컬 편집 있음 → 새로고침이 덮어쓰지 않도록
  _savePromise: null,
  _saveError: false,
  _saveSeq: 0,
  _maxHistory: 80,
  _onHistory: null,        // () => update undo/redo button states
  _onRefresh: null,        // () => re-render current view (after undo/redo)

  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); },
  _emit() { for (const fn of this._subs) try { fn(this.state); } catch (e) { console.error(e); } },
  setCallbacks({ onHistory, onRefresh, onLoading }) { this._onHistory = onHistory; this._onRefresh = onRefresh; this._onLoading = onLoading; },
  _setLoading(on) {   // 진행 중 네트워크 새로고침 카운터 → UI 로딩 표시(⟳ 버튼 회전 등)
    this._loadingN = Math.max(0, (this._loadingN || 0) + (on ? 1 : -1));
    this._onLoading && this._onLoading(this._loadingN > 0);
  },

  async init() {
    let data, fromBackend = false;
    if (LIVE()) {
      // 빠른 1차 로드: _state 만(merge 생략). 시트 편집은 아래 _bgMerge 로 곧이어 반영.
      try { data = await this._fetch('getAll'); fromBackend = !!data; }
      catch (e) { console.error('backend load failed, falling back to local', e); toast('백엔드 연결 실패 — 로컬 모드로 표시', 'error'); }
    }
    if (!data) {
      const raw = localStorage.getItem(CONFIG.STORE_KEY);
      if (raw) { try { data = JSON.parse(raw); } catch {} }
    }
    if (!data) data = await (await fetch('data/seed.json', { cache: 'no-store' })).json();
    this.state = normalize(data);
    this._snapshot = clone(this.state);
    this._undo = []; this._redo = [];
    if (!LIVE()) this._persistLocal();
    // 라이브 첫 연결인데 백엔드가 비어 있으면, 로컬/시드 데이터를 클라우드로 1회 이관(데이터 유실 방지)
    else if (!fromBackend) { try { await this._fetch('save', { data: this.state }); toast('현재 데이터를 클라우드로 옮겼습니다'); } catch (e) { console.warn('초기 이관 실패', e); } }
    this._emit(); this._onHistory && this._onHistory();
    if (LIVE() && fromBackend) this.refresh({ merge: true });   // 백그라운드로 시트 편집 병합본 동기화
    return this.state;
  },

  /** Persist current state + create an undo checkpoint. In live mode pushes to backend. */
  commit({ immediate = false, history = true } = {}) {
    if (history && this._snapshot) {
      this._undo.push(this._snapshot);
      if (this._undo.length > this._maxHistory) this._undo.shift();
      this._redo = [];
    }
    this._snapshot = clone(this.state);
    this._persistLocal();
    this._emit();
    this._onHistory && this._onHistory();
    if (LIVE()) this._scheduleSave(immediate);
  },

  _scheduleSave(immediate) {
    clearTimeout(this._saveTimer);
    this._pendingSave = true;   // 저장 완료 전까지 백그라운드 새로고침이 내 편집을 덮지 않게
    this._saveError = false;
    const doSave = () => {
      const seq = ++this._saveSeq;
      this._savePromise = this._fetch('save', { data: this.state })
        .then(() => { if (seq === this._saveSeq) { this._pendingSave = false; this._saveError = false; } })  // 최신 저장 성공 시에만 해제
        .catch((e) => { if (seq === this._saveSeq) { this._pendingSave = false; this._saveError = true; } console.error(e); toast('동기화 실패 (변경은 로컬에 보관됨)', 'error'); });
      return this._savePromise;
    };
    if (immediate) doSave(); else this._saveTimer = setTimeout(doSave, 1200);
  },

  async flushSave() {
    if (!LIVE() || !this._pendingSave) return true;
    clearTimeout(this._saveTimer);
    const seq = ++this._saveSeq;
    try {
      this._savePromise = this._fetch('save', { data: this.state });
      await this._savePromise;
      if (seq === this._saveSeq) { this._pendingSave = false; this._saveError = false; }
      return true;
    } catch (e) {
      if (seq === this._saveSeq) { this._pendingSave = false; this._saveError = true; }
      console.error(e); toast('동기화 실패 (변경은 로컬에 보관됨)', 'error');
      return false;
    }
  },

  canUndo() { return this._undo.length > 0; },
  canRedo() { return this._redo.length > 0; },
  undo() {
    if (!this._undo.length) return false;
    this._redo.push(clone(this.state));
    this.state = this._undo.pop();
    this._snapshot = clone(this.state);
    this._afterTimeTravel();
    return true;
  },
  redo() {
    if (!this._redo.length) return false;
    this._undo.push(clone(this.state));
    this.state = this._redo.pop();
    this._snapshot = clone(this.state);
    this._afterTimeTravel();
    return true;
  },
  _afterTimeTravel() {
    this._persistLocal();
    this._emit();
    this._onHistory && this._onHistory();
    this._onRefresh && this._onRefresh();
    if (LIVE()) this._scheduleSave(false);
  },

  _persistLocal() {
    try { localStorage.setItem(CONFIG.STORE_KEY, JSON.stringify(this.state)); }
    catch (e) { console.error('localStorage full?', e); }
  },

  async _fetch(action, payload, query) {
    const url = CONFIG.APPS_SCRIPT_URL;
    const token = localStorage.getItem(CONFIG.TOKEN_KEY) || '';
    const opts = payload
      ? { method: 'POST', body: JSON.stringify({ action, token, ...payload }),
          headers: { 'Content-Type': 'text/plain;charset=utf-8' } } // text/plain avoids CORS preflight
      : { method: 'GET', cache: 'no-store' };
    const u = payload ? url : `${url}?${new URLSearchParams({ action, token, _ts: String(Date.now()), ...(query || {}) })}`;
    let last = '';
    for (let i = 0; i < 3; i++) {
      const res = await fetch(u, opts);
      const text = await res.text();
      if (res.ok && text.trim().startsWith('{')) {
        const json = JSON.parse(text);
        if (json.error) throw new Error(json.error);
        return json.data;
      }
      last = `HTTP ${res.status} ${text.slice(0, 120).replace(/\s+/g, ' ')}`;
      await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
    }
    throw new Error(last || 'invalid backend response');
  },

  _applyQaReport(rec) {
    if (!rec) return null;
    this.state.qaReports ||= [];
    const i = this.state.qaReports.findIndex((r) => r.id === rec.id || r.slot === rec.slot);
    if (i >= 0) this.state.qaReports[i] = rec;
    else this.state.qaReports.unshift(rec);
    this.state.qaReports.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    this._snapshot = clone(this.state);
    this._persistLocal();
    this._emit();
    return rec;
  },

  async addQaReport(report) {
    if (!LIVE()) {
      const rec = Mutations.addQaReport(report);
      this.commit({ immediate: true });
      return rec;
    }
    const rec = await this._fetch('qaAdd', { report });
    return this._applyQaReport(rec);
  },

  async updateQaReport(idOrSlot, patch = {}) {
    if (!LIVE()) {
      const rec = Mutations.updateQaReport(idOrSlot, patch);
      this.commit({ immediate: true });
      return rec;
    }
    const rec = await this._fetch('qaUpdate', { idOrSlot, patch });
    return this._applyQaReport(rec);
  },

  async removeQaReport(idOrSlot) {
    if (!LIVE()) {
      Mutations.removeQaReport(idOrSlot);
      this.commit({ immediate: true });
      return true;
    }
    await this._fetch('qaDelete', { idOrSlot });
    this.state.qaReports = (this.state.qaReports || []).filter((r) => r.id !== idOrSlot && r.slot !== idOrSlot);
    this._snapshot = clone(this.state);
    this._persistLocal();
    this._emit();
    return true;
  },

  // 백그라운드 새로고침: 다른 사용자/시트 변경을 반영. merge=true 면 시트 편집까지(느림), false 면 대시보드 편집만(빠름).
  // 내 미저장 편집(_pendingSave)·열린 모달 중에는 스킵(클로버/방해 방지). 데이터 동일하면 재렌더 안 함.
  // 반환: 'busy'(편집/모달 중 스킵) · true(갱신함) · false(이미 최신) · 'stale'/'error'. 수동 버튼이 피드백에 사용.
  refresh({ merge = false, force = false } = {}) {
    if (!LIVE() || (!force && this._pendingSave)) return Promise.resolve('busy');
    if (!force && this._saveError) return Promise.resolve('save-error');
    if (typeof document !== 'undefined' && document.querySelector('.modal-overlay')) return Promise.resolve('busy');
    const token = ++this._loadToken;
    const saveSeqAtStart = this._saveSeq;   // 조회 중 내가 편집·저장하면 시퀀스가 바뀜 → 옛 응답 폐기(편집 되돌림 방지)
    this._setLoading(true);
    return this._fetch('getAll', null, merge ? { merge: 1 } : undefined).then((data) => {
      if (!data || token !== this._loadToken || this._pendingSave || saveSeqAtStart !== this._saveSeq) return 'stale';
      const next = normalize(data);
      if (JSON.stringify(next) === JSON.stringify(this.state)) return false;
      this.state = next; this._snapshot = clone(this.state);
      this._persistLocal(); this._emit(); this._onRefresh && this._onRefresh();
      return true;
    }).catch((e) => { console.error(e); return 'error'; }).finally(() => this._setLoading(false));
  },
};

// 장비 슬롯명 운영 시트 기준으로 교정(기존 데이터 키 이동, 값 보존)
const EQUIP_RENAME = { '무기': '주무기', '보조무기1': '보조1', '보조무기2': '보조2', '흉갑': '상의', '각반': '하의', '허리띠': '벨트' };
const MEMBER_RENAME = { '도베르만': 'Doberman', '페커리': '냉정' };

function migrateMemberName(name) {
  return MEMBER_RENAME[name] || name || '';
}

function migrateEquip(eq) {
  const out = { ...(eq || {}) };
  for (const [o, n] of Object.entries(EQUIP_RENAME)) {
    if (out[o] != null && out[n] == null) { out[n] = out[o]; delete out[o]; }
  }
  return out;
}

function normalizeFieldBossCatalog(catalog) {
  const specs = [
    { name: '3그룹', points: 3, weekly: 5 },
    { name: '4그룹', points: 5, weekly: 4 },
    { name: '5그룹', points: 5, weekly: 3 },
    { name: '6그룹', points: 10, weekly: 2 },
    { name: '7그룹', points: 15, weekly: 1 },
  ];
  for (const spec of specs) {
    let item = catalog.find((c) => c && c.category === '필드 보스' && c.name === spec.name);
    if (!item) {
      catalog.push({ category: '필드 보스', ...spec, active: true });
    } else {
      item.category = '필드 보스';
      if (item.points == null || item.points === '') item.points = spec.points;
      item.weekly = +item.weekly || spec.weekly;
      if (item.active == null) item.active = true;
    }
  }
}

function isCorruptContentEntry(c) {
  const text = `${c?.category || ''} ${c?.name || ''}`;
  return text.includes('??') || text.includes('�') || /^\d+\?\?$/.test(String(c?.name || ''));
}

const QA_STATUSES = new Set(['open', 'in_progress', 'resolved', 'blocked', 'closed']);
const QA_SEVERITIES = new Set(['low', 'normal', 'high', 'critical']);

function nowIso() {
  return new Date().toISOString();
}

function qaDayKey(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

function nextQaSlot(reports) {
  const day = qaDayKey();
  const taken = new Set((reports || []).map((r) => r && r.slot).filter(Boolean));
  let n = 1;
  while (taken.has(`QA-${day}-${String(n).padStart(3, '0')}`)) n++;
  return `QA-${day}-${String(n).padStart(3, '0')}`;
}

function normalizeQaStatus(status) {
  const s = String(status || 'open');
  return QA_STATUSES.has(s) ? s : 'open';
}

function normalizeQaSeverity(severity) {
  const s = String(severity || 'normal');
  return QA_SEVERITIES.has(s) ? s : 'normal';
}

function normalizeQaReport(report, index = 0) {
  const r = report || {};
  const createdAt = String(r.createdAt || r.date || '');
  return {
    id: String(r.id || r.slot || uid()),
    slot: String(r.slot || `QA-LEGACY-${String(index + 1).padStart(3, '0')}`),
    status: normalizeQaStatus(r.status),
    severity: normalizeQaSeverity(r.severity),
    area: String(r.area || ''),
    title: String(r.title || '').trim(),
    reporter: String(r.reporter || ''),
    environment: String(r.environment || ''),
    steps: String(r.steps || ''),
    expected: String(r.expected || ''),
    actual: String(r.actual || ''),
    note: String(r.note || ''),
    reply: String(r.reply || ''),
    assignee: String(r.assignee || ''),
    createdAt: createdAt || nowIso(),
    updatedAt: String(r.updatedAt || createdAt || ''),
    resolvedAt: String(r.resolvedAt || ''),
  };
}

// ── state normalization / migration ─────────────────────────────────
function normalize(d) {
  d = d || {};
  d.meta ||= { clanName: '불면증', schemaVersion: 2 };
  d.appSettings ||= {};                                  // site-wide app prefs (UI scale 등)
  if (d.appSettings.uiScale == null) d.appSettings.uiScale = 1;
  d.appSettings.managedStones ||= [];                    // 관리할 공용 주문석 [{name, star}]
  d.settings ||= { totalDiamonds: 170000, staffRatio: 0.05, powerRatio: 0.40, participationRatio: 0.55 };
  d.tiers ||= [];
  d.powerRanks ||= [];
  d.staff ||= [];
  d.members = (d.members || []).map((m, i) => ({
    id: m.id || i + 1, order: m.order ?? i + 1, name: migrateMemberName(m.name),
    cls: m.cls || '', power: +m.power || 0, score: +m.score || 0,
    grade: m.grade || '정회원',        // 등급(멤버십): 운영진/정회원/준회원/신입
    equip: migrateEquip(m.equip),      // 장착 장비: {슬롯: {star,tier,enhance}} (슬롯명 시트 기준)
    skills: m.skills || {},            // 주문석/엘릭서: { 주문석:{스킬:값}, 엘릭서:{항목:값} }
    active: m.active !== false, note: m.note || '',
  }));
  d.contentCatalog ||= [];
  d.contentCatalog = d.contentCatalog.filter((c) => !isCorruptContentEntry(c));
  // 콘텐츠 카테고리 보정: 앙그바르 투기장·클랜 원정대는 '클랜 활동'으로 분리(기존 데이터도 교정)
  for (const c of d.contentCatalog) if (c && (c.name === '앙그바르 투기장' || c.name === '클랜 원정대')) c.category = '클랜 활동';
  normalizeFieldBossCatalog(d.contentCatalog);
  d.rotationQueues ||= [];
  d.weaponProgress ||= [];

  // date-based participation: byDate[YYYY-MM-DD][contentName] = [memberId, ...]
  d.participation ||= {};
  d.participation.byDate ||= {};
  // migrate legacy week-based model if present (rarely needed after fresh start)
  if (d.participation.data && !Object.keys(d.participation.byDate).length) {
    delete d.participation.weeks; delete d.participation.data; delete d.participation.current;
  }
  d.participation.scoreFrom ||= '';
  d.participation.scoreTo ||= '';

  d.distributionLog ||= [];
  // 분배 날짜 정규화: 백엔드 시트가 날짜 문자열을 자동으로 Date로 변환 → 탭 read-back 시
  // 'Mon Jun 01 2026 00:00:00 GMT+0900 …' 형태로 돌아옴 → 로드 시 yyyy-MM-dd 로 정리(표시·재저장 모두).
  const _toYmd = (s) => {
    if (typeof s !== 'string' || !s) return s || '';
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);   // 이미 ISO
    const p = (n) => String(n).padStart(2, '0');
    // 연도 포함 풀 Date 문자열(시트가 'Mon Jun 01 2026 …'로 변환한 경우)만 Date 파서 신뢰
    if (/\d{4}/.test(s)) {
      const t = new Date(s);
      if (!isNaN(t.getTime())) return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
    }
    // 한글/축약 표기: "3.30일" · "5월2일" · "6월 1일" · "6월14일" · "4/1" → M·D 추출(연도는 운영시트 기준 2026)
    const m = s.match(/(\d{1,2})\s*[월./-]\s*(\d{1,2})/);
    if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) return `2026-${p(+m[1])}-${p(+m[2])}`;
    return s;                                                  // 그 외(못 읽는 표기)는 원본 유지
  };
  d.distributionLog = d.distributionLog.map((x) => (x && x.date ? { ...x, date: _toYmd(x.date) } : x));
  d.dropLog ||= [];     // 드랍 기록: {id, date, content, item, note}
  d.sales ||= [];       // 진행 중 내판: {id, item, bidType, basePrice, deadline(ms), bids:[{name,amount}]}
  d.settlements ||= []; // finalized diamond distributions (다이아 분배 확정 기록)
  d.qaReports = (d.qaReports || []).map(normalizeQaReport)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  d.schedule ||= [];
  d.statusBoards ||= []; // 캐릭터 현황 보드: 주문석/성좌/탈것/엘릭서/플랫폼
  // 관리 보드를 운영 시트 구조로 1회 정비: 부적합 보드 제거(무기 숙련·KDA·통합보드 등) + 분리 카테고리 보장.
  // (장착 장비는 슬롯 그리드+장비 현황 표가 담당하므로 '장비 현황' 보드는 제거)
  if (!d.appSettings._mgmtBoards4) {
    // 주문석·엘릭서는 직업별 전용 표(gear.js)로 분리 → 제네릭 보드에서 제외.
    const REMOVE = new Set(['무기 숙련', '장비 현황', '주문석·성좌·탈것', '엘릭서 & 패시브', 'KDA', '주문석', '엘릭서']);
    d.statusBoards = d.statusBoards.filter((b) => b && !REMOVE.has(b.name));
    const have = new Set(d.statusBoards.map((b) => b.name));
    const ensure = [
      { name: '성좌', columns: ['바위를 삼키는 괴물', '자유로운 여행자', '바다의 괴물'] },
      { name: '탈것', columns: ['지진발굽', '심연의 수호자', '심연의 환영', '황혼의방랑자'] },
      { name: '플랫폼 이용 현황', columns: ['PC', '모바일', '디스코드'] },
    ];
    for (const b of ensure) if (!have.has(b.name)) d.statusBoards.push({ id: uid(), name: b.name, columns: [...b.columns], data: {} });
    d.appSettings._mgmtBoards4 = true;
  }
  if (d.distributionRules == null) d.distributionRules = DEFAULT_RULES;
  // 분배 기준을 시트 NEW 기준으로 1회 강제 교체(기존 OLD 텍스트 정리). 이후 운영자 편집은 유지.
  if (!d.appSettings._rulesNEW) { d.distributionRules = DEFAULT_RULES; d.appSettings._rulesNEW = true; }
  if (d.ocrCrop === undefined) d.ocrCrop = null;   // remembered OCR crop as image fractions {x,y,w,h}
  if (d.ocrAnchor === undefined) d.ocrAnchor = null; // OpenCV anchor template for auto-detect {tplDataUrl,relW,relH,refImgW}
  return d;
}

// ── mutation helpers (operate on DB.state; caller commits) ──────────
export const Mutations = {
  // members ----------------------------------------------------------
  upsertMember(m) {
    const list = DB.state.members;
    if (m.id) {
      const i = list.findIndex((x) => x.id === m.id);
      if (i >= 0) { list[i] = { ...list[i], ...m }; return list[i]; }
    }
    const nm = { id: Math.max(0, ...list.map((x) => x.id)) + 1, order: list.length + 1,
      name: '', cls: '', power: 0, score: 0, grade: '정회원', active: true, note: '', ...m };
    list.push(nm); return nm;
  },
  removeMember(id) { DB.state.members = DB.state.members.filter((m) => m.id !== id); },

  // date-based participation -----------------------------------------
  event(date, content) {
    const day = (DB.state.participation.byDate[date] ||= {});
    return (day[content] ||= []);
  },
  getEvent(date, content) {
    return (DB.state.participation.byDate[date] || {})[content] || [];
  },
  setEventMembers(date, content, ids) {
    const day = (DB.state.participation.byDate[date] ||= {});
    const arr = [...new Set(ids.map(Number))];
    if (arr.length) day[content] = arr; else { delete day[content]; if (!Object.keys(day).length) delete DB.state.participation.byDate[date]; }
  },
  addEventMembers(date, content, ids) {
    const cur = this.getEvent(date, content);
    this.setEventMembers(date, content, [...cur, ...ids.map(Number)]);
  },
  toggleEventMember(date, content, id) {
    const cur = new Set(this.getEvent(date, content));
    cur.has(+id) ? cur.delete(+id) : cur.add(+id);
    this.setEventMembers(date, content, [...cur]);
  },
  removeEventMember(date, content, id) {
    this.setEventMembers(date, content, this.getEvent(date, content).filter((x) => x !== +id));
  },
  dateSummary(date) {
    const day = DB.state.participation.byDate[date] || {};
    const out = {}; for (const c of Object.keys(day)) out[c] = day[c].length; return out;
  },
  datesWithData() { return Object.keys(DB.state.participation.byDate).sort(); },

  // distribution log -------------------------------------------------
  logDistribution(entry) {
    DB.state.distributionLog.unshift({ id: uid(), date: entry.date || '', ...entry });
  },

  // diamond settlements (다이아 분배 확정) ---------------------------
  recordSettlement(rec) {
    DB.state.settlements.unshift({
      id: uid(), date: rec.date || '', from: rec.from || '', to: rec.to || '',
      total: rec.total || 0, distributed: rec.distributed || 0, entries: rec.entries || [],
    });
  },
  removeSettlement(id) { DB.state.settlements = DB.state.settlements.filter((x) => x.id !== id); },
  resetScores() { DB.state.members.forEach((m) => { m.score = 0; }); },

  // QA reports -------------------------------------------------------
  addQaReport(report) {
    const list = (DB.state.qaReports ||= []);
    const now = nowIso();
    const rec = normalizeQaReport({
      ...report,
      id: uid(),
      slot: nextQaSlot(list),
      status: 'open',
      createdAt: now,
      updatedAt: now,
    });
    list.unshift(rec);
    return rec;
  },
  updateQaReport(idOrSlot, patch = {}) {
    const list = (DB.state.qaReports ||= []);
    const rec = list.find((r) => r.id === idOrSlot || r.slot === idOrSlot);
    if (!rec) return null;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      rec[k] = v == null ? '' : v;
    }
    rec.status = normalizeQaStatus(rec.status);
    rec.severity = normalizeQaSeverity(rec.severity);
    rec.updatedAt = nowIso();
    if (['resolved', 'closed'].includes(rec.status) && !rec.resolvedAt) rec.resolvedAt = rec.updatedAt;
    return rec;
  },
  removeQaReport(idOrSlot) {
    DB.state.qaReports = (DB.state.qaReports || []).filter((r) => r.id !== idOrSlot && r.slot !== idOrSlot);
  },
};
