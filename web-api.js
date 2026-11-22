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

  // Chrome / Edge on a computer have a real "Save as" dialog; Safari / iPad download instead.
  const canSavePicker = typeof window.showSaveFilePicker === 'function';
  async function saveWithPicker(name, data, filters) {
    const ext = extOf(name);
    const types = (filters || []).map(f => ({ description: f.name, accept: { [MIME[ext] || 'application/octet-stream']: f.extensions.map(e => '.' + e) } }));
    const handle = await window.showSaveFilePicker({ suggestedName: name, types });
    const w = await handle.createWritable();
    await w.write(data);
    await w.close();
    return handle;
  }
  // Returns the saved file name, or null if the user cancelled.
  async function saveFile(name, data, filters) {
    if (canSavePicker) {
      try { return (await saveWithPicker(name, data, filters)).name; }
      catch (e) { if (e && e.name === 'AbortError') return null; /* fall back to download */ }
    }
    download(name, data);
    return name;
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
  // Fonts on the web shop / Google Fonts. Loaded on demand from fonts.googleapis.com (needs internet).
  const GOOGLE_FONTS_BOLD = [ // have regular + bold
    'Kanit', 'Prompt', 'Mitr', 'Sarabun', 'Chakra Petch', 'Bai Jamjuree', 'K2D', 'KoHo', 'Kodchasan', 'Krub',
    'Niramit', 'Fahkwang', 'Charm', 'Charmonman', 'Srisakdi', 'Thasadith', 'Trirong', 'Taviraj', 'Pridi',
    'Maitree', 'Athiti', 'Mali', 'Anuphan', 'Noto Sans Thai', 'Noto Serif Thai', 'Noto Sans Thai Looped',
    'IBM Plex Sans Thai', 'IBM Plex Sans Thai Looped', 'Fredoka'
  ];
  const GOOGLE_FONTS_REGULAR = ['Itim', 'Sriracha', 'Pattaya', 'Chonburi', 'Pacifico', 'Bebas Neue', 'Lobster', 'Righteous'];
  // Resolves when the font stylesheets are in (max 4 s — offline just means no Google fonts).
  let googleFontsPromise = null;
  function addGoogleFontLinks() {
    if (googleFontsPromise) return googleFontsPromise;
    const add = (family, bold) => new Promise(resolve => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}${bold ? ':wght@400;700' : ''}&display=swap`;
      link.onload = link.onerror = resolve;
      document.head.appendChild(link);
    });
    const all = Promise.all([...GOOGLE_FONTS_BOLD.map(f => add(f, true)), ...GOOGLE_FONTS_REGULAR.map(f => add(f, false))]);
    googleFontsPromise = Promise.race([all, new Promise(r => setTimeout(r, 4000))]);
    return googleFontsPromise;
  }

  // Fonts that come with iPad / Mac / Windows. Only the ones this device actually has are listed.
  const DEVICE_FONT_CANDIDATES = [
    // Apple
    'Thonburi', 'Sukhumvit Set', 'Ayuthaya', 'Krungthep', 'Silom', 'Sathu', 'Helvetica', 'Helvetica Neue',
    'Avenir', 'Avenir Next', 'Futura', 'Gill Sans', 'Optima', 'Didot', 'Baskerville', 'American Typewriter',
    'Chalkboard SE', 'Marker Felt', 'Noteworthy', 'Menlo', 'Copperplate', 'Papyrus', 'Snell Roundhand',
    // Windows
    'Tahoma', 'Leelawadee UI', 'Leelawadee', 'Segoe UI', 'Cordia New', 'Angsana New', 'Browallia New',
    'TH Sarabun New', 'Microsoft Sans Serif', 'Calibri', 'Cambria', 'Consolas', 'Comic Sans MS', 'Impact',
    // both
    'Arial', 'Arial Black', 'Verdana', 'Georgia', 'Times New Roman', 'Courier New', 'Trebuchet MS'
  ];
  function deviceHasFont(name) {
    const ctx = document.createElement('canvas').getContext('2d');
    const sample = 'กขคงพวงกุญแจ AaBbWwMm 0123 @#';
    return ['monospace', 'serif', 'sans-serif'].some(base => {
      ctx.font = `40px ${base}`;
      const w0 = ctx.measureText(sample).width;
      ctx.font = `40px "${name}", ${base}`;
      return ctx.measureText(sample).width !== w0;
    });
  }

  // Reads the family name stored inside a .ttf / .otf file (the name an order sheet refers to).
  function fontFamilyFromFile(buf) {
    try {
      const v = new DataView(buf);
      let off = 0;
      if (v.getUint32(0) === 0x74746366) off = v.getUint32(12); // .ttc → first font
      const numTables = v.getUint16(off + 4);
      for (let i = 0; i < numTables; i++) {
        const rec = off + 12 + i * 16;
        if (String.fromCharCode(v.getUint8(rec), v.getUint8(rec + 1), v.getUint8(rec + 2), v.getUint8(rec + 3)) !== 'name') continue;
        const t = v.getUint32(rec + 8);
        const count = v.getUint16(t + 2), strings = t + v.getUint16(t + 4);
        let best = null;
        for (let j = 0; j < count; j++) {
          const r = t + 6 + j * 12;
          const platform = v.getUint16(r), lang = v.getUint16(r + 4), nameId = v.getUint16(r + 6);
          const len = v.getUint16(r + 8), so = strings + v.getUint16(r + 10);
          if (nameId !== 1 && nameId !== 16) continue;
          let s = '';
          if (platform === 3 || platform === 0) for (let k = 0; k < len; k += 2) s += String.fromCharCode(v.getUint16(so + k));
          else for (let k = 0; k < len; k++) s += String.fromCharCode(v.getUint8(so + k));
          const score = (nameId === 16 ? 2 : 0) + (platform === 3 && lang === 0x409 ? 1 : 0);
          if (s && (!best || score > best.score)) best = { s, score };
        }
        return best ? best.s.trim() : null;
      }
    } catch { /* not a font we can read */ }
    return null;
  }

  async function registerUserFonts() {
    const keys = (await kvKeys()).filter(k => String(k).startsWith('font:'));
    const names = [];
    for (const k of keys) {
      const f = await kvGet(k);
      try {
        const face = new FontFace(f.family, f.data);
        await face.load();
        document.fonts.add(face);
        names.push(f.family);
      } catch (e) { console.warn('font failed', f.family, e); }
    }
    return names;
  }

  let localFonts = []; // from Chrome's "read fonts on this computer" (queryLocalFonts)
  let userFonts = [];
  async function allFonts() {
    const device = DEVICE_FONT_CANDIDATES.filter(deviceHasFont);
    const google = [...GOOGLE_FONTS_BOLD, ...GOOGLE_FONTS_REGULAR];
    return [...new Set([...userFonts, ...google, ...device, ...localFonts])].sort((a, b) => a.localeCompare(b));
  }

  async function addFonts() {
    const files = await pickFiles('.ttf,.otf,.ttc,.woff,.woff2,font/*', true);
    if (!files) return [];
    const added = [];
    for (const file of files) {
      const data = await file.arrayBuffer();
      const family = fontFamilyFromFile(data) || file.name.replace(/\.[^.]+$/, '');
      try {
        const face = new FontFace(family, data);
        await face.load();
        document.fonts.add(face);
      } catch { alert(`อ่านไฟล์ฟอนต์ไม่ได้: ${file.name}`); continue; }
      await kvSet('font:' + family, { family, fileName: file.name, data });
      added.push(family);
    }
    if (added.length) {
      userFonts = [...new Set([...userFonts, ...added])];
      emit('fonts-changed', await allFonts());
    }
    return added;
  }

  async function listUserFonts() {
    const keys = (await kvKeys()).filter(k => String(k).startsWith('font:'));
    return keys.map(k => String(k).slice(5)).sort((a, b) => a.localeCompare(b));
  }
  async function deleteUserFont(family) {
    await kvDel('font:' + family);
    userFonts = userFonts.filter(f => f !== family);
    emit('fonts-changed', await allFonts());
  }

  async function readComputerFonts() {
    if (typeof window.queryLocalFonts !== 'function') {
      alert('เบราว์เซอร์นี้อ่านรายชื่อฟอนต์ในเครื่องไม่ได้ (ทำได้เฉพาะ Chrome / Edge บนคอมพิวเตอร์)\nใช้เมนู ฟอนต์ → เพิ่มฟอนต์จากไฟล์ แทน');
      return;
    }
    try {
      const list = await window.queryLocalFonts();
      localFonts = [...new Set(list.map(f => f.family))];
      emit('fonts-changed', await allFonts());
      alert(`อ่านฟอนต์ในเครื่องได้ ${localFonts.length} ตัว`);
    } catch (e) { alert(`อ่านฟอนต์ไม่ได้: ${e.message || e}`); }
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
    listSystemFonts: async () => {
      const google = addGoogleFontLinks();
      userFonts = await registerUserFonts();
      await google;
      return allFonts();
    },
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
      if (f && f.files && Object.keys(f.files).length) download(f.zipName, await zipFiles(f.files));
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
        // Safari / iPad: each save downloads a new copy of the file.
        const suggested = filePath || defaultName;
        download(suggested, text);
        name = suggested;
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

    saveExport: async ({ defaultName, filters, data }) => {
      const name = await saveFile(defaultName, toU8(data), filters);
      return name ? { ok: true, filePath: name } : { ok: false, reason: 'canceled' };
    },
    // Several STL files: one .zip (the iPad can't save several files from one dialog).
    saveExportMulti: async ({ defaultName, files }) => {
      const base = defaultName.replace(/\.[^.]+$/, ''), ext = extOf(defaultName);
      const entries = {};
      for (const f of files) entries[`${base}${f.suffix}.${ext}`] = toU8(f.data);
      const name = await saveFile(`${base}.zip`, await zipFiles(entries), [{ name: 'ZIP', extensions: ['zip'] }]);
      return name ? { ok: true, filePath: `${name} (${files.length} ไฟล์)` } : { ok: false, reason: 'canceled' };
    },

    selftestInfo: async () => null,
    selftestWrite: async () => {},
    selftestDone: async () => {},

    // web only
    onFontsChanged: (cb) => on('fonts-changed', cb)
  };

  // used by web-menu.js
  window.webApp = {
    emit, on, kvGet, lsGet, lsSet, addFonts, listUserFonts, deleteUserFont, readComputerFonts,
    recentProjects: async () => ((await kvGet('recent')) || []).map(p => p.name),
    clearRecent: async () => { await kvSet('recent', []); },
    setPref: (key, value) => {
      const prefs = { minFeatureMM: 0.4, ...lsGet('prefs', {}), [key]: value };
      lsSet('prefs', prefs);
      emit('prefs-changed', prefs);
    }
  };
})();
