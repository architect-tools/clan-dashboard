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
    if (render) { const y = window.scrollY; render(); window.scrollTo(0, y); }
  },
};
