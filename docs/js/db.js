// db.js — single source of truth + persistence adapter + undo/redo history.
//   • standalone mode (no APPS_SCRIPT_URL): state in localStorage, seeded from data/seed.json.
//   • live mode: state fetched from / saved to the Apps Script backend.
// Views read DB.state, mutate via Mutations, then call DB.commit().
// Every commit() creates an undo checkpoint.

import { CONFIG } from './config.js';
import { SupabaseBackend } from './supabase-backend.js';
import { uid, toast } from './util.js';

const APPS_LIVE = () => !!CONFIG.APPS_SCRIPT_URL;
const SUPABASE_LIVE = () => SupabaseBackend.isConfigured();
const REMOTE = () => SUPABASE_LIVE() || APPS_LIVE();
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
  _writeTail: Promise.resolve(), // 모든 POST 쓰기를 한 탭 안에서도 순서대로 전송
  _pendingAtomic: 0,
  _savingTasks: new Map(),
  _savingSeq: 0,
  _backendProfile: null,
  _realtimeTimer: null,
  _maxHistory: 80,
  _onHistory: null,        // () => update undo/redo button states
  _onRefresh: null,        // () => re-render current view (after undo/redo)

  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); },
  _emit() { for (const fn of this._subs) try { fn(this.state); } catch (e) { console.error(e); } },
  setCallbacks({ onHistory, onRefresh, onLoading, onSaving }) {
    this._onHistory = onHistory;
    this._onRefresh = onRefresh;
    this._onLoading = onLoading;
    this._onSaving = onSaving;
  },
  _setLoading(on) {   // 진행 중 네트워크 새로고침 카운터 → UI 로딩 표시(⟳ 버튼 회전 등)
    this._loadingN = Math.max(0, (this._loadingN || 0) + (on ? 1 : -1));
    this._onLoading && this._onLoading(this._loadingN > 0);
  },

  _beginSaving(label = '변경사항 저장 중…') {
    const token = ++this._savingSeq;
    this._savingTasks.set(token, label);
    this._onSaving && this._onSaving(true, label, this._savingTasks.size);
    return token;
  },

  _endSaving(token) {
    this._savingTasks.delete(token);
    const labels = [...this._savingTasks.values()];
    this._onSaving && this._onSaving(labels.length > 0, labels.at(-1) || '', labels.length);
  },

  async init() {
    let data, fromBackend = false;
    if (SUPABASE_LIVE()) {
      try {
        await SupabaseBackend.ensureAnonymousSession();
        this._backendProfile = await SupabaseBackend.profile();
        data = await SupabaseBackend.state();
        fromBackend = !!data;
      } catch (e) {
        console.error('Supabase load failed', e);
        throw new Error('실시간 DB 연결 실패: ' + (e.message || e));
      }
    } else if (APPS_LIVE()) {
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
    if (!REMOTE()) this._persistLocal();
    // 라이브 첫 연결인데 백엔드가 비어 있으면, 로컬/시드 데이터를 클라우드로 1회 이관(데이터 유실 방지)
    else if (!fromBackend && APPS_LIVE()) { try { await this._fetch('save', { data: this.state }); toast('현재 데이터를 클라우드로 옮겼습니다'); } catch (e) { console.warn('초기 이관 실패', e); } }
    this._emit(); this._onHistory && this._onHistory();
    // 13개 시트 병합은 무거우므로 관리자만 수행한다. 멤버는 원자적 변경이 반영된
    // _state 빠른 읽기만 사용해 다수 동시 접속 시 ScriptLock 대기열을 만들지 않는다.
    if (SUPABASE_LIVE() && this._backendProfile?.clanId) {
      await SupabaseBackend.subscribe(this._backendProfile.clanId, (revision) => {
        if (+revision <= +(this.state?.meta?.revision || 0)) return;
        clearTimeout(this._realtimeTimer);
        this._realtimeTimer = setTimeout(() => this.refresh({ force: true }), 80);
      });
    } else if (APPS_LIVE() && fromBackend) {
      this.refresh({ merge: localStorage.getItem(CONFIG.ROLE_KEY) === 'admin' });
    }
    return this.state;
  },

  /** Persist current state + create an undo checkpoint. In live mode pushes to backend. */
  commit({ immediate = false, history = true } = {}) {
    // 라이브 멤버 쓰기는 반드시 atomicAction 을 거쳐야 한다. 숨겨진 관리자 버튼을
    // DOM에서 강제로 실행해도 전체 상태 save 로 다른 사람 데이터를 덮지 못한다.
    if (REMOTE() && localStorage.getItem(CONFIG.ROLE_KEY) !== 'admin') {
      if (this._snapshot) this.state = clone(this._snapshot);
      this._emit(); this._onRefresh && this._onRefresh();
      toast('멤버 변경은 본인 셀 단위 저장만 허용됩니다.', 'error');
      return false;
    }
    if (history && this._snapshot) {
      this._undo.push(this._snapshot);
      if (this._undo.length > this._maxHistory) this._undo.shift();
      this._redo = [];
    }
    this._snapshot = clone(this.state);
    this._persistLocal();
    this._emit();
    this._onHistory && this._onHistory();
    if (REMOTE()) this._scheduleSave(immediate);
    return true;
  },

  /** Replace the complete administrator-managed state, then persist it through the active backend. */
  async importState(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('올바른 대시보드 JSON이 아닙니다.');
    this.state = normalize(clone(data));
    if (!this.commit()) return false;
    return await this.flushSave();
  },

  /** Commit and wait until the active backend confirms persistence. */
  async commitNow({ history = true } = {}) {
    if (!this.commit({ history })) return false;
    return await this.flushSave();
  },

  _queueWrite(task, label = '변경사항 저장 중…') {
    const savingToken = this._beginSaving(label);
    const run = this._writeTail.catch(() => {}).then(task)
      .finally(() => this._endSaving(savingToken));
    this._writeTail = run;
    return run;
  },

  _scheduleSave(immediate) {
    clearTimeout(this._saveTimer);
    this._pendingSave = true;   // 저장 완료 전까지 백그라운드 새로고침이 내 편집을 덮지 않게
    this._saveError = false;
    const doSave = () => {
      const seq = ++this._saveSeq;
      this._savePromise = this._queueWrite(async () => {
        // 실행 시점의 최신 로컬 상태와, 직전 직렬 저장이 반영한 adminRevision을 사용한다.
        const data = clone(this.state);
        const baseAdminRevision = +(this.state.meta?.adminRevision || 0);
        const result = SUPABASE_LIVE()
          ? await SupabaseBackend.save(data, baseAdminRevision)
          : await this._fetch('save', { data, baseAdminRevision });
        if (result) {
          if (result.state && seq === this._saveSeq) {
            this.state = normalize(clone(result.state));
            this._snapshot = clone(this.state);
            this._emit();
          }
          this.state.meta ||= {};
          this.state.meta.revision = Math.max(+(this.state.meta.revision || 0), +(result.revision || 0));
          this.state.meta.adminRevision = Math.max(+(this.state.meta.adminRevision || 0), +(result.adminRevision || 0));
          if (this._snapshot?.meta) {
            this._snapshot.meta.revision = this.state.meta.revision;
            this._snapshot.meta.adminRevision = this.state.meta.adminRevision;
          }
          this._persistLocal();
        }
        return true;
      }, '변경사항 저장 중…').then(() => {
        if (seq === this._saveSeq) { this._pendingSave = false; this._saveError = false; }
        return true;
      }).catch((e) => {
        if (seq === this._saveSeq) { this._pendingSave = false; this._saveError = true; }
        console.error(e); toast(e.message?.startsWith('conflict:') ? e.message.slice(9).trim() : '동기화 실패 (변경은 로컬에 보관됨)', 'error');
        return false;
      });
      return this._savePromise;
    };
    if (immediate) return doSave();
    this._saveTimer = setTimeout(doSave, 1200);
    return null;
  },

  async flushSave() {
    if (!REMOTE() || !this._pendingSave) return true;
    clearTimeout(this._saveTimer);
    return await this._scheduleSave(true);
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
    if (REMOTE()) this._scheduleSave(false);
  },

  _persistLocal() {
    try { localStorage.setItem(CONFIG.STORE_KEY, JSON.stringify(this.state)); }
    catch (e) { console.error('localStorage full?', e); }
  },

  async _fetch(action, payload, query) {
    const url = CONFIG.APPS_SCRIPT_URL;
    const token = localStorage.getItem(CONFIG.TOKEN_KEY) || '';
    const opts = payload
      ? { method: 'POST', body: JSON.stringify({ action, token,
          actor: localStorage.getItem(CONFIG.ME_KEY) || '', role: localStorage.getItem(CONFIG.ROLE_KEY) || 'member', ...payload }),
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
    if (!REMOTE()) {
      const rec = Mutations.addQaReport(report);
      this.commit({ immediate: true });
      return rec;
    }
    if (SUPABASE_LIVE()) {
      const data = await this._queueWrite(
        () => SupabaseBackend.mutate('qa.add', { report }, `qa:${Date.now()}:${uid()}`),
        'QA 리포트 저장 중…',
      );
      if (data?.state) this._mergeAtomicState(data.state);
      return data?.result || report;
    }
    const rec = await this._queueWrite(() => this._fetch('qaAdd', { report }), 'QA 리포트 저장 중…');
    return this._applyQaReport(rec);
  },

  async updateQaReport(idOrSlot, patch = {}) {
    if (!REMOTE()) {
      const rec = Mutations.updateQaReport(idOrSlot, patch);
      this.commit({ immediate: true });
      return rec;
    }
    if (SUPABASE_LIVE()) {
      const data = await this._queueWrite(
        () => SupabaseBackend.mutate('qa.update', { idOrSlot, patch }, `qa:${Date.now()}:${uid()}`),
        'QA 리포트 저장 중…',
      );
      if (data?.state) this._mergeAtomicState(data.state);
      return data?.result;
    }
    const rec = await this._queueWrite(() => this._fetch('qaUpdate', { idOrSlot, patch }), 'QA 리포트 저장 중…');
    return this._applyQaReport(rec);
  },

  async removeQaReport(idOrSlot) {
    if (!REMOTE()) {
      Mutations.removeQaReport(idOrSlot);
      this.commit({ immediate: true });
      return true;
    }
    if (SUPABASE_LIVE()) {
      const data = await this._queueWrite(
        () => SupabaseBackend.mutate('qa.delete', { idOrSlot }, `qa:${Date.now()}:${uid()}`),
        'QA 리포트 삭제 중…',
      );
      if (data?.state) this._mergeAtomicState(data.state);
      return true;
    }
    await this._queueWrite(() => this._fetch('qaDelete', { idOrSlot }), 'QA 리포트 삭제 중…');
    this.state.qaReports = (this.state.qaReports || []).filter((r) => r.id !== idOrSlot && r.slot !== idOrSlot);
    this._snapshot = clone(this.state);
    this._persistLocal();
    this._emit();
    return true;
  },

  _mergeAtomicState(remote) {
    const next = normalize(clone(remote));
    const localMembers = new Map((this.state.members || []).map((m) => [String(m.id), m]));
    for (const rm of next.members || []) {
      const lm = localMembers.get(String(rm.id));
      if (!lm) continue;
      lm.equip ||= {}; lm.skills ||= {};
      for (const k of Object.keys(lm.equip)) delete lm.equip[k];
      Object.assign(lm.equip, clone(rm.equip || {}));
      for (const k of Object.keys(lm.skills)) delete lm.skills[k];
      Object.assign(lm.skills, clone(rm.skills || {}));
    }
    const localBoards = new Map((this.state.statusBoards || []).map((b) => [String(b.id), b]));
    for (const rb of next.statusBoards || []) {
      const lb = localBoards.get(String(rb.id));
      if (!lb) continue;
      lb.data ||= {};
      for (const k of Object.keys(lb.data)) delete lb.data[k];
      Object.assign(lb.data, clone(rb.data || {}));
    }
    this.state.sales = clone(next.sales || []);
    this.state.distributionLog = clone(next.distributionLog || []);
    this.state.qaReports = clone(next.qaReports || []);
    this.state.meta = clone(next.meta || this.state.meta || {});
    this._snapshot = clone(this.state);
    this._persistLocal(); this._emit();
  },

  /** 서버가 최신 상태를 잠근 뒤 멤버 셀/입찰 한 건만 적용한다. */
  async atomicAction(kind, payload = {}) {
    const actor = localStorage.getItem(CONFIG.ME_KEY) || '';
    const role = localStorage.getItem(CONFIG.ROLE_KEY) || 'member';
    const mutationId = `${actor || 'anon'}:${Date.now()}:${uid()}`;
    if (!REMOTE()) {
      try {
        const result = applyAtomicAction(this.state, kind, payload, { actor, role });
        this.commit();
        return { ok: true, result };
      } catch (e) { toast(e.message || '변경 실패', 'error'); return { ok: false, error: e.message }; }
    }
    this._pendingAtomic++;
    const run = async () => {
      if (this._pendingSave) {
        const saved = await this.flushSave();
        if (!saved) throw new Error('먼저 진행 중인 저장을 완료하지 못했습니다.');
      }
      const data = await this._queueWrite(() => SUPABASE_LIVE()
        ? SupabaseBackend.mutate(kind, payload, mutationId)
        : this._fetch('mutate', { actor, role, kind, payload, mutationId }), '변경사항 저장 중…');
      if (data?.state) this._mergeAtomicState(data.state);
      return { ok: true, result: data?.result, duplicate: !!data?.duplicate };
    };
    try { return await run(); }
    catch (e) { console.error(e); toast(e.message || '변경 실패', 'error'); return { ok: false, error: e.message }; }
    finally { this._pendingAtomic = Math.max(0, this._pendingAtomic - 1); }
  },

  // 백그라운드 새로고침: 다른 사용자/시트 변경을 반영. merge=true 면 시트 편집까지(느림), false 면 대시보드 편집만(빠름).
  // 내 미저장 편집(_pendingSave)·열린 모달 중에는 스킵(클로버/방해 방지). 데이터 동일하면 재렌더 안 함.
  // 반환: 'busy'(편집/모달 중 스킵) · true(갱신함) · false(이미 최신) · 'stale'/'error'. 수동 버튼이 피드백에 사용.
  refresh({ merge = false, force = false } = {}) {
    if (!REMOTE() || this._pendingAtomic || (!force && this._pendingSave)) return Promise.resolve('busy');
    if (!force && this._saveError) return Promise.resolve('save-error');
    if (typeof document !== 'undefined' && document.querySelector('.modal-overlay')) return Promise.resolve('busy');
    const token = ++this._loadToken;
    const saveSeqAtStart = this._saveSeq;   // 조회 중 내가 편집·저장하면 시퀀스가 바뀜 → 옛 응답 폐기(편집 되돌림 방지)
    this._setLoading(true);
    const request = SUPABASE_LIVE()
      ? SupabaseBackend.state()
      : this._fetch('getAll', null, merge ? { merge: 1 } : undefined);
    return request.then((data) => {
      if (!data || token !== this._loadToken || this._pendingSave || saveSeqAtStart !== this._saveSeq) return 'stale';
      const next = normalize(data);
      this._saveError = false; // 수동 강제 새로고침으로 충돌/저장 오류 상태 복구
      if (JSON.stringify(next) === JSON.stringify(this.state)) return false;
      this.state = next; this._snapshot = clone(this.state);
      this._persistLocal(); this._emit(); this._onRefresh && this._onRefresh();
      return true;
    }).catch((e) => { console.error(e); return 'error'; }).finally(() => this._setLoading(false));
  },
};

// 장비 슬롯명 운영 시트 기준으로 교정(기존 데이터 키 이동, 값 보존)
const EQUIP_RENAME = { '무기': '주무기', '보조무기1': '보조1', '보조무기2': '보조2', '흉갑': '상의', '각반': '하의', '허리띠': '벨트' };
const MEMBER_RENAME = { '도베르만': 'Doberman', '페커리': '냉정', '여신민아': '망듕땅', '권성준': '귄성준' };
const MEMBER_CLASS_OVERRIDES = { '해지슬': '사냥꾼', 'v구름v': '마법사' };

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
  const d = new Date();
  const time = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}${String(d.getMilliseconds()).padStart(3, '0')}`;
  const taken = new Set((reports || []).map((r) => r && r.slot).filter(Boolean));
  let slot = '';
  do {
    slot = `QA-${qaDayKey(d)}-${time}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  } while (taken.has(slot));
  return slot;
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
    type: r.type === 'improvement' ? 'improvement' : 'bug',
    status: normalizeQaStatus(r.status),
    severity: normalizeQaSeverity(r.severity),
    automationStatus: String(r.automationStatus || (r.status === 'open' ? 'queued' : '')),
    automationAttempt: Math.max(0, Number(r.automationAttempt) || 0),
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
    automationStartedAt: String(r.automationStartedAt || ''),
    automationCompletedAt: String(r.automationCompletedAt || ''),
    automationBranch: String(r.automationBranch || ''),
    automationCommit: String(r.automationCommit || ''),
    automationWorktree: String(r.automationWorktree || ''),
  };
}

