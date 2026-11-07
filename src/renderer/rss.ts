// Feed view. Uses helpers from common.ts, reader.ts and renderer.ts.
// The Feed button is only shown when there is at least one feed.

let rssFeeds: RssFeed[] = [];
let rssItems: RssItem[] = [];
let currentFeed: string | null = null;
let selectedRss = '';
let rssFilter: 'all' | 'unread' = 'all';
let rssArchive = false; // the Archive folder of currentFeed is open
let rssStarred = false; // "Important": starred articles of all feeds
let rssDragging = false; // show "Important" as a drop target even when empty
let pickedRss = new Set<string>(); // multi-select (Ctrl/Shift+click, Ctrl+A)
let anchorRss = '';
let shownRssKeys: string[] = [];
let rssLoading: Promise<void> | null = null;
let rssLastLoad = 0;

const RSS_PALETTE = ['#E0A458', '#2BA89F', '#7FA6CF', '#B48EAD', '#E0574B', '#C1C8BE'];
const setRssStatus = (s: string) => (el('#rss-status').textContent = s);
const feedOf = (id: string) => rssFeeds.find((f) => f.id === id);
const feedColor = (id: string) => RSS_PALETTE[Math.max(0, rssFeeds.findIndex((f) => f.id === id)) % RSS_PALETTE.length];

// Hide the Feed button without feeds, leave the view if it was open
function syncRssNav(): void {
  const btn = document.querySelector<HTMLElement>('.view-btn[data-view="rss"]');
  if (btn) btn.hidden = !rssFeeds.length;
  if (!rssFeeds.length && el('.app').dataset.view === 'rss') setView('mail');
}

async function loadRss(): Promise<void> {
  try {
    const c = await window.api.rss.cached();
    rssFeeds = c.feeds;
    rssItems = c.items;
    syncRssNav();
    renderRss();
  } catch {
    /* cache empty */
  }
  if (!rssFeeds.length) return;
  setRssStatus(t('status.updating'));
  try {
    const res = await window.api.rss.list();
    rssFeeds = res.feeds;
    rssItems = res.items;
    rssLastLoad = Date.now();
    setRssStatus(res.errors.map((e) => `${feedOf(e.feedId)?.name ?? 'RSS'}: ${e.message}`).join(' · '));
  } catch (e) {
    setRssStatus(errMsg(e));
  }
  syncRssNav();
  renderRss();
}

function ensureRss(): Promise<void> {
  // stale after 15 min
  if (rssLoading && Date.now() - rssLastLoad > 15 * 60_000) rssLoading = null;
  rssLoading ??= loadRss();
  return rssLoading;
}

document.addEventListener('viewchange', (e) => {
  if ((e as CustomEvent<string>).detail === 'rss') ensureRss();
});

// "Important" like in mail: only with starred articles (or while dragging)
function paintRssStarred(): void {
  const starred = rssItems.filter((i) => i.flagged).length;
  if (!starred && rssStarred && !rssDragging) rssStarred = false;
  el('#rss-virtual').innerHTML = starred || rssDragging
    ? `<button class="box vbox${rssStarred ? ' active' : ''}" data-feed="" data-starred="1"><span class="vico star-ico">★</span><span class="name">${esc(t('mail.flaggedView'))}</span><span class="count">${starred || ''}</span></button>`
    : '';
}

