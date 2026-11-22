// Font picker: every installed font in a virtual-scrolled dropdown (only visible rows are in the
// DOM, so hundreds of live font previews stay fast), favorites (★) pinned at the top, and each
// row previewing sample text in that font. Opening shows the full list; typing filters it.

const ROW_H = 48;
const HEADER_H = 26;

export function createFontPicker({ input, getCurrent, getSampleText, onPick, loadFavorites, saveFavorites }) {
  let fonts = [];
  let favorites = [];
  let rows = [];         // [{ type: 'header', label } | { type: 'font', name, fav }]
  let offsets = [];      // top px of each row
  let isOpen = false;
  let highlight = -1;    // index into rows (font rows only)

  const dropdown = document.createElement('div');
  dropdown.className = 'font-dropdown hide';
  const spacer = document.createElement('div');
  spacer.className = 'font-spacer';
  dropdown.appendChild(spacer);
  document.body.appendChild(dropdown);

  loadFavorites().then(list => { favorites = Array.isArray(list) ? list : []; if (isOpen) rebuild(input.value); });

  function setFonts(list) { fonts = list; }

  function rebuild(filter) {
    const q = (filter || '').trim().toLowerCase();
    const match = (f) => !q || f.toLowerCase().includes(q);
    const installed = new Set(fonts);
    const favSet = new Set(favorites);
    const favRows = favorites.filter(f => installed.has(f) && match(f));
    const allRows = fonts.filter(match);
    rows = [];
    if (favRows.length) {
      rows.push({ type: 'header', label: '★ ฟอนต์ที่ใช้บ่อย' });
      for (const name of favRows) rows.push({ type: 'font', name, fav: true });
    }
    rows.push({ type: 'header', label: q ? `ผลการค้นหา (${allRows.length})` : `ฟอนต์ทั้งหมด (${allRows.length})` });
    for (const name of allRows) rows.push({ type: 'font', name, fav: favSet.has(name) });
    offsets = [];
    let y = 0;
    for (const r of rows) { offsets.push(y); y += r.type === 'header' ? HEADER_H : ROW_H; }
    spacer.style.height = `${y}px`;
    const current = getCurrent();
    highlight = q ? rows.findIndex(r => r.type === 'font')
                  : rows.findIndex(r => r.type === 'font' && r.name === current);
    render();
  }

  function render() {
    const top = dropdown.scrollTop, bottom = top + dropdown.clientHeight;
    const sample = getSampleText();
    const current = getCurrent();
    spacer.innerHTML = '';
    for (let i = 0; i < rows.length; i++) {
      const rTop = offsets[i];
      const rH = rows[i].type === 'header' ? HEADER_H : ROW_H;
      if (rTop + rH < top - ROW_H * 3) continue;
      if (rTop > bottom + ROW_H * 3) break;
      const r = rows[i];
      const el = document.createElement('div');
      el.style.top = `${rTop}px`;
      if (r.type === 'header') {
        el.className = 'font-header';
        el.textContent = r.label;
      } else {
        el.className = `font-row${i === highlight ? ' highlight' : ''}${r.name === current ? ' current' : ''}`;
        el.dataset.index = i;
        const star = document.createElement('button');
        star.className = `font-star${r.fav ? ' on' : ''}`;
        star.textContent = r.fav ? '★' : '☆';
        star.title = r.fav ? 'เอาออกจากที่ใช้บ่อย' : 'เพิ่มในที่ใช้บ่อย';
        star.dataset.star = r.name;
        const info = document.createElement('div');
        info.className = 'font-info';
        const name = document.createElement('div');
        name.className = 'font-name';
        name.textContent = r.name;
        const sampleEl = document.createElement('div');
        sampleEl.className = 'font-sample';
        sampleEl.style.fontFamily = `"${r.name}", "Segoe UI"`;
        sampleEl.textContent = sample;
        info.append(name, sampleEl);
        el.append(star, info);
      }
      spacer.appendChild(el);
    }
  }

  function position() {
    const rect = input.getBoundingClientRect();
    const width = Math.max(rect.width, 300);
    dropdown.style.left = `${Math.min(rect.left, window.innerWidth - width - 8)}px`;
    dropdown.style.top = `${rect.bottom + 4}px`;
    dropdown.style.width = `${width}px`;
    dropdown.style.maxHeight = `${Math.max(160, Math.min(460, window.innerHeight - rect.bottom - 16))}px`;
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    input.classList.add('searching');
    position();
    dropdown.classList.remove('hide');
    rebuild('');
    if (highlight >= 0) dropdown.scrollTop = Math.max(0, offsets[highlight] - ROW_H * 2);
    render();
    input.select();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    dropdown.classList.add('hide');
    input.classList.remove('searching');
    sync();
  }

  function pick(name) {
    onPick(name);
    close();
    input.blur();
  }

  function toggleFavorite(name) {
    favorites = favorites.includes(name) ? favorites.filter(f => f !== name) : [...favorites, name].sort((a, b) => a.localeCompare(b));
    saveFavorites(favorites);
    const scroll = dropdown.scrollTop;
    rebuild(input.value === getCurrent() ? '' : input.value);
    dropdown.scrollTop = scroll;
    render();
  }

  function moveHighlight(dir) {
    let i = highlight;
    do { i += dir; } while (i >= 0 && i < rows.length && rows[i].type !== 'font');
    if (i < 0 || i >= rows.length) return;
    highlight = i;
    const t = offsets[i];
    if (t < dropdown.scrollTop) dropdown.scrollTop = t - HEADER_H;
    else if (t + ROW_H > dropdown.scrollTop + dropdown.clientHeight) dropdown.scrollTop = t + ROW_H - dropdown.clientHeight;
    render();
  }

  // Shows the current font name, displayed in that font.
  function sync() {
    if (isOpen) return;
    const current = getCurrent() || '';
    input.value = current;
    input.style.fontFamily = current ? `"${current}", "Segoe UI"` : '';
  }

  input.addEventListener('focus', open);
  input.addEventListener('click', open);
  input.addEventListener('input', () => { if (!isOpen) open(); rebuild(input.value); dropdown.scrollTop = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveHighlight(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveHighlight(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (rows[highlight]?.type === 'font') pick(rows[highlight].name); }
    else if (e.key === 'Escape') { close(); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 120));
  dropdown.addEventListener('scroll', render);
  // mousedown default would blur the input and close the list before the click lands.
  dropdown.addEventListener('mousedown', (e) => e.preventDefault());
  dropdown.addEventListener('click', (e) => {
    const starName = e.target.dataset?.star;
    if (starName) { toggleFavorite(starName); return; }
    const row = e.target.closest('.font-row');
    if (row) pick(rows[+row.dataset.index].name);
  });
  window.addEventListener('resize', () => { if (isOpen) { position(); render(); } });
  document.addEventListener('scroll', (e) => { if (isOpen && !dropdown.contains(e.target)) close(); }, true);

  return { setFonts, sync, close };
}
