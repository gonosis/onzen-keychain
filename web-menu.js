// Menu bar for the web version (the Electron app has these in its window menu).
(function () {
  'use strict';
  const app = window.webApp;
  const MIN_FEATURE_OPTIONS = [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0];
  const isMac = /Mac|iPad|iPhone/.test(navigator.platform) || navigator.userAgent.includes('Mac');
  const mod = isMac ? '⌘' : 'Ctrl+';

  const style = document.createElement('style');
  style.textContent = `
    #webMenu { height: 34px; display: flex; align-items: stretch; gap: 2px; padding: 0 6px;
      background: #101010; border-bottom: 1px solid var(--line); position: relative; z-index: 1000;
      -webkit-user-select: none; user-select: none; }
    #webMenu .wm-title { color: var(--accent); font-weight: 600; padding: 0 10px 0 4px; display: flex; align-items: center; }
    #webMenu .wm-item { position: relative; }
    #webMenu .wm-btn { height: 100%; background: none; border: none; color: var(--text); padding: 0 12px;
      font: inherit; cursor: pointer; border-radius: 0; }
    #webMenu .wm-item.open > .wm-btn, #webMenu .wm-btn:hover { background: #2a2a2a; }
    #webMenu .wm-drop { display: none; position: absolute; top: 100%; left: 0; min-width: 280px;
      background: #232323; border: 1px solid #3a3a3a; border-radius: 6px; padding: 4px 0;
      box-shadow: 0 6px 24px rgba(0,0,0,.5); }
    #webMenu .wm-item.open > .wm-drop { display: block; }
    #webMenu .wm-drop button { display: flex; justify-content: space-between; gap: 16px; width: 100%;
      background: none; border: none; color: var(--text); text-align: left; padding: 9px 14px;
      font: inherit; cursor: pointer; border-radius: 0; }
    #webMenu .wm-drop button:hover:not(:disabled) { background: var(--accent); color: #111; }
    #webMenu .wm-drop button:disabled { color: var(--muted); cursor: default; }
    #webMenu .wm-drop .wm-key { color: var(--muted); }
    #webMenu .wm-drop hr { border: none; border-top: 1px solid #3a3a3a; margin: 4px 0; }
    #webMenu .wm-drop .wm-label { color: var(--muted); font-size: 11px; padding: 6px 14px 2px; }
    #app { height: calc(100vh - 34px) !important; height: calc(100dvh - 34px) !important; }
  `;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'webMenu';
  bar.innerHTML = '<div class="wm-title">Onzen Flat Keychain</div>';
  document.body.prepend(bar);

  function closeAll() { bar.querySelectorAll('.wm-item.open').forEach(i => i.classList.remove('open')); }
  document.addEventListener('pointerdown', (e) => { if (!bar.contains(e.target)) closeAll(); });

  // items: [{ label, key, run, disabled } | '-' | { section }]; build may be async (rebuilt on open)
  function menu(label, build) {
    const item = document.createElement('div');
    item.className = 'wm-item';
    const btn = document.createElement('button');
    btn.className = 'wm-btn';
    btn.textContent = label;
    const drop = document.createElement('div');
    drop.className = 'wm-drop';
    item.append(btn, drop);
    bar.appendChild(item);
    btn.addEventListener('click', async () => {
      const wasOpen = item.classList.contains('open');
      closeAll();
      if (wasOpen) return;
      drop.innerHTML = '';
      for (const it of await build()) {
        if (it === '-') { drop.appendChild(document.createElement('hr')); continue; }
        if (it.section) { const d = document.createElement('div'); d.className = 'wm-label'; d.textContent = it.section; drop.appendChild(d); continue; }
        const b = document.createElement('button');
        b.innerHTML = `<span></span><span class="wm-key">${it.key || ''}</span>`;
        b.firstChild.textContent = it.label;
        b.disabled = !!it.disabled;
        b.addEventListener('click', () => { closeAll(); it.run(); });
        drop.appendChild(b);
      }
      item.classList.add('open');
    });
  }

  menu('ไฟล์', async () => {
    const recent = await app.recentProjects();
    return [
      { label: 'งานใหม่', run: () => app.newWork() },
      { label: 'เปิดงาน (.kcproj)...', key: `${mod}⇧O`, run: () => app.emit('project-open') },
      { label: 'บันทึกงาน', key: `${mod}S`, run: () => app.emit('project-save') },
      { label: 'บันทึกงานเป็น...', key: `${mod}⇧S`, run: () => app.emit('project-save-as') },
      '-',
      { section: 'งานล่าสุด (เก็บไว้ในเบราว์เซอร์นี้)' },
      ...(recent.length
        ? recent.map((name, i) => ({ label: `${i + 1}. ${name}`, run: () => app.emit('project-open-recent', name) }))
        : [{ label: '(ยังไม่มี)', disabled: true, run: () => {} }]),
      ...(recent.length ? [{ label: 'ล้างรายการ', run: () => app.clearRecent() }] : []),
      '-',
      { label: 'โหลดใบงานจากเว็บ (order-….json)...', key: `${mod}O`, run: () => window.api.openOrder() },
      { label: 'รายการในใบงานที่โหลดล่าสุด', key: `${mod}L`, run: () => app.emit('order-show') },
      '-',
      { section: 'ย้ายการตั้งค่าไปเครื่องอื่น (Mac / iPad / PC)' },
      { label: 'ส่งออกการตั้งค่า...', run: () => app.exportSettings() },
      { label: 'นำเข้าการตั้งค่า...', run: () => app.importSettings() }
    ];
  });

  menu('ฟอนต์', async () => {
    const mine = await app.listUserFonts();
    return [
      { label: 'เพิ่มฟอนต์ส่วนตัว (.ttf / .otf)...', run: async () => {
          const added = await app.addUserFonts();
          if (added.length) alert(`เพิ่มฟอนต์แล้ว ${added.length} ตัว (เก็บไว้ในเบราว์เซอร์ของเครื่องนี้เท่านั้น):\n• ${added.join('\n• ')}`);
        } },
      '-',
      { section: mine.length ? `ฟอนต์ส่วนตัวในเครื่องนี้ ${mine.length} ตัว (กดเพื่อลบ)` : 'ยังไม่มีฟอนต์ส่วนตัวในเครื่องนี้' },
      ...mine.map(f => ({ label: `✕  ${f}`, run: async () => { if (confirm(`ลบฟอนต์ "${f}" ออกจากเครื่องนี้?`)) await app.deleteUserFont(f); } }))
    ];
  });

  menu('ตั้งค่า', async () => {
    const cur = app.lsGet('prefs', {}).minFeatureMM ?? 0.4;
    return [
      { section: 'ความกว้างเส้นขั้นต่ำ (ส่วนที่บางกว่านี้จะถูกตัดออก)' },
      ...MIN_FEATURE_OPTIONS.map(v => ({
        label: `${Math.abs(cur - v) < 1e-6 ? '● ' : '○ '}${v === 0 ? 'ปิด (ไม่ตัด)' : `${v.toFixed(1)} mm${v === 0.4 ? '  (หัวฉีด 0.4 ทั่วไป)' : v === 0.2 ? '  (หัวฉีด 0.2)' : ''}`}`,
        run: () => app.setPref('minFeatureMM', v)
      }))
    ];
  });

  // keyboard shortcuts (the Electron menu had these as accelerators)
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    const act =
      k === 's' && e.shiftKey ? () => app.emit('project-save-as') :
      k === 's' ? () => app.emit('project-save') :
      k === 'o' && e.shiftKey ? () => app.emit('project-open') :
      k === 'o' ? () => window.api.openOrder() :
      k === 'l' ? () => app.emit('order-show') : null;
    if (act) { e.preventDefault(); act(); }
  });
})();
