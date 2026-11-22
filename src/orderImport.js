// Order sheets from the KeychainShop website (KeychainShop/index.html → "ดาวน์โหลดใบงาน").
// THE CONTRACT IS D:\Dropbox\_00_PROGRAME_PRINT_3D\ORDER_FORMAT.md — read it before changing this
// file, and log changes / tick tasks there.
// File: { "เวอร์ชันสเปก": 2, "วันที่": ISO, "รายการ": [ { ลำดับ, จำนวน, ราคา, ...spec, รูปลูกค้า? } ] }
// Each item is turned into a "design" (settings + element partials) that app.js applies.
// Coordinates: mm, x right, y up. Spec v2 gives direct centers (text box, icon, key-ring hole);
// v1 (no "เวอร์ชันสเปก") has none: text at (0,0), icon beside the text with a 2 mm gap on the
// chosen side plus the customer's drag offset, hole placed automatically.

// Filament names used by the website → hex (same list as KeychainShop FILAMENTS).
const FILAMENTS = {
  'ขาว': '#f5f5f5', 'ดำ': '#1c1c1c', 'แดง': '#d62828', 'ส้ม': '#f77f00', 'เหลือง': '#fcbf49', 'เขียว': '#2a9d8f',
  'น้ำเงิน': '#1d4ed8', 'ชมพู': '#f4a6c6', 'ม่วง': '#7b2cbf', 'เทา': '#9ca3af', 'ทอง silk': '#c9a227'
};
// Website icon names → built-in icon files (assets/icons).
const ICONS = {
  'หัวใจ': 'heart', 'ดาว': 'star', 'รอยเท้าแมว': 'paw', 'มงกุฎ': 'crown', 'พระจันทร์': 'moon', 'สายฟ้า': 'lightning',
  'เมฆ': 'cloud', 'ดอกไม้': 'flower', 'ตัวโน้ต': 'music', 'กระดูก': 'bone', 'ปลา': 'fish', 'หน้าแมว': 'cat', 'โดนัท': 'donut'
};
const BORDERS = { 'ตามรูปร่าง': 'contour', 'สี่เหลี่ยมมุมมน': 'rect', 'แคปซูล': 'capsule', 'วงรี': 'ellipse' };
const TEXT_GAP_MM = 2; // website: gap = 2 * S

// A { x, y } point from the order, or null when absent / not numeric.
const point = (v) => (v && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y)) ? { x: Number(v.x), y: Number(v.y) } : null);

