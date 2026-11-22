// Named presets of the left-panel settings (sizes/locks, thickness, chamfer, hole, colors,
// quality…). Stored in userData/presets.json via main.js; applied to whatever design is open.
// Elements are NOT part of a preset, nor is a manually dragged hole position.

const EXCLUDED_KEYS = ['holeX', 'holeY'];

// Electron has no window.prompt — a small modal text input instead. Resolves to the trimmed
// text, or null when cancelled.
export function promptText(title, initial = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'icon-overlay';
    overlay.innerHTML = `
      <div class="icon-dialog" style="width:min(420px,92vw)">
        <div class="icon-head"><h3></h3></div>
        <input class="prompt-input" style="width:100%;font-size:15px;margin:6px 0 10px">
        <div class="btnrow"><button class="prompt-cancel">ยกเลิก</button><button class="primary prompt-ok">ตกลง</button></div>
      </div>`;
    overlay.querySelector('h3').textContent = title;
    const input = overlay.querySelector('.prompt-input');
    input.value = initial;
    document.body.appendChild(overlay);
    input.focus();
    input.select();
    const done = (value) => { overlay.remove(); resolve(value); };
    overlay.querySelector('.prompt-ok').onclick = () => done(input.value.trim() || null);
    overlay.querySelector('.prompt-cancel').onclick = () => done(null);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
    });
  });
}

// { select, applyBtn, saveBtn, overwriteBtn, renameBtn, deleteBtn }: DOM controls.
// getSettings() → current settings object; getExtra() → design-level extras (base style, text
// thickness); applyPreset(settings, extra|undefined) applies a preset (old presets have no extra).
export function createPresetPanel(ui, { getSettings, getExtra, applyPreset }) {
  let presets = [];

  const persist = () => window.api.savePresets(presets);
  const snapshot = () => {
    const s = { ...getSettings() };
    for (const k of EXCLUDED_KEYS) delete s[k];
    return s;
  };

  function render(selectName = ui.select.value) {
    ui.select.innerHTML = '<option value="">— เลือก preset —</option>' +
      presets.map(p => `<option></option>`).join('');
    presets.forEach((p, i) => {
      const o = ui.select.options[i + 1];
      o.value = p.name;
      o.textContent = p.name;
    });
    ui.select.value = presets.some(p => p.name === selectName) ? selectName : '';
    const has = !!ui.select.value;
    for (const b of [ui.applyBtn, ui.overwriteBtn, ui.renameBtn, ui.deleteBtn]) b.disabled = !has;
  }

  const current = () => presets.find(p => p.name === ui.select.value);

  ui.select.addEventListener('change', (e) => { e.stopPropagation(); render(ui.select.value); });
  ui.applyBtn.onclick = () => { const p = current(); if (p) applyPreset({ ...p.settings }, p.extra ? { ...p.extra } : undefined); };

  ui.saveBtn.onclick = async () => {
    const name = await promptText('บันทึกเป็น preset ใหม่ — ตั้งชื่อ', '');
    if (!name) return;
    const existing = presets.find(p => p.name === name);
    if (existing && !confirm(`มี preset ชื่อ “${name}” อยู่แล้ว — บันทึกทับหรือไม่?`)) return;
    if (existing) Object.assign(existing, { settings: snapshot(), extra: getExtra() });
    else presets.push({ name, settings: snapshot(), extra: getExtra() });
    presets.sort((a, b) => a.name.localeCompare(b.name, 'th'));
    await persist();
    render(name);
  };

  ui.overwriteBtn.onclick = async () => {
    const p = current();
    if (!p || !confirm(`บันทึกค่าปัจจุบันทับ preset “${p.name}”?`)) return;
    p.settings = snapshot();
    p.extra = getExtra();
    await persist();
    render(p.name);
  };

  ui.renameBtn.onclick = async () => {
    const p = current();
    if (!p) return;
    const name = await promptText('เปลี่ยนชื่อ preset', p.name);
    if (!name || name === p.name) return;
    if (presets.some(x => x.name === name)) { alert(`มี preset ชื่อ “${name}” อยู่แล้ว`); return; }
    p.name = name;
    presets.sort((a, b) => a.name.localeCompare(b.name, 'th'));
    await persist();
    render(name);
  };

  ui.deleteBtn.onclick = async () => {
    const p = current();
    if (!p || !confirm(`ลบ preset “${p.name}”?`)) return;
    presets = presets.filter(x => x !== p);
    await persist();
    render('');
  };

  window.api.getPresets().then(list => { presets = Array.isArray(list) ? list : []; render(''); });
  return { reload: async () => { presets = await window.api.getPresets(); render(); } };
}
