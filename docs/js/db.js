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
  _maxHistory: 80,
  _onHistory: null,        // () => update undo/redo button states
  _onRefresh: null,        // () => re-render current view (after undo/redo)

  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); },
  _emit() { for (const fn of this._subs) try { fn(this.state); } catch (e) { console.error(e); } },
  setCallbacks({ onHistory, onRefresh }) { this._onHistory = onHistory; this._onRefresh = onRefresh; },

  async init() {
    let data, fromBackend = false;
    if (LIVE()) {
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
    const doSave = () => this._fetch('save', { data: this.state })
      .catch((e) => { console.error(e); toast('동기화 실패 (변경은 로컬에 보관됨)', 'error'); });
    if (immediate) doSave(); else this._saveTimer = setTimeout(doSave, 1200);
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

  async _fetch(action, payload) {
    const url = CONFIG.APPS_SCRIPT_URL;
    const token = localStorage.getItem(CONFIG.TOKEN_KEY) || '';
    const opts = payload
      ? { method: 'POST', body: JSON.stringify({ action, token, ...payload }),
          headers: { 'Content-Type': 'text/plain;charset=utf-8' } } // text/plain avoids CORS preflight
      : { method: 'GET' };
    const u = payload ? url : `${url}?action=${encodeURIComponent(action)}&token=${encodeURIComponent(token)}`;
    const res = await fetch(u, opts);
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    return json.data;
  },
};

// 장비 슬롯명 운영 시트 기준으로 교정(기존 데이터 키 이동, 값 보존)
const EQUIP_RENAME = { '무기': '주무기', '보조무기1': '보조1', '보조무기2': '보조2', '흉갑': '상의', '각반': '하의', '허리띠': '벨트' };
function migrateEquip(eq) {
  const out = { ...(eq || {}) };
  for (const [o, n] of Object.entries(EQUIP_RENAME)) {
    if (out[o] != null && out[n] == null) { out[n] = out[o]; delete out[o]; }
  }
  return out;
}

// ── state normalization / migration ─────────────────────────────────
function normalize(d) {
  d = d || {};
  d.meta ||= { clanName: '불면증', schemaVersion: 2 };
  d.appSettings ||= {};                                  // site-wide app prefs (UI scale 등)
  if (d.appSettings.uiScale == null) d.appSettings.uiScale = 1;
  d.settings ||= { totalDiamonds: 170000, staffRatio: 0.05, powerRatio: 0.40, participationRatio: 0.55 };
  d.tiers ||= [];
  d.powerRanks ||= [];
  d.staff ||= [];
  d.members = (d.members || []).map((m, i) => ({
    id: m.id || i + 1, order: m.order ?? i + 1, name: m.name || '',
    cls: m.cls || '', power: +m.power || 0, score: +m.score || 0,
    grade: m.grade || '정회원',        // 등급(멤버십): 운영진/정회원/준회원/신입
    equip: migrateEquip(m.equip),      // 장착 장비: {슬롯: {star,tier,enhance}} (슬롯명 시트 기준)
    active: m.active !== false, note: m.note || '',
  }));
  d.contentCatalog ||= [];
  // 콘텐츠 카테고리 보정: 앙그바르 투기장·클랜 원정대는 '클랜 활동'으로 분리(기존 데이터도 교정)
  for (const c of d.contentCatalog) if (c && (c.name === '앙그바르 투기장' || c.name === '클랜 원정대')) c.category = '클랜 활동';
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
  d.dropLog ||= [];     // 드랍 기록: {id, date, content, item, note}
  d.sales ||= [];       // 진행 중 내판: {id, item, bidType, basePrice, deadline(ms), bids:[{name,amount}]}
  d.settlements ||= []; // finalized diamond distributions (다이아 분배 확정 기록)
  d.schedule ||= [];
  d.statusBoards ||= []; // 캐릭터 현황 보드: 주문석/성좌/탈것/엘릭서/플랫폼
  // 관리 보드를 운영 시트 구조로 1회 정비: 부적합 보드 제거(무기 숙련·KDA·통합보드 등) + 분리 카테고리 보장.
  // (장착 장비는 슬롯 그리드+장비 현황 표가 담당하므로 '장비 현황' 보드는 제거)
  if (!d.appSettings._mgmtBoards3) {
    const REMOVE = new Set(['무기 숙련', '장비 현황', '주문석·성좌·탈것', '엘릭서 & 패시브', 'KDA']);
    d.statusBoards = d.statusBoards.filter((b) => b && !REMOVE.has(b.name));
    const have = new Set(d.statusBoards.map((b) => b.name));
    const ensure = [
      { name: '주문석', columns: ['공용', '전투 스탠스', '특화 스탠스'] },
      { name: '성좌', columns: ['바위를 삼키는 괴물', '자유로운 여행자', '바다의 괴물'] },
      { name: '탈것', columns: ['지진발굽', '심연의 수호자', '심연의 환영', '황혼의방랑자'] },
      { name: '엘릭서', columns: ['집중 호흡', '영웅의 기운'] },
      { name: '플랫폼 이용 현황', columns: ['PC', '모바일', '디스코드'] },
    ];
    for (const b of ensure) if (!have.has(b.name)) d.statusBoards.push({ id: uid(), name: b.name, columns: [...b.columns], data: {} });
    d.appSettings._mgmtBoards3 = true;
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
};
