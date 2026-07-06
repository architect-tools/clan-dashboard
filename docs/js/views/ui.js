// ui.js — shared view components.
import { el, clear, $, normName } from '../util.js';
import { classColor, TIER_COLORS } from '../config.js';

export const app = () => document.getElementById('app');

/** Standard page scaffold; returns the body element to append into. */
export function page(title, { subtitle, actions } = {}) {
  const body = el('div.page-body');
  const head = el('div.page-head', {}, [
    el('div', {}, [
      el('h2.page-title', { text: title }),
      subtitle ? el('p.page-sub', { text: subtitle }) : null,
    ]),
    actions ? el('div.page-actions', {}, [].concat(actions)) : null,
  ]);
  const root = clear(app());
  root.appendChild(el('div.page', {}, [head, body]));
  return body;
}

export function card(title, children, { className = '', actions } = {}) {
  return el('div.card', { class: className }, [
    title ? el('div.card-head', {}, [
      el('h3.card-title', { text: title }),
      actions ? el('div.card-actions', {}, [].concat(actions)) : null,
    ]) : null,
    el('div.card-body', {}, [].concat(children)),
  ]);
}

export function statCard(label, value, { sub, color, icon } = {}) {
  return el('div.stat', {}, [
    icon ? el('div.stat-icon', { text: icon, style: color ? { color } : {} }) : null,
    el('div.stat-main', {}, [
      el('div.stat-value', { text: value, style: color ? { color } : {} }),
      el('div.stat-label', { text: label }),
      sub ? el('div.stat-sub', { text: sub }) : null,
    ]),
  ]);
}

export function btn(text, onclick, { kind = '', icon, title, admin = false } = {}) {
  // class via el()'s `class` attr — el()'s tag parser rejects spaces, so a
  // `button.btn btn-primary` tag string would silently fall back to a classless
  // <div> (looks like text, no pointer cursor). Keep the tag space-free.
  // admin:true → .admin-only (멤버 역할에서 CSS로 숨김).
  const cls = [kind ? 'btn-' + kind : '', admin ? 'admin-only' : ''].filter(Boolean).join(' ');
  return el('button.btn', { class: cls, onclick, title: title || text, type: 'button' }, [
    icon ? el('span.btn-icon', { text: icon }) : null, text,
  ]);
}

export function classBadge(cls) {
  return el('span.badge.class-badge', { style: { '--c': classColor(cls) }, text: cls || '-' });
}
export function tierBadge(tier) {
  return el('span.badge.tier-badge', { style: { '--c': TIER_COLORS[tier] || '#94a3b8' }, text: tier || '-' });
}