// Sidebar
function renderRss(): void {
  const unread = (feedId?: string) => rssItems.filter((i) => !i.read && !i.archived && (!feedId || i.feedId === feedId)).length;
  const all = unread();
  el('#rss-count').textContent = all ? String(all) : '';
  paintNavBadge('rss', all); // unread like an inbox
  document.dispatchEvent(new Event('rsschange'));
  el('#feed-list').innerHTML = rssFeeds
    .map((f) => {
      const n = unread(f.id);
      return `<button class="box${currentFeed === f.id && !rssArchive ? ' active' : ''}" data-feed="${esc(f.id)}"><span class="dot" style="background:${feedColor(f.id)}"></span><span class="name">${esc(f.name)}</span><span class="count">${n || ''}</span></button>
        <button class="box feed-archive${currentFeed === f.id && rssArchive ? ' active' : ''}" data-feed="${esc(f.id)}" data-archive="1">${ACT_ICONS.archive}<span class="name">${esc(t('folder.archive'))}</span></button>`;
    })
    .join('');
  paintRssStarred();
  document.querySelector<HTMLElement>('#side-rss .box[data-feed=""]:not([data-starred])')?.classList.toggle('active', !currentFeed && !rssStarred);
  document.querySelectorAll<HTMLElement>('#rss-filter [data-rfilter]').forEach((b) => b.classList.toggle('on', b.dataset.rfilter === rssFilter));
  const feed = currentFeed ? feedOf(currentFeed) : null;
  el('#rss-heading').textContent = feed ? feed.name : rssStarred ? t('mail.flaggedView') : t('rss.heading');
  // the archive count only matters inside the archive, not in the sidebar
  const archived = rssArchive ? rssItems.filter((i) => i.archived && i.feedId === currentFeed).length : 0;
  el('#rss-title').textContent = rssStarred ? t(rssFilter === 'unread' ? 'rss.titleUnread' : 'rss.titleAll') : rssArchive ? (archived ? t('rss.titleArchiveN', { n: archived }) : t('rss.titleArchive')) : t(rssFilter === 'unread' ? 'rss.titleUnread' : 'rss.titleAll');
  renderRssList();
}

el('#side-rss').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-feed]');
  if (!b) return;
  currentFeed = b.dataset.feed || null;
  rssArchive = !!currentFeed && !!b.dataset.archive;
  rssStarred = !currentFeed && !!b.dataset.starred;
  renderRss();
});
el('#btn-new-feed').addEventListener('click', () => openAddFeed());

// List
// keys matching the filter, null = no filter
let rssHitKeys: Set<string> | null = null;
let rssSearchTimer = 0;

function rssShown(): RssItem[] {
  // archived articles only show under Archive, "Important" shows starred ones wherever they are
  return rssItems.filter(
    (i) =>
      (!currentFeed || i.feedId === currentFeed) &&
      (rssStarred ? !!i.flagged : rssArchive ? !!i.archived : !i.archived) &&
      (rssFilter !== 'unread' || !i.read || i.key === selectedRss) &&
      (!rssHitKeys || rssHitKeys.has(i.key)),
  );
}

function renderRssList(): void {
  const shown = rssShown();
  shownRssKeys = shown.slice(0, 500).map((i) => i.key);
  const raw = el<HTMLInputElement>('#rss-search').value;
  el('#rss-list').innerHTML = shown.length
    ? shown
        .slice(0, 500)
        .map((i) => {
          const f = feedOf(i.feedId);
          return `<button class="mail rss-item${i.read ? '' : ' unread'}${i.key === selectedRss || pickedRss.has(i.key) ? ' selected' : ''}" data-rss="${esc(i.key)}" draggable="true">
          <span class="m-body">
            <span class="row"><span class="from">${esc(i.title || t('rss.untitled'))}</span><span class="time">${i.date ? esc(fmtShort(i.date)) : ''}</span><span class="star${i.flagged ? ' on' : ''}" data-rss-star role="button" title="${esc(t(i.flagged ? 'mail.unflag' : 'mail.flag'))}">${i.flagged ? '★' : '☆'}</span></span>
            ${!currentFeed && f ? `<span class="acc" style="color:${feedColor(f.id)}">${esc(f.name.toUpperCase())}</span>` : ''}
            ${i.snippet ? `<span class="snip">${esc(i.snippet)}</span>` : ''}
          </span>
        </button>`;
        })
        .join('') + (rssHitKeys ? searchElsewhereHtml(raw, true) : '')
    : rssHitKeys ? searchElsewhereHtml(raw, false) : `<div class="list-empty">${esc(t(rssFeeds.length ? (rssStarred ? 'rss.noStarred' : rssArchive ? 'rss.noArchived' : rssFilter === 'unread' ? 'rss.noUnread' : 'rss.noItems') : 'rss.noFeeds'))}</div>`;
}