const colorHex = (name, fallback) => (name && (FILAMENTS[name] || (/^#[0-9a-f]{6}$/i.test(name) ? name : null))) || fallback;

// → { label, exportName, warnings[], settings, parts[] }
export async function orderItemToDesign(item, { installedFonts, builtinIcons, orderName }) {
  const warnings = [];
  const raised = String(item['แบบ'] || '').startsWith('สองระดับ');
  const text = String(item['ข้อความ'] ?? '').trim();
  const font = item['ฟอนต์'] || 'Arial';
  const bold = item['ตัวหนา'] !== false;
  const textH = Number(item['ความสูงตัวอักษร_mm']) || 10;
  const colors = item['สี'] || {};
  const thick = item['ความหนา_mm'] || {};
  const hole = item['รูห่วง'] || {};

  let fontToUse = font;
  if (installedFonts.length && !installedFonts.includes(font)) {
    warnings.push(`ฟอนต์ “${font}” ไม่ได้ติดตั้งในเครื่อง — ใช้ Arial แทน (ติดตั้งฟอนต์แล้วรีสตาร์ทโปรแกรม แล้วโหลดใบงานใหม่)`);
    fontToUse = 'Arial';
  }

  // Text advance width exactly as the website measures it (for the icon's default position).
  let twMM = 0;
  if (text) {
    const style = `${bold ? 700 : 400} 100px "${fontToUse}"`;
    try { await document.fonts.load(style, text); } catch { /* system font */ }
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = style;
    twMM = Math.max(...text.split('\n').filter(l => l.trim()).map(l => ctx.measureText(l).width)) / 100 * textH;
  }

  // v2: direct center of the text box; v1: (0,0). anchorLayout → app.js places the website's
  // layout-box center (not the ink bbox) on this point.
  const textPos = point(item['ตำแหน่งข้อความ_mm']) || { x: 0, y: 0 };
  const parts = [];
  if (text) {
    parts.push({
      type: 'text', text, font: fontToUse, bold, fontSizeMM: textH, x: textPos.x, y: textPos.y, anchorLayout: true,
      color: colorHex(raised ? colors['ตัวหนังสือนูน'] : colors['เนื้องาน (ข้อความ/ไอคอน)'], '#f5f5f5')
    });
  }

  const iconLabel = String(item['ไอคอน'] || 'ไม่มี');
  const iconMM = Number(item['ขนาดไอคอน_mm']) || 14;
  const off = item['เลื่อนไอคอนจากตำแหน่งเริ่มต้น_mm'] || { x: 0, y: 0 };
  const side = String(item['ตำแหน่งไอคอน'] || '').startsWith('ขวา') ? 1 : -1;
  // v2: direct icon center; v1: beside the text (website v1 rule) + drag offset.
  const iconPos = point(item['ตำแหน่งไอคอน_mm']) || {
    x: textPos.x + side * (twMM / 2 + (text ? TEXT_GAP_MM : 0) + iconMM / 2) + (Number(off.x) || 0),
    y: textPos.y + (Number(off.y) || 0)
  };
  const iconX = iconPos.x, iconY = iconPos.y;
  const iconColor = colorHex(raised ? colors['ไอคอนนูน'] : colors['เนื้องาน (ข้อความ/ไอคอน)'], '#d62828');
  if (iconLabel.startsWith('รูปลูกค้า')) {
    if (item['รูปลูกค้า']) {
      const imgMode = iconLabel.includes('สีเข้ม') ? 'dark' : iconLabel.includes('สีอ่อน') ? 'light' : 'alpha';
      parts.push({ type: 'image', dataUrl: item['รูปลูกค้า'], name: `รูปลูกค้า #${item['ลำดับ']}`, imgMode, fitMM: iconMM, fitFull: true, anchorLayout: true, x: iconX, y: iconY, color: iconColor });
    } else {
      warnings.push('ใบงานระบุว่ามีรูปลูกค้า แต่ไม่มีข้อมูลรูปแนบมา');
    }
  } else if (iconLabel !== 'ไม่มี') {
    const file = ICONS[iconLabel];
    const icon = file && builtinIcons.find(i => i.name === file);
    if (icon) parts.push({ type: 'image', dataUrl: icon.dataUrl, name: iconLabel, imgMode: 'alpha', fitMM: iconMM, fitFull: true, anchorLayout: true, x: iconX, y: iconY, color: iconColor });
    else warnings.push(`ไม่รู้จักไอคอน “${iconLabel}”`);
  }
  if (!parts.length) warnings.push('รายการนี้ไม่มีข้อความและไอคอน');

  const shape = BORDERS[item['ขอบรอบนอก']] || 'contour';
  if (!BORDERS[item['ขอบรอบนอก']]) warnings.push(`ไม่รู้จักขอบ “${item['ขอบรอบนอก']}” — ใช้ “ตามรูปร่าง”`);
  parts.push({
    type: 'base', baseStyle: raised ? 'raised' : 'flat', outlineOn: true, outlineShape: shape,
    outlineMM: Number(item['ระยะขอบ_mm']) || 0, outlineSmoothMM: Number(item['ความsmooth']) || 0,
    outlineFilletMM: 3, outlineFlatness: 12,
    color: colorHex(colors['ฐาน'], '#1d4ed8')
  });

  const holePos = point(hole['ตำแหน่ง_mm']); // v2 only; v1 → automatic
  const settings = {
    // fallbacks = the website's defaults (ORDER_FORMAT.md §3): flat 2 · base 2 + element 1
    thicknessMM: Number(raised ? thick['ฐาน'] : thick['ชิ้นงาน']) || 2,
    elementThicknessMM: Number(thick['element']) || 1,
    fillHoles: item['ถมช่องใน'] !== false,
    splitColors: true,
    bodyColor: colorHex(colors['เนื้องาน (ข้อความ/ไอคอน)'], '#f5f5f5'),
    borderColor: colorHex(colors['ขอบ + ห่วง'], '#1d4ed8'),
    holeEnabled: true, holeDiameterMM: Number(hole['ขนาดรู_mm']) || 5, holeRingMM: Number(hole['ขอบรอบรู_mm']) || 2.5,
    holeShape: 'circle', holeX: holePos ? holePos.x : null, holeY: holePos ? holePos.y : null,
    outlineMM: 0, joinSmoothMM: 0,
    // An order defines its own size — don't let the size locks rescale it.
    lockW: false, lockH: false, lockZ: false,
    // The website has no chamfer — start from square edges so the print matches the preview.
    chamferTopMM: 0, chamferBottomMM: 0
  };

  // Website's own size estimate, only for a sanity check after building (v2 {w,h,t}; v1 {x,y}).
  const est = item['ขนาดโดยประมาณ_mm'];
  const expectedSize = est && typeof est === 'object'
    ? { w: Number(est.w ?? est.x) || null, h: Number(est.h ?? est.y) || null, t: Number(est.t) || null }
    : null;

  const no = item['ลำดับ'] ?? '?';
  return {
    label: `#${no} ${text.split('\n')[0] || iconLabel}`,
    exportName: `${orderName.replace(/\.json$/i, '')}_${no}_${(text.split('\n')[0] || 'keychain').slice(0, 24)}`,
    warnings, settings, parts, expectedSize, specVersion: textPos && item['ตำแหน่งข้อความ_mm'] ? 2 : 1
  };
}

// ── Order list dialog ──
export function createOrderDialog({ onOpenItem, onExportAll }) {
  const overlay = document.createElement('div');
  overlay.className = 'icon-overlay hide';
  overlay.innerHTML = `
    <div class="icon-dialog">
      <div class="icon-head">
        <h3 class="order-title">ใบงาน</h3>
        <button class="order-export-all">⬇ Export ทั้งใบงาน (3MF)</button>
        <button class="order-load primary">📂 โหลดใบงานอื่น</button>
        <button class="icon-close" title="ปิด">✕</button>
      </div>
      <div class="icon-body order-body"></div>
      <div class="hint">กด “เปิดในโปรแกรม” เพื่อสร้างงานของรายการนั้น (แทนงานที่เปิดอยู่ — กด Ctrl+Z เพื่อย้อนได้) · เมนู ไฟล์ → รายการในใบงาน (Ctrl+L) เพื่อกลับมาที่หน้านี้</div>
    </div>`;
  document.body.appendChild(overlay);
  const body = overlay.querySelector('.order-body');
  let current = null;

  const esc = (v) => String(v ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  function render() {
    body.innerHTML = '';
    if (!current) { body.innerHTML = '<div class="empty">ยังไม่ได้โหลดใบงาน</div>'; return; }
    const { name, data, error } = current;
    overlay.querySelector('.order-title').textContent = `ใบงาน: ${name}`;
    if (error || !data || !Array.isArray(data['รายการ'])) {
      body.innerHTML = `<div class="empty">อ่านไฟล์นี้ไม่ได้ — ไม่ใช่ใบงานจากเว็บ${error ? `<br><small>${esc(error)}</small>` : ''}</div>`;
      return;
    }
    const date = data['วันที่'] ? new Date(data['วันที่']).toLocaleString('th-TH') : '-';
    const version = Number(data['เวอร์ชันสเปก']) || 1;
    const items = data['รายการ'];
    const total = items.reduce((s, it) => s + (Number(it['ราคา']) || 0) * (Number(it['จำนวน']) || 1), 0);
    const head = document.createElement('div');
    head.className = 'hint';
    head.innerHTML = `วันที่สั่ง: <b>${esc(date)}</b> · ${items.length} รายการ · รวม ${total.toLocaleString()} บาท · ใบงานเวอร์ชัน ${version}`;
    body.appendChild(head);
    if (!items.length) {
      body.insertAdjacentHTML('beforeend', '<div class="empty">ใบงานนี้ไม่มีรายการ (ตะกร้าว่างตอนดาวน์โหลดใบงาน)</div>');
      return;
    }
    items.forEach((it, idx) => {
      const card = document.createElement('div');
      card.className = 'order-card';
      const colors = Object.entries(it['สี'] || {}).map(([k, v]) => `${esc(k)}: <b>${esc(v)}</b>`).join(' · ');
      const size = it['ขนาดโดยประมาณ_mm'];
      card.innerHTML = `
        ${it['รูปลูกค้า'] ? `<img src="${esc(it['รูปลูกค้า'])}" alt="">` : ''}
        <div class="order-info">
          <div class="order-name">#${esc(it['ลำดับ'] ?? idx + 1)} “${esc(it['ข้อความ'] || '')}” <span class="badge">${esc(String(it['แบบ'] || '').split(' ')[0])}</span></div>
          <div class="hint">ฟอนต์ ${esc(it['ฟอนต์'])}${it['ตัวหนา'] ? ' (หนา)' : ''} · สูง ${esc(it['ความสูงตัวอักษร_mm'])} mm · ไอคอน: ${esc(it['ไอคอน'])} · ขอบ: ${esc(it['ขอบรอบนอก'])} ${esc(it['ระยะขอบ_mm'])} mm</div>
          <div class="hint">${colors}${size ? ` · ขนาดประมาณ ${esc(typeof size === 'object' ? Object.values(size).join(' × ') : size)} mm` : ''}</div>
          ${it['หมายเหตุลูกค้า'] ? `<div class="order-note">📝 ${esc(it['หมายเหตุลูกค้า'])}</div>` : ''}
          <div class="order-qty">จำนวน <b>${esc(it['จำนวน'] ?? 1)}</b> ชิ้น · ${esc(it['ราคา'] ?? '-')} บาท/ชิ้น</div>
        </div>
        <button class="primary order-open">เปิดในโปรแกรม</button>`;
      card.querySelector('.order-open').addEventListener('click', async () => {
        close();
        await onOpenItem(it, name);
      });
      body.appendChild(card);
    });
  }

  function open() { render(); overlay.classList.remove('hide'); }
  function close() { overlay.classList.add('hide'); }
  function load(payload) { current = payload; open(); }

  overlay.querySelector('.icon-close').addEventListener('click', close);
  overlay.querySelector('.order-load').addEventListener('click', () => window.api.openOrder());
  overlay.querySelector('.order-export-all').addEventListener('click', async () => {
    const items = current?.data?.['รายการ'];
    if (!Array.isArray(items) || !items.length) { alert('ใบงานนี้ไม่มีรายการให้ export'); return; }
    close();
    await onExportAll(items, current.name);
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.classList.contains('hide')) close(); });
  return { open, load };
}