/** Sortable/clean table. cols: [{key,label,render?,align?,width?}], rows: objects */
export function table(cols, rows, { onRow, empty = '데이터 없음' } = {}) {
  const wrap = el('div.table-wrap');
  if (!rows.length) { wrap.appendChild(el('div.empty', { text: empty })); return wrap; }
  const t = el('table.tbl');
  t.appendChild(el('thead', {}, el('tr', {}, cols.map((c) =>
    el('th', { style: { textAlign: c.align || 'left', width: c.width || '' } },
      c.label instanceof Node ? [c.label] : [String(c.label ?? '')])))));
  const tb = el('tbody');
  rows.forEach((r, i) => {
    const tr = el('tr', onRow ? { onclick: () => onRow(r, i) } : {});
    if (onRow) tr.classList.add('clickable');
    cols.forEach((c) => {
      const cell = c.render ? c.render(r, i) : r[c.key];
      tr.appendChild(el('td', { style: { textAlign: c.align || 'left' } },
        cell instanceof Node ? [cell] : [String(cell ?? '')]));
    });
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  wrap.appendChild(t);
  return wrap;
}

/** Modal dialog. Returns {close}. content is a node or (close)=>node. */
export function modal(title, content, { onClose, wide, headerActions } = {}) {
  const close = () => { overlay.remove(); onClose && onClose(); };
  const body = typeof content === 'function' ? content(close) : content;
  // header actions render in the sticky header, left of the ✕ (always reachable)
  const acts = headerActions ? [].concat(typeof headerActions === 'function' ? headerActions(close) : headerActions).filter(Boolean) : [];
  const widthCls = wide === 'x' ? '.modal-xwide' : wide ? '.modal-wide' : '';
  const overlay = el('div.modal-overlay', { onmousedown: (e) => { if (e.target === overlay && !document.querySelector('.combo.open')) close(); } }, [
    el('div.modal' + widthCls, {}, [
      el('div.modal-head', {}, [
        el('h3', { text: title }),
        el('div.modal-head-right', {}, [...acts, el('button.modal-x', { text: '✕', onclick: close })]),
      ]),
      el('div.modal-body', {}, [body]),
    ]),
  ]);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  return { close, overlay };
}

export function confirmDialog(message, onYes, { yesText = '확인', danger } = {}) {
  modal('확인', (close) => el('div', {}, [
    el('p.confirm-msg', { text: message }),
    el('div.modal-actions', {}, [
      btn('취소', close),
      btn(yesText, () => { close(); onYes(); }, { kind: danger ? 'danger' : 'primary' }),
    ]),
  ]));
}

/** Full-screen busy overlay with a CSS spinner for long async work (engine load,
 *  OCR). Non-dismissable. Returns { update(text, sub), close() }. */
export function busyOverlay(text = '처리 중…', sub = '') {
  const tEl = el('div.busy-text', { text });
  const sEl = el('div.busy-sub', { text: sub });
  const overlay = el('div.busy-overlay', {}, [
    el('div.busy-card', {}, [el('div.busy-spinner'), tEl, sEl]),
  ]);
  document.body.appendChild(overlay);
  return {
    update(t, s) { if (t != null) tEl.textContent = t; if (s != null) sEl.textContent = s; },
    close() { overlay.remove(); },
  };
}

/** Labeled form field. */
export function field(label, input) {
  return el('label.field', {}, [el('span.field-label', { text: label }), input]);
}
export function input(attrs = {}) { return el('input.input', attrs); }
export function select(options, value, attrs = {}) {
  const s = el('select.input', attrs);
  for (const o of options) {
    const opt = typeof o === 'string' ? { value: o, label: o } : o;
    s.appendChild(el('option', { value: opt.value, text: opt.label, selected: String(opt.value) === String(value) }));
  }
  return s;
}

function comboOptions(options) {
  return (options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
    .filter((o) => o && o.value != null)
    .map((o) => ({ value: String(o.value), label: String(o.label ?? o.value) }));
}
function comboMatchText(s) {
  return (normName(s) || String(s || '').toLowerCase());
}

function comboBase(options, value, attrs = {}, { allowCustom = false } = {}) {
  const opts = comboOptions(options);
  const {
    placeholder = allowCustom ? '검색 또는 입력' : '검색',
    max = 8,
    class: cls = '',
    style,
    onchange,
    oninput,
    ...rest
  } = attrs;
  let selected = opts.find((o) => String(o.value) === String(value));
  let open = false;
  let hi = -1;
  let filtered = [];
  let menuObserver = null;

  const root = el('div.combo.input', { ...rest, class: cls, style });
  const search = el('input.combo-search', {
    value: selected ? selected.label : String(value ?? ''),
    placeholder,
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const toggle = el('button.combo-toggle', { type: 'button', text: '▾', title: '열기/닫기' });
  const menu = el('div.combo-menu');
  root.append(search, toggle);

  const valueOfText = () => {
    const exact = opts.find((o) => o.label === search.value || o.value === search.value);
    if (exact) return exact.value;
    if (allowCustom) return search.value;
    return filtered[0]?.value ?? search.value;
  };
  Object.defineProperty(root, 'value', {
    get: valueOfText,
    set(v) { setValue(v, false); },
  });
  root.focus = () => search.focus();

  function dispatch(type) {
    const Evt = (typeof window !== 'undefined' && window.Event) || Event;
    root.dispatchEvent(new Evt(type, { bubbles: true }));
    if (type === 'input' && typeof oninput === 'function') oninput({ target: root, currentTarget: root });
    if (type === 'change' && typeof onchange === 'function') onchange({ target: root, currentTarget: root });
  }
  function setValue(v, notify = true) {
    selected = opts.find((o) => String(o.value) === String(v) || o.label === String(v));
    search.value = selected ? selected.label : String(v ?? '');
    if (notify) dispatch('change');
  }
  function score(o, q, raw) {
    const label = comboMatchText(o.label);
    const val = comboMatchText(o.value);
    const hay = `${label} ${val}`;
    if (!q) return 1;
    if (label === q || val === q) return 100;
    if (label.startsWith(q) || val.startsWith(q)) return 80;
    if (hay.includes(q)) return 60;
    return o.label.toLowerCase().includes(raw) ? 40 : 0;
  }
  function updateFiltered() {
    const raw = search.value.trim().toLowerCase();
    const q = comboMatchText(search.value);
    filtered = opts
      .map((o) => ({ ...o, _score: score(o, q, raw) }))
      .filter((o) => !q || o._score > 0)
      .sort((a, b) => (b._score - a._score) || a.label.localeCompare(b.label, 'ko'))
      .slice(0, max);
    hi = filtered.length ? Math.max(0, Math.min(hi, filtered.length - 1)) : -1;
  }
  function positionMenu() {
    if (!open || !menu.isConnected) return;
    const r = root.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.width = `${Math.max(180, r.width)}px`;
  }
  function renderMenu() {
    updateFiltered();
    clear(menu);
    if (!filtered.length) {
      menu.appendChild(el('div.combo-empty', { text: allowCustom ? '기존 항목 없음' : '검색 결과 없음' }));
    } else {
      filtered.forEach((o, i) => menu.appendChild(el('button.combo-opt', {
        type: 'button',
        class: i === hi ? 'active' : '',
        text: o.label,
        onmousedown: (e) => e.preventDefault(),
        onclick: () => { setValue(o.value); closeMenu(); },
      })));
    }
    positionMenu();
  }
  function openMenu() {
    if (open) return;
    open = true;
    root.classList.add('open');
    toggle.textContent = '▴';
    document.body.appendChild(menu);
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    if (typeof MutationObserver !== 'undefined') {
      menuObserver = new MutationObserver(() => { if (!document.body.contains(root)) closeMenu(); });
      menuObserver.observe(document.body, { childList: true, subtree: true });
    }
    renderMenu();
  }
  function closeMenu() {
    if (!open) return;
    open = false;
    root.classList.remove('open');
    toggle.textContent = '▾';
    menu.remove();
    window.removeEventListener('resize', positionMenu);
    window.removeEventListener('scroll', positionMenu, true);
    if (menuObserver) { menuObserver.disconnect(); menuObserver = null; }
  }

  search.addEventListener('focus', openMenu);
  search.addEventListener('input', () => { selected = null; openMenu(); renderMenu(); dispatch('input'); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeMenu(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(); hi = Math.min((filtered.length || 1) - 1, hi + 1); renderMenu(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); openMenu(); hi = Math.max(0, hi - 1); renderMenu(); }
    else if (e.key === 'Enter' && open && hi >= 0 && filtered[hi]) {
      e.preventDefault(); setValue(filtered[hi].value); closeMenu();
    }
  });
  toggle.addEventListener('click', (e) => { e.preventDefault(); open ? closeMenu() : (search.focus(), openMenu()); });

  return root;
}

export function comboSelect(options, value, attrs = {}) {
  return comboBase(options, value, attrs, { allowCustom: false });
}
export function comboInput(options, value = '', attrs = {}) {
  return comboBase(options, value, attrs, { allowCustom: true });
}