el('#rss-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  el<HTMLInputElement>('#rss-search').value = '';
  el('#rss-search').dispatchEvent(new Event('input'));
});
el('#rss-search').addEventListener('input', () => {
  clearTimeout(rssSearchTimer);
  const q = el<HTMLInputElement>('#rss-search').value.trim();
  if (q.length < 2) {
    rssHitKeys = null;
    return renderRssList();
  }
  rssSearchTimer = window.setTimeout(async () => {
    const hits = await window.api.rss.search(q).catch(() => [] as RssItem[]);
    if (el<HTMLInputElement>('#rss-search').value.trim() !== q) return; // outdated
    rssHitKeys = new Set(hits.map((i) => i.key));
    renderRssList();
  }, 250);
});

el('#rss-filter').addEventListener('click', (e) => {
  const f = (e.target as HTMLElement).closest<HTMLElement>('[data-rfilter]')?.dataset.rfilter as typeof rssFilter | undefined;
  if (!f) return;
  rssFilter = f;
  renderRss();
});

el('#btn-rss-allread').addEventListener('click', async () => {
  const keys = rssShown().filter((i) => !i.read).map((i) => i.key);
  if (!keys.length) return;
  keys.forEach((k) => (rssItems.find((i) => i.key === k)!.read = true));
  renderRss();
  await window.api.rss.setRead(keys, true).catch((err) => setRssStatus(errMsg(err)));
});

el('#rss-list').addEventListener('click', (e) => {
  const key = (e.target as HTMLElement).closest<HTMLElement>('[data-rss]')?.dataset.rss;
  if (!key) return;
  // star in the row: toggle without opening
  if ((e.target as HTMLElement).closest('[data-rss-star]')) {
    const item = rssItems.find((i) => i.key === key);
    if (item) void flagRss([key], !item.flagged);
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    // the open article counts as picked
    if (!pickedRss.size && selectedRss) pickedRss.add(selectedRss);
    if (pickedRss.has(key)) pickedRss.delete(key);
    else pickedRss.add(key);
  } else if (e.shiftKey && anchorRss && shownRssKeys.includes(anchorRss)) {
    const [a, b] = [shownRssKeys.indexOf(anchorRss), shownRssKeys.indexOf(key)].sort((x, y) => x - y);
    pickedRss = new Set(shownRssKeys.slice(a, b + 1));
  } else {
    anchorRss = key;
    return void showRssItem(key);
  }
  if (!e.shiftKey) anchorRss = key;
  if (pickedRss.size === 1) return void showRssItem([...pickedRss][0]);
  selectedRss = '';
  if (pickedRss.size) renderRssMulti();
  else clearRssDetail();
  renderRssList();
});

// Several articles selected
function renderRssMulti(): void {
  const n = pickedRss.size;
  const inArchive = [...pickedRss].every((k) => rssItems.find((i) => i.key === k)?.archived);
  const allFlagged = [...pickedRss].every((k) => rssItems.find((i) => i.key === k)?.flagged);
  el('#rss-detail').innerHTML = `
    <div class="multi">
      <div class="multi-count">${n}</div>
      <h2>${t('rss.multiTitle')}</h2>
      <p class="hint">${esc(t('rss.multiHint'))}</p>
      <div class="multi-actions">
        <button class="btn ghost" data-rss-multi="${inArchive ? 'unarchive' : 'archive'}">${ACT_ICONS.archive} ${esc(t(inArchive ? 'rss.unarchive' : 'mail.archive'))}</button>
        <button class="btn ghost" data-rss-multi="${allFlagged ? 'unflag' : 'flag'}"><span class="star-ico">★</span> ${esc(t(allFlagged ? 'mail.unflag' : 'mail.flag'))}</button>
        <button class="btn ghost" data-rss-multi="read">${ACT_ICONS.read} ${esc(t('mail.markRead'))}</button>
        <button class="btn ghost" data-rss-multi="unread">${ACT_ICONS.unread} ${esc(t('mail.markUnread'))}</button>
        <button class="link" data-rss-multi="clear">${esc(t('mail.clearSelection'))}</button>
      </div>
    </div>`;
}

