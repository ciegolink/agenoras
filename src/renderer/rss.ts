// Feed view. Uses helpers from common.ts, reader.ts and renderer.ts.
// The Feed button is only shown when there is at least one feed.

let rssFeeds: RssFeed[] = [];
let rssItems: RssItem[] = [];
let currentFeed: string | null = null;
let selectedRss = '';
let rssFilter: 'all' | 'unread' = 'all';
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

// Sidebar
function renderRss(): void {
  const unread = (feedId?: string) => rssItems.filter((i) => !i.read && (!feedId || i.feedId === feedId)).length;
  const all = unread();
  el('#rss-count').textContent = all ? String(all) : '';
  el('#feed-list').innerHTML = rssFeeds
    .map((f) => {
      const n = unread(f.id);
      return `<button class="box${currentFeed === f.id ? ' active' : ''}" data-feed="${esc(f.id)}"><span class="dot" style="background:${feedColor(f.id)}"></span><span class="name">${esc(f.name)}</span><span class="count">${n || ''}</span></button>`;
    })
    .join('');
  document.querySelector<HTMLElement>('#side-rss .box[data-feed=""]')?.classList.toggle('active', !currentFeed);
  document.querySelectorAll<HTMLElement>('#rss-filter [data-rfilter]').forEach((b) => b.classList.toggle('on', b.dataset.rfilter === rssFilter));
  const feed = currentFeed ? feedOf(currentFeed) : null;
  el('#rss-heading').textContent = feed ? feed.name : t('rss.heading');
  el('#rss-title').textContent = t(rssFilter === 'unread' ? 'rss.titleUnread' : 'rss.titleAll');
  renderRssList();
}

el('#side-rss').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-feed]');
  if (!b) return;
  currentFeed = b.dataset.feed || null;
  renderRss();
});
el('#btn-new-feed').addEventListener('click', () => openAddFeed());

// List
// keys matching the filter, null = no filter
let rssHitKeys: Set<string> | null = null;
let rssSearchTimer = 0;

function rssShown(): RssItem[] {
  return rssItems.filter((i) => (!currentFeed || i.feedId === currentFeed) && (rssFilter === 'all' || !i.read || i.key === selectedRss) && (!rssHitKeys || rssHitKeys.has(i.key)));
}

function renderRssList(): void {
  const shown = rssShown();
  const raw = el<HTMLInputElement>('#rss-search').value;
  el('#rss-list').innerHTML = shown.length
    ? shown
        .slice(0, 500)
        .map((i) => {
          const f = feedOf(i.feedId);
          return `<button class="mail rss-item${i.read ? '' : ' unread'}${i.key === selectedRss ? ' selected' : ''}" data-rss="${esc(i.key)}">
          <span class="m-body">
            <span class="row"><span class="from">${esc(i.title || t('rss.untitled'))}</span><span class="time">${i.date ? esc(fmtShort(i.date)) : ''}</span></span>
            ${!currentFeed && f ? `<span class="acc" style="color:${feedColor(f.id)}">${esc(f.name.toUpperCase())}</span>` : ''}
            ${i.snippet ? `<span class="snip">${esc(i.snippet)}</span>` : ''}
          </span>
        </button>`;
        })
        .join('') + (rssHitKeys ? searchElsewhereHtml(raw, true) : '')
    : rssHitKeys ? searchElsewhereHtml(raw, false) : `<div class="list-empty">${esc(t(rssFeeds.length ? (rssFilter === 'unread' ? 'rss.noUnread' : 'rss.noItems') : 'rss.noFeeds'))}</div>`;
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
  if (key) void showRssItem(key);
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
        ${item.link ? `<button type="button" class="btn primary" data-rss-open>${esc(t('rss.openBrowser'))}</button>` : ''}
        <button type="button" class="btn ghost" data-rss-unread>${esc(t('rss.markUnread'))}</button>
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
    const fit = () => (frame.style.height = (frame.contentDocument?.documentElement.scrollHeight ?? 600) + 'px');
    fit();
    frame.contentDocument?.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit));
  };
  box.appendChild(frame);
}

el('#rss-detail').addEventListener('click', (e) => {
  const tgt = e.target as HTMLElement;
  const item = rssItems.find((i) => i.key === selectedRss);
  if (!item) return;
  if (tgt.closest('[data-rss-open]') && item.link) window.open(item.link, '_blank');
  else if (tgt.closest('[data-rss-unread]')) void markRss(item, false);
});

function clearRssDetail(): void {
  selectedRss = '';
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
  if (currentFeed === id) currentFeed = null;
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
  })
  .catch(() => {});
setInterval(() => {
  if (rssFeeds.length) rssLoading = loadRss();
}, 30 * 60_000);
