// Layout for phones, foldables and small tablets (the desktop layout needs ~1100 px).
//   portrait : 3D view on top (drag the bar under it to resize) · panels below, one at a time (tabs)
//   landscape: 3D view on the left · panels on the right, one at a time (tabs)
// Desktop is unchanged. Runs before src/app.js, only moves existing elements (ids stay the same).
(function () {
  'use strict';
  const app = document.getElementById('app');
  const sidebar = document.getElementById('sidebar');
  const viewport = document.getElementById('viewport');
  const layerPanel = document.getElementById('layerPanel');
  if (!app || !sidebar || !viewport || !layerPanel) return;

  const style = document.createElement('style');
  style.textContent = `
    html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
    #mPanels { display: contents; }
    #mTabs, #mSplit { display: none; }
    #sidebar { order: 0; } #viewport { order: 1; } #layerPanel { order: 2; }

    body.m-layout #app { flex-direction: column; }
    body.m-layout #viewport { order: 0; flex: 0 0 var(--m-split, 46%); min-height: 140px; }
    body.m-layout #mSplit { order: 1; display: flex; align-items: center; justify-content: center; height: 18px;
      flex: 0 0 18px; background: #101010; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
      cursor: ns-resize; touch-action: none; }
    body.m-layout #mSplit::before { content: ''; width: 48px; height: 4px; border-radius: 2px; background: #555; }
    body.m-layout #mPanels { order: 2; display: flex; flex-direction: column; flex: 1 1 0; min-height: 0; }
    body.m-layout #mTabs { display: flex; gap: 4px; padding: 6px 8px 0; background: var(--panel); flex: 0 0 auto; }
    body.m-layout #mTabs button { flex: 1; padding: 8px 6px; border-radius: 8px 8px 0 0; border-bottom: none;
      font-size: 14px; color: var(--muted); }
    body.m-layout #mTabs button.on { background: var(--card); color: var(--accent); border-color: var(--accent); font-weight: 600; }
    body.m-layout #sidebar, body.m-layout #layerPanel { width: auto !important; flex: 1 1 0; min-height: 0; border: none; }
    body.m-layout.m-tab-left #layerPanel, body.m-layout.m-tab-right #sidebar { display: none !important; }
    body.m-layout #elementList { max-height: 22vh; }
    /* the right panel scrolls as one page (no squeezed inner scroll areas) */
    body.m-layout #layerPanel { overflow-y: auto; }
    body.m-layout #layerPanel > * { flex-shrink: 0; }
    body.m-layout #elementProps { flex: 0 0 auto; overflow: visible; }
    body.m-layout #helpBox { display: none; }
    body.m-layout #stats { font-size: 11px; max-width: calc(100% - 24px); left: 8px; bottom: 8px; }
    body.m-layout #viewButtons button { padding: 6px 10px; }

    body.m-layout.m-land #app { flex-direction: row; }
    body.m-layout.m-land #viewport { flex: 1 1 auto; min-width: 0; }
    body.m-layout.m-land #mSplit { display: none; }
    body.m-layout.m-land #mPanels { flex: 0 0 min(400px, 48vw); border-left: 1px solid var(--line); }

    /* bigger touch targets */
    body.m-touch .layer button { padding: 4px 8px; font-size: 14px; }
    body.m-touch input[type=checkbox] { width: 18px; height: 18px; }
    /* iPhone / iPad Safari zooms the page into any field under 16px — keep fields at 16px */
    body.m-touch input:not([type=checkbox]):not([type=range]):not([type=color]), body.m-touch select, body.m-touch textarea { font-size: 16px; }

    /* notch / home bar (iPhone, Android gesture bar) */
    body.m-layout #webMenu { padding-left: max(6px, env(safe-area-inset-left)); padding-right: max(6px, env(safe-area-inset-right));
      padding-top: env(safe-area-inset-top); height: calc(34px + env(safe-area-inset-top)); }
    body.m-layout #app { height: calc(100vh - 34px - env(safe-area-inset-top)) !important;
      height: calc(100dvh - 34px - env(safe-area-inset-top)) !important;
      padding: 0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }

    /* narrow phones (Fold6 folded ≈ 373 px, iPhone SE 375 px) */
    @media (max-width: 430px) {
      body.m-layout .row > label:first-child { width: 84px; }
      body.m-layout #mTabs button { font-size: 13px; padding: 8px 4px; }
      body.m-layout aside { padding: 8px; }
      body.m-layout .card { padding: 8px 10px; }
      body.m-layout #webMenu .wm-title { display: none; }
    }
  `;
  document.head.appendChild(style);

  // wrapper for the two side panels + their tabs (display: contents on desktop → no change there)
  const panels = document.createElement('div');
  panels.id = 'mPanels';
  const tabs = document.createElement('div');
  tabs.id = 'mTabs';
  tabs.innerHTML = '<button data-tab="right">🧩 ชิ้นส่วน · Export</button><button data-tab="left">🎛 ขนาด · ฐาน · ห่วง</button>';
  const split = document.createElement('div');
  split.id = 'mSplit';
  split.title = 'ลากเพื่อปรับขนาดจอ 3D';
  app.insertBefore(panels, layerPanel);
  panels.append(tabs, sidebar, layerPanel);
  app.insertBefore(split, panels);

  const ls = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  let tab = ls('mTab', 'right');
  function setTab(t) {
    tab = t;
    document.body.classList.toggle('m-tab-left', t === 'left');
    document.body.classList.toggle('m-tab-right', t === 'right');
    tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    localStorage.setItem('mTab', JSON.stringify(t));
  }
  tabs.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
  setTab(tab);

  const wide = matchMedia('(min-width: 1101px)');
  const land = matchMedia('(orientation: landscape) and (max-height: 620px)');
  function applyLayout() {
    document.body.classList.toggle('m-layout', !wide.matches);
    document.body.classList.toggle('m-land', !wide.matches && land.matches);
    document.body.classList.toggle('m-touch', matchMedia('(pointer: coarse)').matches);
  }
  // after the layout changes shape (first load, rotating, unfolding) fit the model into the new view
  const refit = () => setTimeout(() => document.getElementById('viewFit')?.click(), 250);
  wide.addEventListener('change', () => { applyLayout(); refit(); });
  land.addEventListener('change', () => { applyLayout(); refit(); });
  applyLayout();
  if (!wide.matches) {
    // once the app has built the first model
    const t0 = Date.now();
    const wait = setInterval(() => {
      const stats = document.getElementById('stats');
      if ((stats && stats.textContent) || Date.now() - t0 > 15000) { clearInterval(wait); refit(); }
    }, 300);
  }

  // drag the bar to resize the 3D view (kept per device)
  const savedSplit = ls('mSplit', null);
  if (savedSplit) app.style.setProperty('--m-split', `${savedSplit}px`);
  let drag = null;
  split.addEventListener('pointerdown', (e) => {
    drag = { y: e.clientY, h: viewport.getBoundingClientRect().height };
    try { split.setPointerCapture(e.pointerId); } catch { /* */ }
    e.preventDefault();
  });
  split.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const max = app.getBoundingClientRect().height - 160;
    const h = Math.round(Math.max(140, Math.min(max, drag.h + e.clientY - drag.y)));
    app.style.setProperty('--m-split', `${h}px`);
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    localStorage.setItem('mSplit', JSON.stringify(Math.round(viewport.getBoundingClientRect().height)));
  };
  split.addEventListener('pointerup', end);
  split.addEventListener('pointercancel', end);
  // double-tap the bar: big 3D view ↔ normal
  split.addEventListener('dblclick', () => {
    const full = app.getBoundingClientRect().height - 200;
    const cur = viewport.getBoundingClientRect().height;
    const h = cur < full - 20 ? full : Math.round(app.getBoundingClientRect().height * 0.46);
    app.style.setProperty('--m-split', `${h}px`);
    localStorage.setItem('mSplit', JSON.stringify(h));
  });

  // the 3D view only listens to window resizes — tell it when its own box changes
  let raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }).observe(viewport);

  // picking an element in the 3D view → show its settings
  const card = document.getElementById('elementCard');
  if (card) {
    let wasHidden = card.classList.contains('hide');
    new MutationObserver(() => {
      const hidden = card.classList.contains('hide');
      if (wasHidden && !hidden && document.body.classList.contains('m-layout') && tab !== 'right') setTab('right');
      wasHidden = hidden;
    }).observe(card, { attributes: true, attributeFilter: ['class'] });
  }
})();