// Archive (or back to the inbox), then go on with the article that takes the first one's place
async function archiveRss(keys: string[], archived: boolean): Promise<void> {
  const gone = new Set(keys);
  const firstIdx = shownRssKeys.findIndex((k) => gone.has(k));
  const rest = shownRssKeys.filter((k) => !gone.has(k));
  rssItems.forEach((i) => gone.has(i.key) && (i.archived = archived));
  // the open article (or selection) stays unless it was moved
  if (gone.has(selectedRss) || [...pickedRss].some((k) => gone.has(k))) {
    pickedRss = new Set();
    selectedRss = '';
    const next = firstIdx >= 0 ? rest[Math.min(firstIdx, rest.length - 1)] : undefined;
    if (next) void showRssItem(next);
    else clearRssDetail();
  }
  renderRss();
  await window.api.rss.setArchived(keys, archived).catch((err) => setRssStatus(errMsg(err)));
}

async function flagRss(keys: string[], flagged: boolean): Promise<void> {
  const set = new Set(keys);
  rssItems.forEach((i) => set.has(i.key) && (i.flagged = flagged));
  renderRss();
  // open article: update its star button
  const btn = document.querySelector<HTMLElement>('#rss-detail [data-rss-flag]');
  if (btn && set.has(selectedRss)) paintRssStar(btn, flagged);
  await window.api.rss.setFlagged(keys, flagged).catch((err) => setRssStatus(errMsg(err)));
}

function paintRssStar(btn: HTMLElement, on: boolean): void {
  btn.classList.toggle('on', on);
  btn.textContent = on ? '★' : '☆';
  btn.setAttribute('aria-pressed', String(on));
  btn.title = t(on ? 'mail.unflag' : 'mail.flag');
  btn.setAttribute('aria-label', btn.title);
}

async function markRssKeys(keys: string[], read: boolean): Promise<void> {
  const set = new Set(keys);
  rssItems.forEach((i) => set.has(i.key) && (i.read = read));
  renderRss();
  await window.api.rss.setRead(keys, read).catch((err) => setRssStatus(errMsg(err)));
}

// Right-click: open, read / unread, archive. On a selected article it applies to the whole selection,
// otherwise only to that article (without opening it, that would mark it as read).
const rssMenu = document.createElement('div');
rssMenu.className = 'ctx-menu';
wireSubmenus(rssMenu);
rssMenu.setAttribute('role', 'menu');
rssMenu.hidden = true;
document.body.appendChild(rssMenu);
let rssMenuKeys: string[] = [];
const hideRssMenu = () => (rssMenu.hidden = true);

el('#rss-list').addEventListener('contextmenu', (e) => {
  const key = (e.target as HTMLElement).closest<HTMLElement>('[data-rss]')?.dataset.rss;
  if (!key) return;
  e.preventDefault();
  rssMenuKeys = pickedRss.has(key) ? [...pickedRss] : [key];
  const list = rssItems.filter((i) => rssMenuKeys.includes(i.key));
  const one = list.length === 1 ? list[0] : null;
  const anyUnread = list.some((i) => !i.read);
  const allArchived = list.every((i) => i.archived);
  const allFlagged = list.every((i) => i.flagged);
  const item = (action: string, ico: string, label: string) => `<button type="button" role="menuitem" data-rss-ctx="${action}">${ico}<span>${esc(label)}</span></button>`;
  rssMenu.innerHTML = [
    one?.link ? item('browser', ACT_ICONS.window, t('rss.openBrowser')) + '<hr>' : '',
    one ? item('pin', PIN_ICON, t('pins.pin')) : '',
    one ? ctxSub(svgIco('<path d="M4 12h12"/><path d="m12 6 6 6-6 6"/>'), t('convert.into'), item('toMail', ACT_ICONS.newMail, t('convert.intoMail')) + item('toEvent', ACT_ICONS.newEvent, t('convert.intoEvent')) + item('toTask', ACT_ICONS.newTask, t('convert.intoTask'))) + '<hr>' : '',
    anyUnread ? item('read', ACT_ICONS.read, t('mail.markRead')) : item('unread', ACT_ICONS.unread, t('mail.markUnread')),
    item(allFlagged ? 'unflag' : 'flag', `<span class="ctx-star">${allFlagged ? '☆' : '★'}</span>`, t(allFlagged ? 'mail.unflag' : 'mail.flag')),
    allArchived ? item('unarchive', ACT_ICONS.archive, t('rss.unarchive')) : item('archive', ACT_ICONS.archive, t('mail.archive')),
  ].join('');
  rssMenu.hidden = false;
  const r = rssMenu.getBoundingClientRect();
  rssMenu.style.left = `${Math.min(e.clientX, innerWidth - r.width - 6)}px`;
  rssMenu.style.top = `${Math.min(e.clientY, innerHeight - r.height - 6)}px`;
  rssMenu.querySelector<HTMLElement>('button')?.focus();
});

