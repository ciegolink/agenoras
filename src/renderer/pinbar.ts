// Pin sidebar: own column on the right of the main window, in every view.
// Pinned tasks and feed articles as cards that fold open and closed. Stored in the main process (pins.ts).

const PIN_KIND_ICONS = {
  task: svgIco('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>', 13),
  feed: svgIco('<path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14"/><circle cx="6" cy="18" r="1.5"/>', 13),
  mail: svgIco('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>', 13),
};

let pinItems: PinItem[] = [];
let pinbarOpen = (() => {
  try {
    return localStorage.getItem('pins.open') === '1';
  } catch {
    return false;
  }
})();

function setPinbar(open: boolean): void {
  pinbarOpen = open;
  try {
    localStorage.setItem('pins.open', open ? '1' : '0');
  } catch {
    /* ignore */
  }
  paintPinbar();
}

function paintPinbar(): void {
  document.body.classList.toggle('pins-on', pinbarOpen);
  // title bar button: always there, pressed while the column is open
  el('#tb-pins').classList.toggle('on', pinbarOpen);
  el('#tb-pins').setAttribute('aria-pressed', String(pinbarOpen));
  el('#tb-pins-n').textContent = pinItems.length ? String(pinItems.length) : '';
  el('#pinbar-n').textContent = pinItems.length ? String(pinItems.length) : '';
  el('#pinbar-list').innerHTML = pinItems.length
    ? pinItems
        .map(
          (p) => `<section class="pin-card${p.collapsed ? ' collapsed' : ''}${p.done ? ' done' : ''}" data-key="${esc(p.key)}" style="--pc:${p.color}">
        <div class="pin-card-head" role="button" tabindex="0" data-pin-toggle aria-expanded="${!p.collapsed}">
          <span class="chev">›</span><span class="kind">${PIN_KIND_ICONS[p.kind]}</span><span class="tt" title="${esc(p.title)}">${esc(p.title)}</span>
          <button type="button" class="unpin" data-unpin aria-label="${esc(t('pins.unpin'))}" title="${esc(t('pins.unpin'))}">×</button>
        </div>
        <div class="pin-card-body">
          ${p.meta.length ? `<div class="meta">${p.meta.map((m) => `<span class="${esc(m.cls ?? '')}">${esc(m.text)}</span>`).join('')}</div>` : ''}
          ${p.text.trim() ? `<div class="text">${linkText(esc(p.text.trim()))}</div>` : ''}
          ${p.link ? `<button type="button" class="link" data-pin-link>${esc(t('rss.openBrowser'))} ↗</button>` : ''}
          ${p.mail ? `<button type="button" class="link" data-pin-mail>${esc(t('pins.openMail'))} ↗</button>` : ''}
        </div>
      </section>`,
        )
        .join('')
    : `<div class="pinbar-empty">${esc(t('pins.empty'))}</div>`;
}

el('#pinbar-list').addEventListener('click', (e) => {
  const tgt = e.target as HTMLElement;
  const key = tgt.closest<HTMLElement>('[data-key]')?.dataset.key;
  const p = pinItems.find((x) => x.key === key);
  if (!p) return;
  if (tgt.closest('[data-unpin]')) return void window.api.pins.remove(p.key);
  if (tgt.closest('[data-pin-link]') && p.link) return void window.open(p.link, '_blank');
  if (tgt.closest('[data-pin-mail]') && p.mail) return void window.api.mailview.open(p.mail);
  if (tgt.closest('[data-pin-toggle]')) void window.api.pins.toggle(p.key);
});
el('#pinbar-list').addEventListener('keydown', (e) => {
  const head = (e.target as HTMLElement).closest<HTMLElement>('[data-pin-toggle]');
  if (head && e.target === head && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    head.click();
  }
});

document.querySelector('#pinbar .pinbar-ico')!.innerHTML = PIN_ICON;
document.querySelector('#tb-pins .tb-pin-ico')!.innerHTML = PIN_ICON;
el('#tb-pins').addEventListener('click', () => setPinbar(!pinbarOpen));

window.api.pins.onChanged((items) => {
  const added = items.length > pinItems.length;
  const emptied = pinItems.length > 0 && !items.length;
  pinItems = items;
  if (added && !pinbarOpen) setPinbar(true); // something new pinned: show it
  else if (emptied && pinbarOpen) setPinbar(false); // last one unpinned: close again
  else paintPinbar();
});
window.api.pins
  .list()
  .then((items) => {
    pinItems = items;
    paintPinbar();
  })
  .catch(() => paintPinbar());
