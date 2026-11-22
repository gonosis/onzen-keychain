// "ส่งไปที่" (send to) in the Export card: save on this device, share to an app (Bambu Handy on
// iPhone / iPad), or open straight in Bambu Studio / OrcaSlicer on a PC / Mac.
// Every target is checked first; the result (✓ can send / ✗ why not) shows under the menu.
//
// Slicers on a computer: a web page can't start programs by itself, so serve.py (running on that
// computer) does it — the page sends it the file, serve.py saves it and opens it in the slicer.
(function () {
  'use strict';
  const app = window.webApp;

  const TARGETS = [
    { id: 'device', label: '💾 บันทึกลงเครื่องนี้' },
    { id: 'share', label: '📱 Bambu Handy / แอปอื่น (แชร์)' },
    { id: 'bambu', label: '🖥 Bambu Studio' },
    { id: 'orca', label: '🖥 OrcaSlicer' }
  ];

  // serve.py: this page itself when it came from serve.py, otherwise serve.py on this computer.
  const fromServePy = location.protocol === 'http:';
  const helperBase = fromServePy ? location.origin : 'http://localhost:8765';
  const isMobile = app.isIOS || app.isAndroid;

  async function helperInfo() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    try {
      const r = await fetch(`${helperBase}/slicers`, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; } finally { clearTimeout(timer); }
  }

  // → { ok, text }
  async function check(id) {
    if (id === 'device') {
      const where = app.isIOS ? 'เลือก “บันทึกไปยัง ไฟล์” ในหน้าต่างแชร์'
        : app.isAndroid ? 'ไฟล์จะอยู่ในโฟลเดอร์ Downloads'
        : typeof window.showSaveFilePicker === 'function' ? 'จะมีหน้าต่างให้เลือกที่บันทึก'
        : 'ไฟล์จะอยู่ในโฟลเดอร์ Downloads';
      return { ok: true, text: `✓ บันทึกได้ · ${where}` };
    }
    if (id === 'share') {
      if (typeof navigator.share !== 'function') {
        return { ok: false, text: '✗ เบราว์เซอร์นี้แชร์ไฟล์ไม่ได้ · ใช้ได้บน iPhone / iPad (Safari) · บนคอมให้เลือก Bambu Studio / OrcaSlicer แทน' };
      }
      if (!app.canShareFile(`check.${fileExt()}`)) {
        return { ok: false, text: app.isAndroid
          ? '✗ Chrome บน Android ไม่ยอมแชร์ไฟล์ 3MF/STL · เลือก “บันทึกลงเครื่องนี้” แล้วเปิดไฟล์จาก Downloads ด้วย Bambu Handy'
          : '✗ เบราว์เซอร์นี้แชร์ไฟล์ชนิดนี้ไม่ได้ · เลือก “บันทึกลงเครื่องนี้” แทน' };
      }
      return { ok: true, text: '✓ แชร์ได้ · ในหน้าต่างแชร์ให้เลือก Bambu Handy (ถ้าไม่มีในรายการ แปลว่าแอปไม่รับไฟล์นี้ ให้กด “บันทึกไปยัง ไฟล์” แล้วเปิดจาก Handy)' };
    }
    // slicers
    const name = TARGETS.find(t => t.id === id).label.replace(/^\S+\s/, '');
    if (isMobile && !fromServePy) return { ok: false, text: `✗ ${name} ใช้ได้บนคอม PC / Mac` };
    const info = await helperInfo();
    if (!info) {
      return { ok: false, text: `✗ ยังส่งไม่ได้ · ต้องเปิด serve.py บนคอมเครื่องนี้ก่อน (ดับเบิลคลิกไฟล์ serve.py ในโฟลเดอร์โปรแกรม แล้วกดตรวจอีกครั้ง)`
        + (!fromServePy && /Safari/.test(navigator.userAgent) && !/Chrome|Edg/.test(navigator.userAgent) ? ' · Safari บน Mac: เปิด http://localhost:8765 แทนลิงก์ GitHub' : '') };
    }
    if (!info.slicers[id]) return { ok: false, text: `✗ ไม่พบ ${name} ในคอม ${info.host} · ติดตั้งก่อน หรือเลือกโปรแกรมอื่น` };
    return { ok: true, text: `✓ ส่งได้ · จะเปิดใน ${name} บนคอม ${info.host}` };
  }

  // 3MF keeps the colors; a single-color piece has only the one-body STL.
  const multiColor = () => !document.getElementById('splitExport').classList.contains('hide');
  const fileExt = () => (multiColor() ? '3mf' : 'stl');

  function deliverTo(id) {
    if (id === 'device') return async (name, data) => {
      const saved = await app.saveFile(name, data);
      return saved ? { ok: true, filePath: saved } : { ok: false, reason: 'canceled' };
    };
    if (id === 'share') return async (name, data) => {
      const done = await app.shareFile(name, data);
      return done ? { ok: true, filePath: `${name} (แชร์แล้ว)` } : { ok: false, reason: 'canceled' };
    };
    return async (name, data) => {
      try {
        const r = await fetch(`${helperBase}/open-in?app=${id}&name=${encodeURIComponent(name)}`, {
          method: 'POST', body: data, headers: { 'Content-Type': 'application/octet-stream' }
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
        return { ok: true, filePath: `${name} → เปิดใน ${j.app} แล้ว` };
      } catch (e) {
        setStatus(false, `✗ ส่งไม่สำเร็จ: ${e.message || e}`);
        return { ok: false, reason: 'error' };
      }
    };
  }

  // ── UI ──
  const style = document.createElement('style');
  style.textContent = `
    #sendBox { margin: 10px 0 4px; padding-top: 10px; border-top: 1px solid var(--line); }
    #sendBox .send-row { display: flex; gap: 6px; align-items: center; }
    #sendBox select { flex: 1; min-width: 0; }
    #sendBox .send-check { font-size: 11px; line-height: 1.45; margin-top: 6px; color: var(--muted); }
    #sendBox .send-check.ok { color: #7ed38a; }
    #sendBox .send-check.bad { color: #ff9b7a; }
  `;
  document.head.appendChild(style);

  const box = document.createElement('div');
  box.id = 'sendBox';
  box.innerHTML = `
    <div class="send-row"><label style="white-space:nowrap">ส่งไปที่</label>
      <select id="sendTarget" title="เลือกว่าจะส่งไฟล์ไปที่ไหน"></select>
      <button id="sendCheck" title="ตรวจว่าส่งได้ไหม">ตรวจ</button>
      <button id="sendGo" class="primary">ส่ง ▶</button></div>
    <div class="send-check" id="sendCheckText"></div>`;
  const select = box.querySelector('#sendTarget');
  for (const t of TARGETS) select.add(new Option(t.label, t.id));
  select.value = app.lsGet('sendTarget', isMobile ? 'share' : 'device');
  if (!select.value) select.value = 'device';
  const statusEl = box.querySelector('#sendCheckText');
  const goBtn = box.querySelector('#sendGo');

  function setStatus(ok, text) {
    statusEl.textContent = text;
    statusEl.className = `send-check ${ok == null ? '' : ok ? 'ok' : 'bad'}`;
  }

  let lastCheck = null;
  async function runCheck() {
    const id = select.value;
    setStatus(null, 'กำลังตรวจ...');
    const res = await check(id);
    if (select.value !== id) return null; // changed meanwhile
    lastCheck = { id, ...res };
    setStatus(res.ok, `${res.text} · ไฟล์ ${fileExt().toUpperCase()}`);
    goBtn.disabled = !res.ok;
    return res;
  }

  // Exports started by our button go to the chosen target; any other export button saves as usual.
  let sending = false;
  document.addEventListener('click', (e) => {
    if (!sending && e.target.closest && e.target.closest('#export3mf, #exportSplitStl, #exportStl, #exportObj')) app.setExportTarget(null);
  }, true);

  async function send() {
    const id = select.value;
    // share needs the tap itself, so don't wait for a network check first
    const res = (id === 'share' || id === 'device') ? await check(id) : await runCheck();
    if (!res || !res.ok) { setStatus(false, res ? res.text : '✗ ตรวจไม่ผ่าน'); return; }
    app.setExportTarget(deliverTo(id));
    sending = true;
    document.getElementById(multiColor() ? 'export3mf' : 'exportStl').click();
    sending = false;
  }

  select.addEventListener('change', (e) => { e.stopPropagation(); app.lsSet('sendTarget', select.value); runCheck(); });
  select.addEventListener('input', (e) => e.stopPropagation());
  box.querySelector('#sendCheck').addEventListener('click', runCheck);
  goBtn.addEventListener('click', send);

  function mount() {
    const status = document.getElementById('exportStatus');
    if (!status) return false;
    status.before(box);
    runCheck();
    return true;
  }
  if (!mount()) document.addEventListener('DOMContentLoaded', mount);
})();