rssMenu.addEventListener('click', (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>('[data-rss-ctx]')?.dataset.rssCtx;
  if (!action) return;
  hideRssMenu();
  const keys = rssMenuKeys;
  const one = rssItems.find((i) => i.key === keys[0]);
  if (action === 'pin' && one) return void pinFeedItem(one);
  if ((action === 'toMail' || action === 'toEvent' || action === 'toTask') && one) {
    // summary and link, the full article stays on the website
    const text = [one.snippet, one.link].filter(Boolean).join('\n\n');
    void convertTo(action === 'toMail' ? 'mail' : action === 'toEvent' ? 'event' : 'task', one.title || t('rss.untitled'), text);
  } else if (action === 'browser') {
    const link = rssItems.find((i) => i.key === keys[0])?.link;
    if (link) window.open(link, '_blank');
  } else if (action === 'read' || action === 'unread') void markRssKeys(keys, action === 'read');
  else if (action === 'flag' || action === 'unflag') void flagRss(keys, action === 'flag');
  else void archiveRss(keys, action === 'archive');
});

document.addEventListener('mousedown', (e) => {
  if (!rssMenu.hidden && !rssMenu.contains(e.target as Node)) hideRssMenu();
});
// capture: Esc only closes the menu, the selection stays
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || rssMenu.hidden) return;
    e.stopPropagation();
    hideRssMenu();
  },
  true,
);
window.addEventListener('blur', hideRssMenu);
window.addEventListener('resize', hideRssMenu);
el('#rss-list').addEventListener('scroll', hideRssMenu);

// Drag articles onto a feed's Archive folder, or back onto the feed (or All feeds)
let dragRss: string[] = [];

el('#rss-list').addEventListener('dragstart', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-rss]');
  if (!row || !e.dataTransfer) return;
  const key = row.dataset.rss!;
  dragRss = pickedRss.has(key) ? [...pickedRss] : [key];
  rssDragging = true;
  paintRssStarred(); // not renderRss: redrawing the list would cancel the drag
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-agenoras-rss', '1');
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.textContent = dragRss.length === 1 ? rssItems.find((i) => i.key === key)?.title || t('rss.untitled') : t('rss.picked', { n: dragRss.length });
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 12, 12);
  setTimeout(() => ghost.remove());
});
el('#rss-list').addEventListener('dragend', () => {
  dragRss = [];
  rssDragging = false;
  paintRssStarred();
});

// Archive folder: only articles of that feed; feed / All feeds: only archived ones
function rssDropTarget(e: DragEvent): { el: HTMLElement; keys: string[]; archive: boolean; star?: boolean } | null {
  const tgt = (e.target as HTMLElement).closest<HTMLElement>('#side-rss [data-feed]');
  if (!tgt || !dragRss.length) return null;
  if (tgt.dataset.starred) {
    const keys = rssItems.filter((i) => dragRss.includes(i.key) && !i.flagged).map((i) => i.key);
    return keys.length ? { el: tgt, keys, archive: false, star: true } : null;
  }
  const archive = !!tgt.dataset.archive;
  const feedId = tgt.dataset.feed;
  const items = rssItems.filter((i) => dragRss.includes(i.key));
  if (archive && items.some((i) => i.feedId !== feedId)) return null;
  const keys = items.filter((i) => !!i.archived !== archive && (archive || !feedId || i.feedId === feedId)).map((i) => i.key);
  return keys.length ? { el: tgt, keys, archive } : null;
}

