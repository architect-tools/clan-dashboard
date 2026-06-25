// ui.js — shared view components.
import { el, clear, $ } from '../util.js';
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
  const overlay = el('div.modal-overlay', { onclick: (e) => { if (e.target === overlay) close(); } }, [
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
