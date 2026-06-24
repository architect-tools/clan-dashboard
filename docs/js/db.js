// db.js — single source of truth + persistence adapter.
//   • standalone mode (no APPS_SCRIPT_URL): state lives in localStorage,
//     seeded from data/seed.json on first run.
//   • live mode: state is fetched from / saved to the Apps Script backend.
// Views read DB.state, mutate via the helpers, then call DB.commit().

import { CONFIG } from './config.js';
import { uid, toast } from './util.js';

const LIVE = () => !!CONFIG.APPS_SCRIPT_URL;

export const DB = {
  state: null,
  _subs: new Set(),
  _saveTimer: null,

  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); },
  _emit() { for (const fn of this._subs) try { fn(this.state); } catch (e) { console.error(e); } },

  async init() {
    let data;
    if (LIVE()) {
      try { data = await this._fetch('getAll'); }
      catch (e) { console.error('backend load failed, falling back to local', e); toast('백엔드 연결 실패 — 로컬 모드로 표시', 'error'); }
    }
    if (!data) {
      const raw = localStorage.getItem(CONFIG.STORE_KEY);
      if (raw) { try { data = JSON.parse(raw); } catch {} }
    }
    if (!data) data = await (await fetch('data/seed.json', { cache: 'no-store' })).json();
    this.state = normalize(data);
    if (!LIVE()) this._persistLocal();
    this._emit();
    return this.state;
  },

  /** Persist current state (debounced). In live mode also pushes to backend. */
  commit({ immediate = false } = {}) {
    this._persistLocal();
    this._emit();
    if (LIVE()) {
      clearTimeout(this._saveTimer);
      const doSave = () => this._fetch('save', { data: this.state })
        .then(() => {}).catch((e) => { console.error(e); toast('동기화 실패 (변경은 로컬에 보관됨)', 'error'); });
      if (immediate) doSave(); else this._saveTimer = setTimeout(doSave, 1200);
    }
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

  // ── OCR (backend Naver CLOVA, or client Tesseract fallback) ──────
  async ocr(base64png) {
    if (LIVE()) {
      try {
        const r = await this._fetch('ocr', { image: base64png });
        if (r && r.lines) return r.lines;
      } catch (e) { console.warn('backend OCR failed, trying client OCR', e); }
    }
    return null; // signal caller to use client-side Tesseract
  },
};

// ── state normalization / migration ─────────────────────────────────
function normalize(d) {
  d = d || {};
  d.meta ||= { clanName: '불면증', schemaVersion: 1 };
  d.settings ||= { totalDiamonds: 170000, staffRatio: 0.05, powerRatio: 0.40, participationRatio: 0.55 };
  d.tiers ||= [];
  d.powerRanks ||= [];
  d.staff ||= [];
  d.members = (d.members || []).map((m, i) => ({
    id: m.id || i + 1, order: m.order ?? i + 1, name: m.name || '',
    cls: m.cls || '', power: +m.power || 0, score: +m.score || 0,
    active: m.active !== false, note: m.note || '',
  }));
  d.contentCatalog ||= [];
  d.rotationQueues ||= [];
  d.weaponProgress ||= [];

  // participation: { weeks:[{id,label,from,to}], current, data:{ [weekId]:{ [memberId]:{ [content]:count } } } }
  d.participation ||= {};
  d.participation.weeks ||= [];
  d.participation.data ||= {};
  if (!d.participation.weeks.length) {
    const wid = uid();
    d.participation.weeks.push({ id: wid, label: '이번 주', from: '', to: '' });
    d.participation.current = wid;
    d.participation.data[wid] = {};
  }
  d.participation.current ||= d.participation.weeks[0].id;

  d.distributionLog ||= [];
  d.schedule ||= [];
  return d;
}

// ── mutation helpers (operate on DB.state; caller commits) ──────────
export const Mutations = {
  upsertMember(m) {
    const list = DB.state.members;
    if (m.id) {
      const i = list.findIndex((x) => x.id === m.id);
      if (i >= 0) { list[i] = { ...list[i], ...m }; return list[i]; }
    }
    const nm = { id: Math.max(0, ...list.map((x) => x.id)) + 1, order: list.length + 1,
      name: '', cls: '', power: 0, score: 0, active: true, note: '', ...m };
    list.push(nm); return nm;
  },
  removeMember(id) { DB.state.members = DB.state.members.filter((m) => m.id !== id); },

  weekData(weekId = DB.state.participation.current) {
    return (DB.state.participation.data[weekId] ||= {});
  },
  setAttendance(memberId, content, count, weekId = DB.state.participation.current) {
    const wd = this.weekData(weekId);
    const mk = (wd[memberId] ||= {});
    if (count > 0) mk[content] = count; else delete mk[content];
  },
  bumpAttendance(memberId, content, delta = 1, weekId) {
    const wd = this.weekData(weekId);
    const mk = (wd[memberId] ||= {});
    mk[content] = Math.max(0, (mk[content] || 0) + delta);
    if (!mk[content]) delete mk[content];
    return mk[content] || 0;
  },
  addWeek(label) {
    const id = uid();
    DB.state.participation.weeks.unshift({ id, label: label || '새 주차', from: '', to: '' });
    DB.state.participation.data[id] = {};
    DB.state.participation.current = id;
    return id;
  },
  logDistribution(entry) {
    DB.state.distributionLog.unshift({ id: uid(), date: entry.date || '', ...entry });
  },
};