el('#side-rss').addEventListener('dragover', (e) => {
  const target = rssDropTarget(e);
  document.querySelectorAll('#side-rss .drop-target').forEach((r) => r !== target?.el && r.classList.remove('drop-target'));
  if (!target) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'move';
  target.el.classList.add('drop-target');
});
el('#side-rss').addEventListener('dragleave', (e) => {
  if (!el('#side-rss').contains(e.relatedTarget as Node)) document.querySelectorAll('#side-rss .drop-target').forEach((r) => r.classList.remove('drop-target'));
});
el('#side-rss').addEventListener('drop', (e) => {
  const target = rssDropTarget(e);
  if (!target) return;
  e.preventDefault();
  dragRss = [];
  rssDragging = false; // the list is redrawn, dragend may not reach it
  if (target.star) void flagRss(target.keys, true);
  else void archiveRss(target.keys, target.archive);
  // the sidebar is redrawn, flash the new row
  const sel = target.star ? '#side-rss [data-starred]' : `#side-rss [data-feed="${CSS.escape(target.el.dataset.feed ?? '')}"]${target.archive ? '[data-archive]' : ':not([data-archive]):not([data-starred])'}`;
  const row = document.querySelector<HTMLElement>(sel);
  row?.classList.add('drop-hit');
  setTimeout(() => row?.classList.remove('drop-hit'), 600);
});

// Pin an article to the pin sidebar: the article as plain text (the sidebar shows no HTML)
async function pinFeedItem(item: RssItem): Promise<void> {
  let text = item.snippet;
  try {
    const html = sanitizeHtml(await window.api.rss.article(item.key));
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('p, div, br, li, h1, h2, h3, h4, tr').forEach((n) => n.append('\n'));
    text = (doc.body.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() || text;
  } catch {
    /* summary is enough */
  }
  const f = feedOf(item.feedId);
  const meta = [f ? { text: f.name } : null, item.date ? { text: fmtLong(item.date) } : null, item.author ? { text: item.author } : null];
  await window.api.pins.add({ key: `feed:${item.key}`, kind: 'feed', title: item.title || t('rss.untitled'), text, meta: meta.filter((m) => !!m), color: feedColor(item.feedId), link: item.link || undefined });
}

// Ctrl+A selects every article shown, Esc clears the selection
document.addEventListener('keydown', (e) => {
  if (el('.app').dataset.view !== 'rss' || document.querySelector('dialog[open]')) return;
  if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && shownRssKeys.length) {
    e.preventDefault();
    pickedRss = new Set(shownRssKeys);
    anchorRss = shownRssKeys[0];
    if (pickedRss.size === 1) return void showRssItem(shownRssKeys[0]);
    selectedRss = '';
    renderRssMulti();
    renderRssList();
  } else if (e.key === 'Escape' && pickedRss.size > 1) {
    pickedRss = new Set();
    clearRssDetail();
    renderRssList();
  }
});

// Article
async function markRss(item: RssItem, read: boolean): Promise<void> {
  item.read = read;
  renderRss();
  await window.api.rss.setRead([item.key], read).catch((err) => setRssStatus(errMsg(err)));
}

