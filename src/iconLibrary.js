// Icon library dialog: built-in icons shipped with the app (read-only) + the user's own icons
// (added from files, deletable). Clicking an icon inserts it as an image element.

const BUILTIN_LABELS = {
  heart: 'หัวใจ', star: 'ดาว', paw: 'รอยเท้าแมว', crown: 'มงกุฎ', moon: 'พระจันทร์', lightning: 'สายฟ้า',
  cloud: 'เมฆ', flower: 'ดอกไม้', music: 'ตัวโน้ต', bone: 'กระดูก', fish: 'ปลา', cat: 'หน้าแมว', donut: 'โดนัท'
};

export function createIconLibrary({ onPick }) {
  const overlay = document.createElement('div');
  overlay.className = 'icon-overlay hide';
  overlay.innerHTML = `
    <div class="icon-dialog">
      <div class="icon-head">
        <h3>ไอคอนสำเร็จรูป</h3>
        <button class="icon-add primary">+ เพิ่มไอคอนของฉัน</button>
        <button class="icon-close" title="ปิด">✕</button>
      </div>
      <div class="icon-body"></div>
      <div class="hint">คลิกไอคอนเพื่อเพิ่มลงชิ้นงาน · ไอคอนของฉันรับไฟล์ PNG / JPG / SVG (พื้นใสจะได้ผลดีที่สุด) · ลบได้เฉพาะไอคอนที่เพิ่มเอง</div>
    </div>`;
  document.body.appendChild(overlay);
  const body = overlay.querySelector('.icon-body');

  function section(title, icons, emptyText) {
    const h = document.createElement('div');
    h.className = 'icon-section';
    h.textContent = title;
    body.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'icon-grid';
    if (!icons.length) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = emptyText;
      grid.appendChild(empty);
    }
    for (const icon of icons) {
      const card = document.createElement('div');
      card.className = 'icon-card';
      card.title = icon.name;
      const img = document.createElement('img');
      img.src = icon.dataUrl;
      img.alt = icon.name;
      const label = document.createElement('div');
      label.className = 'icon-label';
      label.textContent = icon.builtin ? (BUILTIN_LABELS[icon.name] || icon.name) : icon.name;
      card.append(img, label);
      if (!icon.builtin) {
        const del = document.createElement('button');
        del.className = 'icon-del';
        del.title = 'ลบไอคอนนี้';
        del.textContent = '✕';
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(`ลบไอคอน "${icon.name}" ออกจากคลัง?`)) return;
          await window.api.deleteIcon(icon.file);
          refresh();
        });
        card.appendChild(del);
      }
      card.addEventListener('click', () => {
        close();
        onPick({ name: label.textContent, dataUrl: icon.dataUrl });
      });
      grid.appendChild(card);
    }
    body.appendChild(grid);
  }

  async function refresh() {
    const icons = await window.api.listIcons();
    body.innerHTML = '';
    section('ไอคอนมาตรฐาน', icons.filter(i => i.builtin), 'ไม่พบไอคอนมาตรฐาน');
    section('ไอคอนของฉัน', icons.filter(i => !i.builtin), 'ยังไม่มี — กด “+ เพิ่มไอคอนของฉัน” เพื่อเพิ่มจากไฟล์');
  }

  function open() { overlay.classList.remove('hide'); refresh(); }
  function close() { overlay.classList.add('hide'); }

  overlay.querySelector('.icon-close').addEventListener('click', close);
  overlay.querySelector('.icon-add').addEventListener('click', async () => {
    if (await window.api.addIcons()) refresh();
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.classList.contains('hide')) close(); });

  return { open, close };
}
