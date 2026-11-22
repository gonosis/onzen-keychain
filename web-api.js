// Onzen Flat Keychain — web version of window.api.
// The Electron app talks to its main process through window.api (preload.js). This file provides
// the same functions using only browser features, so the rest of the app (src/*.js) runs unchanged
// in Safari (iPad / Mac), Chrome and Edge:
//   • open files      → <input type="file">
//   • save / export   → download (or a real save dialog in Chrome/Edge)
//   • prefs, presets, favorite fonts → localStorage
//   • my icons, my fonts, recent projects → IndexedDB (stays in this browser)
//   • Electron menu   → menu bar at the top of the page (built in web-menu.js)
(function () {
  'use strict';

  // ── tiny key-value store on IndexedDB ──
  const DB_NAME = 'onzen-flat-keychain', STORE = 'kv';
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function idb(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  const kvGet = (k) => idb('readonly', s => s.get(k));
  const kvSet = (k, v) => idb('readwrite', s => s.put(v, k));
  const kvDel = (k) => idb('readwrite', s => s.delete(k));
  const kvKeys = () => idb('readonly', s => s.getAllKeys());

  const lsGet = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? def; } catch { return def; } };
  const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  // ── listeners (replace ipcRenderer.on) ──
  const listeners = {};
  function on(ch, cb) { (listeners[ch] = listeners[ch] || []).push(cb); }
  function emit(ch, ...args) { for (const cb of listeners[ch] || []) cb(...args); }

  // ── file helpers ──
  // Opens the file chooser. Resolves to an array of File, or null if cancelled.
  function pickFiles(accept, multiple = false) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = multiple;
      input.style.display = 'none';
      document.body.appendChild(input);
      const done = (files) => { input.remove(); resolve(files && files.length ? [...files] : null); };
      input.addEventListener('change', () => done(input.files), { once: true });
      input.addEventListener('cancel', () => done(null), { once: true });
      input.click();
    });
  }
  const readText = (file) => file.text();
  const readDataUrl = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  const extOf = (name) => (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
  const MIME = { stl: 'model/stl', obj: 'text/plain', '3mf': 'model/3mf', kcproj: 'application/json', json: 'application/json', zip: 'application/zip' };

  function download(name, data) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: MIME[extOf(name)] || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // Which device is this? iPadOS reports itself as a Mac, so also look for a touch screen.
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);

  const makeFile = (name, data) => new File([data], name, { type: MIME[extOf(name)] || 'application/octet-stream' });
  // Can this browser hand a file of this type to other apps (share sheet)?
  function canShareFile(name) {
    try { return typeof navigator.canShare === 'function' && navigator.canShare({ files: [makeFile(name, new Uint8Array(1))] }); }
    catch { return false; }
  }

  // Building a model can take a few seconds; by then the browser may no longer count the click
  // as "the user asked for this" and refuses to open a save/share window. Then we ask for one tap.
  function tapToContinue(message, button) {
    return new Promise(resolve => {
      const back = document.createElement('div');
      back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:3000;display:flex;align-items:center;justify-content:center';
      back.innerHTML = `<div style="background:#232323;border:1px solid #3a3a3a;border-radius:10px;padding:18px 20px;max-width:340px;color:var(--text,#eee);font:inherit;text-align:center">
        <div class="msg" style="margin-bottom:14px;line-height:1.5"></div>
        <div style="display:flex;gap:8px;justify-content:center"><button class="cancel">ยกเลิก</button><button class="go primary"></button></div></div>`;
      back.querySelector('.msg').textContent = message;
      back.querySelector('.go').textContent = button;
      const done = (v) => { back.remove(); resolve(v); };
      back.querySelector('.go').onclick = () => done(true);
      back.querySelector('.cancel').onclick = () => done(false);
      document.body.appendChild(back);
    });
  }
  const needsTap = (e) => e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');

  // Share sheet (iPhone / iPad / Android): "Save to Files", AirDrop, or another app such as Bambu Handy.
  // Resolves true when shared, false when the user cancelled.
  async function shareFile(name, data) {
    const file = makeFile(name, data);
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await navigator.share({ files: [file] }); return true; }
      catch (e) {
        if (e && e.name === 'AbortError') return false;
        if (attempt === 0 && needsTap(e)) {
          if (!(await tapToContinue(`ไฟล์ ${name} พร้อมแล้ว`, 'แชร์ / บันทึก'))) return false;
          continue;
        }
        throw e;
      }
    }
    return false;
  }

  // Chrome / Edge on a computer have a real "Save as" dialog.
  const canSavePicker = typeof window.showSaveFilePicker === 'function';
  async function saveWithPicker(name, data, filters) {
    const ext = extOf(name);
    const types = (filters || []).map(f => ({ description: f.name, accept: { [MIME[ext] || 'application/octet-stream']: f.extensions.map(e => '.' + e) } }));
    const open = () => window.showSaveFilePicker({ suggestedName: name, types });
    let handle;
    try { handle = await open(); }
    catch (e) {
      if (!needsTap(e)) throw e;
      if (!(await tapToContinue(`ไฟล์ ${name} พร้อมแล้ว`, 'บันทึก...'))) { const a = new Error('cancel'); a.name = 'AbortError'; throw a; }
      handle = await open();
    }
    const w = await handle.createWritable();
    await w.write(data);
    await w.close();
    return handle;
  }
  // Saves onto this device. Returns the saved file name, or null if the user cancelled.
  //   PC / Mac (Chrome, Edge) → "Save as" window · iPhone / iPad → share sheet → "Save to Files"
  //   Android, Safari on Mac, Firefox → the Downloads folder
  async function saveFile(name, data, filters) {
    if (canSavePicker && !isAndroid) {
      try { return (await saveWithPicker(name, data, filters)).name; }
      catch (e) { if (e && e.name === 'AbortError') return null; /* fall back to download */ }
    }
    if (isIOS && canShareFile(name)) {
      try { return (await shareFile(name, data)) ? name : null; }
      catch { /* fall back to download */ }
    }
    download(name, data);
    return name;
  }

  // "Send to" from the Export card (web-send.js): the next export goes there instead of being saved.
  let exportTarget = null;
  async function deliverExport(name, data, filters) {
    const target = exportTarget;
    exportTarget = null;
    if (target) return target(name, data);
    const saved = await saveFile(name, data, filters);
    return saved ? { ok: true, filePath: saved } : { ok: false, reason: 'canceled' };
  }

  // ── zip (for several files at once — the iPad has no "pick a folder") ──
  let fflate = null;
  const loadZip = async () => (fflate = fflate || await import('./vendor/three-jsm/libs/fflate.module.js'));
  async function zipFiles(files) { // files: { name: Uint8Array }
    const { zipSync } = await loadZip();
    return zipSync(files, { level: 6 });
  }
  const toU8 = (data) => data instanceof Uint8Array ? data : typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);

  // ── fonts ──
  // Only the shop's own fonts, shipped in fonts/ (list in fonts/fonts.json, made from the
  // Swirly / Retro Groovy / fontOK_set01 folders). Each file is fetched the first time it is
  // drawn, so opening the app doesn't download all of them.
  let bundledPromise = null;
  function registerBundledFonts() {
    if (bundledPromise) return bundledPromise;
    bundledPromise = (async () => {
      try {
        const list = await (await fetch('fonts/fonts.json')).json();
        for (const f of list) {
          document.fonts.add(new FontFace(f.family, `url("fonts/${encodeURIComponent(f.file)}")`));
        }
        return [...new Set(list.map(f => f.family))];
      } catch (e) { console.error('fonts.json', e); return []; }
    })();
    return bundledPromise;
  }

  async function allFonts() {
    return (await registerBundledFonts()).slice().sort((a, b) => a.localeCompare(b));
  }
  // ── icons ──
  const BUILTIN_ICONS = ['bone', 'cat', 'cloud', 'crown', 'donut', 'fish', 'flower', 'heart', 'lightning', 'moon', 'music', 'paw', 'star'];
  let builtinIconCache = null;
  async function builtinIcons() {
    if (!builtinIconCache) {
      builtinIconCache = await Promise.all(BUILTIN_ICONS.map(async name => {
        const text = await (await fetch(`assets/icons/${name}.svg`)).text();
        return { file: `${name}.svg`, name, builtin: true, dataUrl: 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(text))) };
      }));
    }
    return builtinIconCache;
  }
  async function userIcons() {
    const keys = (await kvKeys()).filter(k => String(k).startsWith('icon:')).map(String).sort((a, b) => a.localeCompare(b));
    const out = [];
    for (const k of keys) out.push(await kvGet(k));
    return out;
  }

  // ── recent projects (content kept in this browser, max 10) ──
  async function addRecent(name, text) {
    const list = (await kvGet('recent')) || [];
    const next = [{ name, text, at: Date.now() }, ...list.filter(p => p.name !== name)].slice(0, 10);
    await kvSet('recent', next);
    emit('recent-changed');
  }

  // ── batch export targets: a real folder (Chrome/Edge) or a .zip (Safari/iPad) ──
  const folders = new Map(); // key → { handle } | { zipName, files }

  // ── unsaved-work warning ──
  let dirty = false;
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  const projectHandles = new Map(); // file name → FileSystemFileHandle (Chrome/Edge: save overwrites)

  window.api = {
    listSystemFonts: allFonts,
    getFavoriteFonts: async () => lsGet('favoriteFonts', []),
    saveFavoriteFonts: async (list) => { lsSet('favoriteFonts', list); return { ok: true }; },

    pickImage: async () => {
      const files = await pickFiles('.png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml');
      if (!files) return null;
      return { name: files[0].name, dataUrl: await readDataUrl(files[0]) };
    },

    getPrefs: async () => ({ minFeatureMM: 0.4, ...lsGet('prefs', {}) }),
    onPrefsChanged: (cb) => on('prefs-changed', cb),

    openOrder: async () => {
      const files = await pickFiles('.json,application/json');
      if (!files) return;
      let data = null, error = null;
      try { data = JSON.parse(await readText(files[0])); } catch (e) { error = e.message; }
      emit('order-loaded', { name: files[0].name, data, error });
    },
    onOrderLoaded: (cb) => on('order-loaded', cb),
    onOrderShow: (cb) => on('order-show', cb),

    pickFolder: async (title) => {
      if (typeof window.showDirectoryPicker === 'function') {
        try {
          const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
          folders.set(handle.name, { handle });
          return handle.name;
        } catch (e) { if (e && e.name === 'AbortError') return null; }
      }
      const zipName = `ใบงาน_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.zip`;
      folders.set(zipName, { zipName, files: {} });
      return zipName;
    },
    writeFileIn: async (dir, name, data) => {
      const f = folders.get(dir);
      const base = String(name).split(/[\\/]/).pop();
      if (!f) throw new Error('ไม่พบโฟลเดอร์ปลายทาง');
      if (f.handle) {
        const fh = await f.handle.getFileHandle(base, { create: true });
        const w = await fh.createWritable();
        await w.write(toU8(data));
        await w.close();
      } else {
        f.files[base] = toU8(data);
      }
      return `${dir}/${base}`;
    },
    // web only: called after the last writeFileIn — downloads the .zip when there was no folder.
    finishFolder: async (dir) => {
      const f = folders.get(dir);
      folders.delete(dir);
      if (f && f.files && Object.keys(f.files).length) await saveFile(f.zipName, await zipFiles(f.files), [{ name: 'ZIP', extensions: ['zip'] }]);
    },

    saveProject: async ({ filePath, defaultName, text }) => {
      let name = null;
      const handle = filePath && projectHandles.get(filePath);
      if (handle) {
        const w = await handle.createWritable();
        await w.write(text);
        await w.close();
        name = handle.name;
      } else if (canSavePicker) {
        try {
          const h = await saveWithPicker(defaultName, text, [{ name: 'งาน Onzen Flat Keychain', extensions: ['kcproj'] }]);
          projectHandles.set(h.name, h);
          name = h.name;
        } catch (e) {
          if (e && e.name === 'AbortError') return null;
          download(defaultName, text); name = defaultName;
        }
      } else {
        // Safari / iPad / Android: each save makes a new copy (Files app or Downloads).
        name = await saveFile(filePath || defaultName, text);
        if (!name) return null;
      }
      await addRecent(name, text);
      return name;
    },
    openProject: async () => {
      let file = null;
      if (typeof window.showOpenFilePicker === 'function') {
        try {
          const [h] = await window.showOpenFilePicker({ types: [{ description: 'งาน Onzen Flat Keychain', accept: { 'application/json': ['.kcproj'] } }] });
          projectHandles.set(h.name, h);
          file = await h.getFile();
        } catch (e) { if (e && e.name === 'AbortError') return null; }
      }
      if (!file) {
        const files = await pickFiles('.kcproj,application/json');
        if (!files) return null;
        file = files[0];
      }
      const text = await readText(file);
      try { const data = JSON.parse(text); await addRecent(file.name, text); return { filePath: file.name, data }; }
      catch (e) { return { filePath: file.name, error: e.message }; }
    },
    readProject: async (name) => {
      const list = (await kvGet('recent')) || [];
      const p = list.find(x => x.name === name);
      if (!p) return { filePath: name, error: 'ไม่พบงานนี้ในรายการล่าสุด' };
      try { return { filePath: name, data: JSON.parse(p.text) }; }
      catch (e) { return { filePath: name, error: e.message }; }
    },
    onOpenRecent: (cb) => on('project-open-recent', cb),

    getPresets: async () => lsGet('presets', []),
    savePresets: async (list) => { lsSet('presets', list); return true; },

    setDirty: (d) => { dirty = !!d; },
    onMenu: (channel, cb) => on(channel, cb),

    listIcons: async () => [...await builtinIcons(), ...await userIcons()],
    addIcons: async () => {
      const files = await pickFiles('.png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml', true);
      if (!files) return 0;
      const existing = new Set((await kvKeys()).map(String));
      for (const file of files) {
        const ext = file.name.match(/\.[^.]+$/)?.[0] || '', base = file.name.slice(0, file.name.length - ext.length);
        let name = file.name, n = 2;
        while (existing.has('icon:' + name)) name = `${base} (${n++})${ext}`;
        existing.add('icon:' + name);
        await kvSet('icon:' + name, { file: name, name: name.replace(/\.(png|jpe?g|svg)$/i, ''), builtin: false, dataUrl: await readDataUrl(file) });
      }
      return files.length;
    },
    deleteIcon: async (file) => { await kvDel('icon:' + String(file)); return true; },

    saveExport: ({ defaultName, filters, data }) => deliverExport(defaultName, toU8(data), filters),
    // Several STL files: one .zip (the iPad can't save several files from one dialog).
    saveExportMulti: async ({ defaultName, files }) => {
      const base = defaultName.replace(/\.[^.]+$/, ''), ext = extOf(defaultName);
      const entries = {};
      for (const f of files) entries[`${base}${f.suffix}.${ext}`] = toU8(f.data);
      const res = await deliverExport(`${base}.zip`, await zipFiles(entries), [{ name: 'ZIP', extensions: ['zip'] }]);
      if (res.ok) res.filePath = `${res.filePath} (${files.length} ไฟล์)`;
      return res;
    },

    selftestInfo: async () => null,
    selftestWrite: async () => {},
    selftestDone: async () => {},

    // web only
    onFontsChanged: (cb) => on('fonts-changed', cb)
  };

  // ── the work in progress, remembered in this browser (reopens where you left off) ──
  let autosaveTimer = null, autosavePending = null;
  function autosaveSoon(entry) { // entry: { text, projectPath, dirty }
    autosavePending = entry;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(flushAutosave, 600);
  }
  function flushAutosave() {
    clearTimeout(autosaveTimer);
    if (!autosavePending) return;
    const entry = { ...autosavePending, at: Date.now() };
    autosavePending = null;
    kvSet('autosave', entry).catch(e => console.warn('autosave', e));
  }
  window.addEventListener('pagehide', flushAutosave);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAutosave(); });

  async function newWork() {
    if (dirty && !confirm('เริ่มงานใหม่? งานที่เปิดอยู่ยังไม่ได้บันทึกเป็นไฟล์')) return;
    clearTimeout(autosaveTimer); autosavePending = null;
    await kvDel('autosave');
    dirty = false;
    location.reload();
  }

  // ── settings file: carry this browser's settings to another Mac / iPad / PC ──
  const SETTINGS_FORMAT = 'onzen-flat-keychain-settings';
  const LS_KEYS = ['prefs', 'presets', 'favoriteFonts', 'sendTarget'];

  async function exportSettings() {
    flushAutosave();
    const ls = {};
    for (const k of LS_KEYS) { const v = lsGet(k, null); if (v != null) ls[k] = v; }
    const data = {
      format: SETTINGS_FORMAT, version: 1, savedAt: new Date().toISOString(),
      localStorage: ls,
      icons: await userIcons(),
      recent: (await kvGet('recent')) || [],
      work: (await kvGet('autosave')) || null
    };
    const name = `Onzen-ตั้งค่า_${new Date().toISOString().slice(0, 10)}.json`;
    const saved = await saveFile(name, JSON.stringify(data), [{ name: 'ไฟล์ตั้งค่า', extensions: ['json'] }]);
    if (saved) {
      alert(`ส่งออกการตั้งค่าแล้ว: ${saved}\n\nเก็บไฟล์นี้ไว้ใน iCloud Drive / Dropbox / ส่งทาง AirDrop\nแล้วที่เครื่องอื่นเปิดเมนู ไฟล์ → นำเข้าการตั้งค่า`);
    }
  }

  async function importSettings() {
    const files = await pickFiles('.json,application/json');
    if (!files) return;
    let data;
    try { data = JSON.parse(await readText(files[0])); } catch { alert('อ่านไฟล์ไม่ได้'); return; }
    if (!data || data.format !== SETTINGS_FORMAT) { alert('ไฟล์นี้ไม่ใช่ไฟล์ตั้งค่าของ Onzen Flat Keychain'); return; }
    const ls = data.localStorage || {};
    const done = [];
    if (ls.prefs) { lsSet('prefs', { ...lsGet('prefs', {}), ...ls.prefs }); done.push('ค่าในเมนูตั้งค่า'); }
    if (Array.isArray(ls.presets)) { // same name → the imported one wins
      const byName = new Map(lsGet('presets', []).map(p => [p.name, p]));
      for (const p of ls.presets) byName.set(p.name, p);
      lsSet('presets', [...byName.values()]);
      done.push(`preset ${ls.presets.length} อัน`);
    }
    if (Array.isArray(ls.favoriteFonts)) {
      lsSet('favoriteFonts', [...new Set([...lsGet('favoriteFonts', []), ...ls.favoriteFonts])]);
      done.push(`ฟอนต์โปรด ${ls.favoriteFonts.length} ตัว`);
    }
    if (ls.sendTarget) lsSet('sendTarget', ls.sendTarget);
    if (Array.isArray(data.icons) && data.icons.length) {
      for (const ic of data.icons) if (ic && ic.file) await kvSet('icon:' + ic.file, ic);
      done.push(`ไอคอนของฉัน ${data.icons.length} รูป`);
    }
    if (Array.isArray(data.recent) && data.recent.length) {
      const merged = new Map(((await kvGet('recent')) || []).map(p => [p.name, p]));
      for (const p of data.recent) { const cur = merged.get(p.name); if (!cur || (p.at || 0) > (cur.at || 0)) merged.set(p.name, p); }
      await kvSet('recent', [...merged.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 10));
      done.push(`งานล่าสุด ${data.recent.length} งาน`);
    }
    let takeWork = false;
    if (data.work && data.work.text) {
      takeWork = confirm('ในไฟล์มีงานที่ทำค้างไว้จากเครื่องนั้นด้วย\nเปิดงานนั้นแทนงานที่เปิดอยู่ตอนนี้ไหม?\n\n(ยกเลิก = เก็บงานตอนนี้ไว้)');
      if (takeWork) {
        clearTimeout(autosaveTimer); autosavePending = null;
        await kvSet('autosave', { ...data.work, dirty: true });
        done.push('งานที่ทำค้าง');
      }
    }
    alert(`นำเข้าแล้ว:\n• ${done.join('\n• ') || '(ไม่มีข้อมูล)'}\n\nโปรแกรมจะโหลดใหม่`);
    if (!takeWork) flushAutosave();
    dirty = false;
    location.reload();
  }

  // used by web-menu.js
  window.webApp = {
    autosaveSoon, autosaveGet: () => kvGet('autosave'), newWork, exportSettings, importSettings,
    emit, on, kvGet, lsGet, lsSet, saveFile, shareFile, canShareFile, isIOS, isAndroid,
    setExportTarget: (fn) => { exportTarget = fn; },
    recentProjects: async () => ((await kvGet('recent')) || []).map(p => p.name),
    clearRecent: async () => { await kvSet('recent', []); },
    setPref: (key, value) => {
      const prefs = { minFeatureMM: 0.4, ...lsGet('prefs', {}), [key]: value };
      lsSet('prefs', prefs);
      emit('prefs-changed', prefs);
    }
  };
})();