async function showRssItem(key: string): Promise<void> {
  const item = rssItems.find((i) => i.key === key);
  if (!item) return;
  selectedRss = key;
  pickedRss = new Set([key]);
  // opened from the search: switch between inbox and archive if needed
  if (!rssStarred && !!item.archived !== rssArchive) {
    rssArchive = !!item.archived;
    if (rssArchive) currentFeed = item.feedId;
    renderRss();
  }
  if (!item.read) void markRss(item, true);
  else renderRssList();
  const f = feedOf(item.feedId);
  const box = el('#rss-detail');
  box.innerHTML = `<div class="rd-head">
      <h2>${esc(item.title || t('rss.untitled'))}</h2>
      <div class="rd-meta">
        ${f ? `<span class="acc" style="color:${feedColor(f.id)}">${esc(f.name.toUpperCase())}</span>` : ''}
        ${item.author ? `<span>${esc(item.author)}</span>` : ''}
        ${item.date ? `<span>${esc(fmtLong(item.date))}</span>` : ''}
      </div>
      <div class="rd-actions">
        <button type="button" class="icon-btn sm star-btn${item.flagged ? ' on' : ''}" data-rss-flag aria-pressed="${!!item.flagged}" aria-label="${esc(t(item.flagged ? 'mail.unflag' : 'mail.flag'))}" title="${esc(t(item.flagged ? 'mail.unflag' : 'mail.flag'))}">${item.flagged ? '★' : '☆'}</button>
        ${item.link ? `<button type="button" class="btn primary" data-rss-open>${esc(t('rss.openBrowser'))}</button>` : ''}
        <button type="button" class="btn ghost" data-rss-unread>${esc(t('rss.markUnread'))}</button>
        <button type="button" class="icon-btn sm" data-rss-pin aria-label="${esc(t('pins.pin'))}" title="${esc(t('pins.pinTip'))}">${PIN_ICON}</button>
        <button type="button" class="btn ghost with-ico" data-rss-archive>${ACT_ICONS.archive}${esc(t(item.archived ? 'rss.unarchive' : 'mail.archive'))}</button>
      </div>
    </div>
    <div class="status">${esc(t('status.loading'))}</div>`;
  let html = '';
  try {
    html = await window.api.rss.article(key);
  } catch (err) {
    if (selectedRss === key) box.querySelector('.status')!.textContent = errMsg(err);
    return;
  }
  if (selectedRss !== key) return; // user clicked another one
  box.querySelector('.status')?.remove();
  const clean = sanitizeHtml(html).trim();
  if (!clean) {
    box.insertAdjacentHTML('beforeend', `<p class="hint">${esc(t('rss.noContent'))}</p>`);
    return;
  }
  // same sandbox as HTML mails
  const frame = document.createElement('iframe');
  frame.className = 'mail-frame';
  frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  frame.srcdoc = wrapHtml(clean);
  frame.onload = () => {
    if (frame.contentDocument) {
      mailtoLinks(frame.contentDocument);
      hookLinkPeek(frame.contentDocument);
    }
    const fit = () => (frame.style.height = (frame.contentDocument?.documentElement.scrollHeight ?? 600) + 'px');
    fit();
    frame.contentDocument?.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit));
  };
  box.appendChild(frame);
}

el('#rss-detail').addEventListener('click', (e) => {
  const tgt = e.target as HTMLElement;
  const multi = tgt.closest<HTMLElement>('[data-rss-multi]')?.dataset.rssMulti;
  if (multi) {
    const keys = [...pickedRss];
    if (multi === 'archive' || multi === 'unarchive') void archiveRss(keys, multi === 'archive');
    else if (multi === 'read' || multi === 'unread') void markRssKeys(keys, multi === 'read');
    else if (multi === 'flag' || multi === 'unflag') {
      void flagRss(keys, multi === 'flag');
      renderRssMulti();
    }
    else {
      pickedRss = new Set();
      clearRssDetail();
      renderRssList();
    }
    return;
  }
  const item = rssItems.find((i) => i.key === selectedRss);
  if (!item) return;
  if (tgt.closest('[data-rss-open]') && item.link) window.open(item.link, '_blank');
  else if (tgt.closest('[data-rss-unread]')) void markRss(item, false);
  else if (tgt.closest('[data-rss-archive]')) void archiveRss([item.key], !item.archived);
  else if (tgt.closest('[data-rss-flag]')) void flagRss([item.key], !item.flagged);
  else if (tgt.closest('[data-rss-pin]')) void pinFeedItem(item);
});

