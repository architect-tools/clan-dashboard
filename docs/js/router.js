// router.js — minimal hash router (works on GitHub Pages, no server config).
export const Router = {
  routes: {},
  _current: null,
  on(path, render) { this.routes[path] = render; return this; },

  start(defaultPath = 'dashboard') {
    const go = () => {
      const path = (location.hash.replace(/^#\/?/, '') || defaultPath).split('?')[0];
      const render = this.routes[path] || this.routes[defaultPath];
      this._current = path;
      window.scrollTo(0, 0);
      render && render();
      document.querySelectorAll('[data-nav]').forEach((a) =>
        a.classList.toggle('active', a.dataset.nav === path));
    };
    window.addEventListener('hashchange', go);
    go();
  },
  navigate(path) { location.hash = '#/' + path; },
  current() { return this._current; },
  /** Re-render the current route (used after undo/redo). */
  refresh() {
    const render = this.routes[this._current];
    if (render) {
      const scroll = captureScrollState();
      render();
      restoreScrollState(scroll);
    }
  },
};

const SCROLLABLE = '.scroll-tbl,.table-wrap,.grid-scroll,.skill-panel,.match-list';

function scrollKey(el) {
  if (el.id) return `id:${el.id}`;
  const scope = el.closest('[id]') || document.getElementById('app') || document.body;
  const cls = [...el.classList].sort().join('.');
  const sig = `${el.tagName.toLowerCase()}.${cls}`;
  const same = [...scope.querySelectorAll(SCROLLABLE)].filter((x) => {
    const xCls = [...x.classList].sort().join('.');
    return `${x.tagName.toLowerCase()}.${xCls}` === sig;
  });
  return `${scope.id || 'app'}|${sig}|${same.indexOf(el)}`;
}

function captureScrollState() {
  const app = document.getElementById('app');
  const panes = app ? [...app.querySelectorAll(SCROLLABLE)].map((el) => ({
    key: scrollKey(el),
    top: el.scrollTop,
    left: el.scrollLeft,
  })) : [];
  return { x: window.scrollX, y: window.scrollY, panes };
}

function restoreScrollState(state) {
  const restore = () => {
    window.scrollTo(state.x || 0, state.y || 0);
    const app = document.getElementById('app');
    if (!app) return;
    const byKey = new Map(state.panes.map((p) => [p.key, p]));
    app.querySelectorAll(SCROLLABLE).forEach((el) => {
      const p = byKey.get(scrollKey(el));
      if (p) { el.scrollTop = p.top; el.scrollLeft = p.left; }
    });
  };
  restore();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
  else setTimeout(restore, 0);
}