// ── state normalization / migration ─────────────────────────────────
function normalize(d) {
  d = d || {};
  d.meta ||= { clanName: '불면증', schemaVersion: 2 };
  d.meta.revision = +d.meta.revision || 0;
  d.meta.adminRevision = +d.meta.adminRevision || 0;
  d.appSettings ||= {};                                  // site-wide app prefs (UI scale 등)
  if (d.appSettings.uiScale == null) d.appSettings.uiScale = 1;
  d.appSettings.managedStones ||= [];                    // 관리할 공용 주문석 [{name, star}]
  d.settings ||= { totalDiamonds: 170000, staffRatio: 0.05, powerRatio: 0.40, participationRatio: 0.55 };
  d.tiers ||= [];
  d.powerRanks ||= [];
  d.staff ||= [];
  d.staff = d.staff.map((st) => ({ ...st, name: migrateMemberName(st.name) }));
  d.members = (d.members || []).map((m, i) => {
    const name = migrateMemberName(m.name);
    return {
      id: m.id || i + 1, order: m.order ?? i + 1, name,
      cls: MEMBER_CLASS_OVERRIDES[name] || m.cls || '', power: +m.power || 0, score: +m.score || 0,
      grade: m.grade || '정회원',        // 등급(멤버십): 운영진/정회원/준회원/신입
      equip: migrateEquip(m.equip),      // 장착 장비: {슬롯: {star,tier,enhance}} (슬롯명 시트 기준)
      skills: m.skills || {},            // 주문석/엘릭서: { 주문석:{스킬:값}, 엘릭서:{항목:값} }
      active: m.active !== false, note: m.note || '',
    };
  });
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

function atomicMemberLocal(state, payload, { actor, role }) {
  const member = (state.members || []).find((m) => payload.memberId != null
    ? String(m.id) === String(payload.memberId)
    : m.name === (payload.memberName || actor));
  if (!member) throw new Error('멤버를 찾을 수 없습니다.');
  if (role !== 'admin' && member.name !== actor) throw new Error('본인 데이터만 변경할 수 있습니다.');
  return member;
}
function atomicKeyLocal(value, label) {
  const key = String(value || '').trim();
  if (!key || key.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`잘못된 ${label || '키'}입니다.`);
  return key;
}

/** Standalone-mode equivalent of the server's locked mutation engine. */
export function applyAtomicAction(state, kind, payload = {}, context = {}) {
  const role = context.role === 'admin' ? 'admin' : 'member';
  const actor = String(context.actor || '').trim();
  const requireAdmin = () => { if (role !== 'admin') throw new Error('관리자만 변경할 수 있습니다.'); };
  const saleOf = (id) => {
    const sale = (state.sales || []).find((x) => String(x.id) === String(id));
    if (!sale) throw new Error('내판을 찾을 수 없습니다.');
    sale.bids ||= [];
    return sale;
  };
  state.sales ||= []; state.statusBoards ||= [];
  if (kind === 'equipment.set') {
    const m = atomicMemberLocal(state, payload, { actor, role });
    const slot = atomicKeyLocal(payload.slot, '슬롯');
    const valid = new Set(['주무기','보조1','보조2','투구','견갑','상의','하의','벨트','장갑','신발','망토','목걸이','귀걸이','반지','팔찌','복종','충성','무한','심연']);
    if (!valid.has(slot)) throw new Error('잘못된 장비 슬롯입니다.');
    m.equip ||= {};
    const raw = payload.value || null;
    let value = null;
    if (raw && ['복종','충성','무한','심연'].includes(slot)) {
      const tier = Math.max(0, Math.min(20, Math.floor(+raw.tier || 0)));
      if (tier) value = { tier };
    } else if (raw) {
      const star = Math.max(0, Math.min(6, Math.floor(+raw.star || 0)));
      const tier = Math.max(0, Math.min(20, +raw.tier || 0));
      const enhance = Math.max(0, Math.min(99, Math.floor(+raw.enhance || 0)));
      if (star || tier || enhance) value = { star, tier, enhance };
    }
    if (value) m.equip[slot] = value; else delete m.equip[slot];
    return { member: m, slot, value };
  }
  if (kind === 'skill.toggle') {
    const m = atomicMemberLocal(state, payload, { actor, role });
    if (!['주문석', '엘릭서'].includes(payload.category)) throw new Error('잘못된 스킬 분류입니다.');
    const key = atomicKeyLocal(payload.key, '스킬');
    m.skills ||= {}; const bag = (m.skills[payload.category] ||= {});
    const on = !bag[key]; if (on) bag[key] = true; else delete bag[key];
    return { member: m, category: payload.category, key, on };
  }
  if (kind === 'skill.adjust') {
    const m = atomicMemberLocal(state, payload, { actor, role });
    const key = atomicKeyLocal(payload.key, '스킬');
    m.skills ||= {}; const bag = (m.skills['공용주문석'] ||= {});
    const count = Math.max(0, Math.min(99, (+bag[key] || 0) + ((+payload.delta || 0) < 0 ? -1 : 1)));
    if (count) bag[key] = count; else delete bag[key];
    return { member: m, category: '공용주문석', key, count };
  }
  if (kind === 'board.toggle') {
    const m = atomicMemberLocal(state, payload, { actor, role });
    const board = state.statusBoards.find((b) => String(b.id) === String(payload.boardId));
    if (!board) throw new Error('보드를 찾을 수 없습니다.');
    const column = atomicKeyLocal(payload.column, '열');
    if (!(board.columns || []).includes(column)) throw new Error('보드 열을 찾을 수 없습니다.');
    board.data ||= {}; const rec = (board.data[String(m.id)] ||= {});
    const on = !rec[column]; if (on) rec[column] = true; else delete rec[column];
    if (!Object.keys(rec).length) delete board.data[String(m.id)];
    return { member: m, board, column, on };
  }
  if (kind === 'sale.create') {
    requireAdmin();
    const sale = { id: payload.id || uid(), item: atomicKeyLocal(payload.item, '아이템'),
      bidType: ['투력순','참여도순','경매','선착순'].includes(payload.bidType) ? payload.bidType : '투력순',
      basePrice: Math.max(0, +payload.basePrice || 0), deadline: +payload.deadline || Date.now() + 3600000, bids: [] };
    if (state.sales.some((x) => String(x.id) === String(sale.id))) throw new Error('이미 존재하는 내판입니다.');
    state.sales.unshift(sale); return { sale };
  }
  if (kind === 'sale.bid') {
    const sale = saleOf(payload.saleId);
    if (+sale.deadline && +sale.deadline < Date.now()) throw new Error('마감된 내판입니다.');
    const m = atomicMemberLocal(state, payload, { actor, role });
    if (sale.bids.some((b) => b.name === m.name)) throw new Error('이미 입찰했습니다.');
    const bid = { name: m.name, amount: sale.bidType === '경매' ? Math.max(0, +payload.amount || 0) : 0 };
    sale.bids.push(bid); return { sale, bid };
  }
  if (kind === 'sale.cancelBid') {
    const sale = saleOf(payload.saleId);
    const m = role === 'admin' ? null : atomicMemberLocal(state, payload, { actor, role });
    const memberName = role === 'admin' ? atomicKeyLocal(payload.memberName, '멤버') : m.name;
    const before = sale.bids.length; sale.bids = sale.bids.filter((b) => b.name !== memberName);
    if (before === sale.bids.length) throw new Error('입찰 내역이 없습니다.');
    return { sale, member: m, memberName };
  }
  if (kind === 'sale.cancel') {
    requireAdmin(); saleOf(payload.saleId);
    state.sales = state.sales.filter((x) => String(x.id) !== String(payload.saleId)); return { saleId: payload.saleId };
  }
  if (kind === 'sale.close') {
    requireAdmin(); const sale = saleOf(payload.saleId);
    if (!sale.bids.length) throw new Error('입찰자가 없습니다.');
    const byName = Object.fromEntries((state.members || []).map((m) => [m.name, m]));
    const ranked = [...sale.bids];
    if (sale.bidType === '투력순') ranked.sort((a, b) => (byName[b.name]?.power || 0) - (byName[a.name]?.power || 0));
    else if (sale.bidType === '참여도순') ranked.sort((a, b) => (byName[b.name]?.score || 0) - (byName[a.name]?.score || 0));
    else if (sale.bidType === '경매') ranked.sort((a, b) => (+b.amount || 0) - (+a.amount || 0));
    const winner = ranked[0], price = sale.bidType === '경매' ? (+winner.amount || 0) : (+sale.basePrice || 0);
    const date = new Date().toISOString().slice(0, 10);
    state.distributionLog ||= [];
    state.distributionLog.unshift({ id: uid(), date, item: sale.item, type: '내판', member: winner.name, from: '', price, note: sale.bidType });
    state.sales = state.sales.filter((x) => String(x.id) !== String(sale.id));
    return { saleId: sale.id, winner, price, bidType: sale.bidType, item: sale.item };
  }
  throw new Error(`알 수 없는 원자적 변경: ${kind}`);
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