// Plain e-mail and web addresses in an article → links (a new mail in Agenoras, the page in the browser)
function mailtoLinks(doc: Document): void {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  const any = new RegExp(`${URL_IN_TEXT.source}|${MAIL_IN_TEXT.source}`, 'gi');
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest('a, script, style') && new RegExp(any.source, 'i').test(n.nodeValue ?? '')) hits.push(n as Text);
  }
  for (const node of hits) {
    const frag = doc.createDocumentFragment();
    let last = 0;
    const text = node.nodeValue ?? '';
    for (const m of text.matchAll(any)) {
      frag.append(text.slice(last, m.index));
      const a = doc.createElement('a');
      const web = /^(https?:\/\/|www\.)/i.test(m[0]);
      a.href = web ? (/^www\./i.test(m[0]) ? `https://${m[0]}` : m[0]) : `mailto:${m[0]}`;
      a.textContent = m[0];
      frag.append(a);
      last = m.index! + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

function clearRssDetail(): void {
  selectedRss = '';
  pickedRss = new Set();
  el('#rss-detail').innerHTML = `<div class="empty">${esc(t('rss.noneSelected'))}</div>`;
}

// Add / edit feed
const rssDlg = el<HTMLDialogElement>('#dlg-rss-add');
const rssForm = el<HTMLFormElement>('#form-rss-add');
const rssField = (n: string) => rssForm.elements.namedItem(n) as HTMLInputElement;
let editingFeed: string | null = null;

function syncRssAuth(): void {
  el('#rss-auth').hidden = !rssField('auth').checked;
}
rssField('auth').addEventListener('change', syncRssAuth);

function openFeedDialog(feed: RssFeed | null): void {
  editingFeed = feed?.id ?? null;
  rssForm.reset();
  el('#rss-add-title').innerHTML = t(feed ? 'rss.editTitle' : 'rss.addTitle');
  el('#btn-rss-add-save').textContent = t(feed ? 'btn.saveConnect' : 'btn.connect');
  rssField('url').value = feed?.url ?? '';
  rssField('name').value = feed?.name ?? '';
  rssField('auth').checked = !!feed?.username;
  rssField('username').value = feed?.username ?? '';
  rssField('password').placeholder = feed?.username ? t('account.passKeep') : '';
  syncRssAuth();
  el('#rss-add-error').textContent = '';
  rssDlg.showModal();
  rssField('url').focus();
}

const openAddFeed = () => openFeedDialog(null);
const openEditFeed = (feed: RssFeed) => openFeedDialog(feed);

el('#btn-rss-add-cancel').addEventListener('click', () => rssDlg.close());

rssForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = el<HTMLButtonElement>('#btn-rss-add-save');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('btn.connecting');
  el('#rss-add-error').textContent = '';
  const auth = rssField('auth').checked;
  const input: RssFeedInput = {
    name: rssField('name').value.trim(),
    url: rssField('url').value.trim(),
    username: auth ? rssField('username').value.trim() : '',
    password: auth ? rssField('password').value : '',
  };
  try {
    const feed = editingFeed ? await window.api.rss.update(editingFeed, input) : await window.api.rss.add(input);
    rssDlg.close();
    const c = await window.api.rss.cached();
    rssFeeds = c.feeds;
    rssItems = c.items;
    if (!editingFeed) currentFeed = feed.id;
    syncRssNav();
    renderRss();
  } catch (err) {
    el('#rss-add-error').textContent = errMsg(err);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

async function removeFeedById(id: string): Promise<void> {
  await window.api.rss.remove(id);
  if (currentFeed === id) {
    currentFeed = null;
    rssArchive = false;
  }
  if (rssItems.find((i) => i.key === selectedRss)?.feedId === id) clearRssDetail();
  const c = await window.api.rss.cached();
  rssFeeds = c.feeds;
  rssItems = c.items;
  syncRssNav();
  renderRss();
}

// Startup, then refresh every 30 min
window.api.rss
  .cached()
  .then((c) => {
    rssFeeds = c.feeds;
    rssItems = c.items;
    syncRssNav();
    renderRss();
    if (rssFeeds.length) setTimeout(() => void ensureRss(), 3000);
  })
  .catch(() => {});
setInterval(() => {
  if (rssFeeds.length) rssLoading = loadRss();
}, 30 * 60_000);
