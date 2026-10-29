// Main window: runs without Node, talks to the main process only via window.api (preload).
// Shared helpers (el, esc, fmt…, fileIcon) live in common.ts.

let accounts: Account[] = [];
let mails: MailSummary[] = [];
let currentAccount: string | null = null;
let selectedKey = ''; // mail in the reading pane
let selected = new Set<string>(); // selection in the list (Ctrl/Shift+click)
let anchorKey = ''; // anchor for Shift+click
let shownKeys: string[] = []; // currently visible mails (after search)
let currentMsg: MailDetail | null = null;
let listFilter: 'all' | 'unread' | 'attach' | 'flagged' = 'all'; // filter above the list (also applies to search hits)
let searchScope: 'folder' | 'all' = 'folder'; // search: current folder or everywhere
let searchResults: MailSummary[] | null = null; // hits of the server search (full text)
let searchSeq = 0;
let searchKind: 'all' | 'mail' | 'event' | 'contact' | 'task' = 'all'; // search: which kind of hits is shown
let eventHits: CalEvent[] = []; // search hits from the calendars
let contactHits: Contact[] = []; // search hits from the address books
let taskHits: Task[] = []; // search hits from the task lists
let readDelay = 3; // seconds until an opened mail counts as read (0 = at once, -1 = only by hand); Settings → Accounts
let readTimer: number | undefined;
// typing = waiting for the first (local) hits · server = mails are still being searched on the server
let searchPhase: 'idle' | 'typing' | 'server' = 'idle';
let privacy: PrivacyState = { locked: 0, unlocked: 0 }; // private accounts (PIN), see below
const LOCK_ICO = '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>';
const UNLOCK_ICO = '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>';
// categories (local, per mail via Message-ID) – managed in labels.ts
let labels: MailLabel[] = [];
let mailLabels: Record<string, string[]> = {};
let labelFilter: string | null = null;
// Collection views under "All inboxes": starred mails or a category (across all accounts/folders)
let flaggedView = false;
let labelView: string | null = null;
let flaggedMails: MailSummary[] = [];
const inVirtual = () => flaggedView || !!labelView;
const labelKey = (m: { messageId?: string; accountId: string; folder?: string; uid: number }) => m.messageId || mailKey(m);
const labelsOf = (m: { messageId?: string; accountId: string; folder?: string; uid: number }) =>
  (mailLabels[labelKey(m)] ?? []).map((id) => labels.find((l) => l.id === id)).filter(Boolean) as MailLabel[];
const labelPills = (list: MailLabel[]) => list.map((l) => `<span class="lbl" style="--lc:${readable(l.color)}">${esc(l.name)}</span>`).join('');
// Animation: fade in new mails in the same view
let listContext = '';
let listKeysBefore = new Set<string>();
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const accountOf = (id: string) => accounts.find((a) => a.id === id);
const colorOf = (id: string) => readable(accountOf(id)?.color ?? '#969993');
// mails that can currently be in the list (folder or search hits)
const listSource = () => searchResults ?? mails;
const summaryOf = (key: string) => listSource().find((m) => mailKey(m) === key) ?? mails.find((m) => mailKey(m) === key);

function setStatus(text: string): void {
  el('#status').textContent = text;
}

// ---------- Accounts and folders ----------

let currentFolder = 'INBOX';
const folderCache = new Map<string, FolderInfo[]>();

const SPECIAL_KEYS: Record<string, string> = {
  '\\Inbox': 'folder.inbox',
  '\\Drafts': 'folder.drafts',
  '\\Sent': 'folder.sent',
  '\\Archive': 'folder.archive',
  '\\Junk': 'folder.junk',
  '\\Trash': 'folder.trash',
  '\\All': 'folder.all',
  '\\Flagged': 'folder.flagged',
};
const specialName = (use: string) => (SPECIAL_KEYS[use] ? t(SPECIAL_KEYS[use]) : '');

const ICON_PATHS: Record<string, string> = {
  '\\Inbox': '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6Z"/>',
  '\\Drafts': '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  '\\Sent': '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  '\\Archive': '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/>',
  '\\Junk': '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
  '\\Trash': '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>',
  '': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
};
const icon = (use: string) =>
  `<svg class="ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[use] ?? ICON_PATHS['']}</svg>`;

const folderInfo = (accountId: string, path: string) => folderCache.get(accountId)?.find((f) => f.path === path);
const folderLabel = (accountId: string | null, path: string) => {
  if (path === 'INBOX') return t('folder.inbox');
  const f = accountId ? folderInfo(accountId, path) : undefined;
  return (f && specialName(f.specialUse)) || f?.name || path.split(/[/.]/).pop() || path;
};

// Unique key of a mail: account | folder | UID
const mailKey = (m: { accountId: string; folder?: string; uid: number }) => `${m.accountId}|${m.folder ?? 'INBOX'}|${m.uid}`;
function parseKey(key: string): { accountId: string; folder: string; uid: number } {
  const parts = key.split('|');
  return { accountId: parts[0], folder: parts.slice(1, -1).join('|') || 'INBOX', uid: Number(parts[parts.length - 1]) };
}

async function loadAccounts(): Promise<void> {
  accounts = await window.api.listAccounts();
  privacy = await window.api.privacy.state().catch(() => privacy);
  renderPrivacy();
  renderAccounts();
  for (const a of accounts) if (expandedAccs.has(a.id)) loadFolders(a.id);
}

// Expanded/collapsed accounts and folders are remembered
const readSet = (key: string) => {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(key) || '[]'));
  } catch {
    return new Set<string>();
  }
};
const saveSet = (key: string, set: Set<string>) => {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
};
const expandedAccs = readSet('mail.expandedAccounts');
const collapsedFolders = readSet('mail.collapsedFolders'); // "accountId|path"

function toggleAccountOpen(id: string, open = !expandedAccs.has(id)): void {
  if (open) expandedAccs.add(id);
  else expandedAccs.delete(id);
  saveSet('mail.expandedAccounts', expandedAccs);
  if (open && !folderCache.has(id)) loadFolders(id);
  renderAccounts();
}

async function loadFolders(accountId: string): Promise<void> {
  try {
    if (!folderCache.has(accountId)) {
      const cached = await window.api.cachedFolders(accountId);
      if (cached.length) {
        folderCache.set(accountId, cached);
        renderAccounts();
      }
    }
    folderCache.set(accountId, await window.api.listFolders(accountId));
    renderAccounts();
  } catch {
    /* folders stay from the cache */
  }
}

function renderAccounts(): void {
  el('#account-list').innerHTML = accounts
    .map((a) => {
      const open = expandedAccs.has(a.id);
      const folders = open ? folderCache.get(a.id) ?? [] : [];
      const inboxUnseen = folderCache.get(a.id)?.find((f) => f.path === 'INBOX')?.unseen;
      let hideBelow = -1; // hide subfolders of a collapsed folder
      const tree = folders
        .map((f, i) => {
          if (hideBelow >= 0 && f.depth > hideBelow) return '';
          hideBelow = -1;
          const hasKids = (folders[i + 1]?.depth ?? -1) > f.depth;
          const closed = hasKids && collapsedFolders.has(`${a.id}|${f.path}`);
          if (closed) hideBelow = f.depth;
          if (!f.selectable) return '';
          const tw = hasKids ? `<span class="tw${closed ? '' : ' open'}" data-tw-folder="${esc(f.path)}" style="left:${12 + f.depth * 14}px" role="button" aria-expanded="${!closed}">›</span>` : '';
          return `<button class="folder${currentFolder === f.path && currentAccount === a.id ? ' active' : ''}" data-account="${a.id}" data-folder="${esc(f.path)}" style="padding-left:${30 + f.depth * 14}px">
            ${tw}${icon(f.specialUse)}<span class="name">${esc(specialName(f.specialUse) || f.name)}</span><span class="count">${f.unseen || ''}</span>
          </button>`;
        })
        .join('');
      return `<button class="box acc-row${open ? ' open' : ''}${currentAccount === a.id ? ' current' : ''}" data-account="${a.id}">
          <span class="tw${open ? ' open' : ''}" data-tw-acc="${a.id}" role="button" aria-expanded="${open}">›</span>
          <span class="dot" style="background:${a.color}"></span>
          <span class="name" title="${esc(a.email)}">${esc(accLabel(a))}</span>
          ${a.private ? `<span class="priv-ico" title="${esc(t('account.privateTag'))}">${svgIco(UNLOCK_ICO, 11)}</span>` : ''}
          <span class="count" data-count="${a.id}">${inboxUnseen || ''}</span>
        </button>${tree}`;
    })
    .join('');
  markActive();
}

function markActive(): void {
  document.querySelectorAll<HTMLElement>('.side .acc-row, .side [data-account=""]').forEach((b) => {
    const isAll = b.dataset.account === '';
    b.classList.toggle('active', !inVirtual() && (isAll ? currentAccount === null : b.dataset.account === currentAccount && currentFolder === 'INBOX' && (!expandedAccs.has(currentAccount!) || !folderCache.get(currentAccount!)?.length)));
  });
  if (inVirtual()) document.querySelectorAll<HTMLElement>('.side .folder.active').forEach((f) => f.classList.remove('active'));
  const acc = currentAccount ? accountOf(currentAccount) : null;
  const lbl = labelView ? labels.find((l) => l.id === labelView) : null;
  el('#list-heading').textContent = flaggedView ? t('mail.flaggedView') : lbl ? lbl.name : acc ? folderLabel(currentAccount, currentFolder) : t('folder.inbox');
  el('#list-title').textContent = acc && !inVirtual() ? `${acc.name}.` : t('mail.allAccounts');
  renderVirtualList();
}

// "Important" (star) and categories with mails – right below "All inboxes"
function renderVirtualList(showAll = false): void {
  const box = document.querySelector<HTMLElement>('#virtual-list');
  if (!box) return;
  const star = flaggedMails.length || showAll
    ? `<button class="box vbox${flaggedView ? ' active' : ''}" data-virtual="flagged"><span class="vico star-ico">★</span><span class="name">${esc(t('mail.flaggedView'))}</span><span class="count">${flaggedMails.length || ''}</span></button>`
    : '';
  const cats = labels
    .map((l) => ({ l, n: Object.values(mailLabels).filter((ids) => ids.includes(l.id)).length }))
    .filter((x) => x.n > 0 || showAll)
    .map(
      ({ l, n }) =>
        `<button class="box vbox lbl-box${labelView === l.id ? ' active' : ''}" data-virtual="label:${esc(l.id)}" title="${esc(t('labels.dropTip'))}"><span class="vico"><span class="dot" style="background:${l.color}"></span></span><span class="name">${esc(l.name)}</span><span class="count">${n || ''}</span></button>`,
    )
    .join('');
  box.innerHTML = star + cats;
}

async function loadFlagged(): Promise<void> {
  try {
    flaggedMails = await window.api.cachedFlagged();
    renderVirtualList();
    flaggedMails = (await window.api.flaggedMails()).mails;
  } catch {
    /* offline */
  }
  renderVirtualList();
  if (flaggedView) {
    mails = [...flaggedMails];
    renderList();
  }
}

function openVirtual(kind: string): void {
  flaggedView = kind === 'flagged';
  labelView = kind.startsWith('label:') ? kind.slice(6) : null;
  currentAccount = null;
  currentFolder = 'INBOX';
  resetSearch();
  clearReader();
  renderAccounts();
  loadMails();
}

function updateCounts(): void {
  const unseen = mails.filter((m) => !m.seen && m.folder === 'INBOX').length;
  if (!currentAccount) el('#count-all').textContent = unseen ? String(unseen) : '';
}

// ---------- Mail list ----------

async function loadVirtual(): Promise<void> {
  const want = flaggedView ? 'flagged' : `label:${labelView}`;
  const still = () => (flaggedView ? 'flagged' : `label:${labelView}`) === want;
  if (flaggedView) {
    mails = [...flaggedMails];
    renderList();
    setStatus(t('status.updating'));
    await loadFlagged();
    if (still()) setStatus('');
    return;
  }
  const ids = Object.entries(mailLabels)
    .filter(([, l]) => l.includes(labelView!))
    .map(([k]) => k);
  try {
    const found = await window.api.mailsByMessageIds(ids);
    if (!still()) return;
    mails = found;
    setStatus(found.length < ids.length ? t('labels.someNotCached', { n: ids.length - found.length }) : '');
  } catch (err) {
    setStatus(errMsg(err));
  }
  renderList();
}

async function loadMails(): Promise<void> {
  if (!accounts.length) {
    mails = [];
    renderList();
    setStatus('');
    return;
  }
  if (inVirtual()) return loadVirtual();
  const forAccount = currentAccount;
  const forFolder = currentAccount ? currentFolder : 'INBOX';
  const stale = () => inVirtual() || forAccount !== currentAccount || forFolder !== (currentAccount ? currentFolder : 'INBOX');
  // 1. straight from the local cache
  try {
    const cached = await window.api.cachedMail(forAccount, forFolder);
    if (!stale()) {
      mails = cached;
      renderList();
      updateCounts();
    }
  } catch {
    /* cache empty or unavailable */
  }
  // 2. fresh from the server
  setStatus(t('status.updating'));
  try {
    const res = await window.api.listMail(forAccount, forFolder);
    if (stale()) return; // another folder selected in the meantime
    mails = res.mails;
    setStatus(res.errors.map((e) => `${accountOf(e.accountId)?.email ?? t('account.generic')}: ${e.message}`).join(' · '));
  } catch (e) {
    setStatus(errMsg(e));
  }
  renderList();
  updateCounts();
}

document.addEventListener('externalprefs', () => {
  renderAccounts();
  renderList();
});

// ---------- Conversations (threads), switchable per account ----------
// Mails belong together when one answers the other (In-Reply-To). Older cached mails do not know that
// yet, so a "Re:/AW:/Fwd:/WG:" subject also joins the mails with the same subject.

const THREADS_KEY = 'agenoras.threadAccounts';
const threadAccounts = new Set<string>(JSON.parse(localStorage.getItem(THREADS_KEY) || '[]') as string[]);
const expandedThreads = new Set<string>();
// key of a closed conversation's head → keys of all its mails (dragging the head moves the whole conversation)
const closedThreads = new Map<string, string[]>();
interface MailThread {
  id: string; // key of the oldest mail – stays the same when new replies arrive
  mails: MailSummary[]; // newest first
}
const isThread = (row: MailSummary | MailThread): row is MailThread => 'mails' in row;
const REPLY_PREFIX = /^\s*((re|aw|antw|wg|fwd?|tr|sv|rif)(\[\d+\])?\s*:\s*)+/i;
const baseSubject = (s: string) => s.replace(REPLY_PREFIX, '').trim().toLowerCase();

function buildThreads(list: MailSummary[]): (MailSummary | MailThread)[] {
  const parent = list.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: number, b: number) => (parent[find(a)] = find(b));
  const byId = new Map<string, number>();
  const bySubject = new Map<string, number[]>();
  list.forEach((m, i) => {
    if (!threadAccounts.has(m.accountId)) return;
    if (m.messageId) byId.set(`${m.accountId}|${m.messageId}`, i);
    const base = baseSubject(m.subject);
    if (base) bySubject.set(`${m.accountId}|${base}`, [...(bySubject.get(`${m.accountId}|${base}`) ?? []), i]);
  });
  list.forEach((m, i) => {
    const p = m.inReplyTo ? byId.get(`${m.accountId}|${m.inReplyTo}`) : undefined;
    if (p !== undefined) join(i, p);
  });
  for (const ids of bySubject.values()) if (ids.length > 1 && ids.some((i) => REPLY_PREFIX.test(list[i].subject))) ids.forEach((i) => join(i, ids[0]));
  // list is newest first → the first mail met of a group is its newest
  const groups = new Map<number, MailSummary[]>();
  list.forEach((m, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), m]));
  const out: (MailSummary | MailThread)[] = [];
  const done = new Set<number>();
  list.forEach((m, i) => {
    const root = find(i);
    if (done.has(root)) return;
    done.add(root);
    const mails = groups.get(root)!;
    out.push(mails.length > 1 ? { id: mailKey(mails[mails.length - 1]), mails } : m);
  });
  return out;
}

function threadRowsHtml(th: MailThread, o: { showTo: boolean; listFolder: string; animateNew: boolean }): string {
  const open = expandedThreads.has(th.id);
  if (!open) closedThreads.set(mailKey(th.mails[0]), th.mails.map(mailKey));
  // the head is bold only for its own mail; unread older mails light up the counter instead
  const head = mailRowHtml(th.mails[0], { ...o, thread: { id: th.id, n: th.mails.length, open, unread: th.mails.slice(1).some((m) => !m.seen) } });
  return head + (open ? th.mails.slice(1).map((m) => mailRowHtml(m, { ...o, child: true })).join('') : '');
}

// The switch in the list header: for the open account (in "all accounts" each account's own setting applies)
function paintThreadToggle(): void {
  const btn = el<HTMLButtonElement>('#btn-threads');
  btn.hidden = !currentAccount || inVirtual();
  const on = !!currentAccount && threadAccounts.has(currentAccount);
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.title = t(on ? 'threads.on' : 'threads.tip');
}

function setThreads(accountId: string, on: boolean): void {
  if (on) threadAccounts.add(accountId);
  else threadAccounts.delete(accountId);
  localStorage.setItem(THREADS_KEY, JSON.stringify([...threadAccounts]));
  renderList();
}

el('#btn-threads').addEventListener('click', () => {
  if (!currentAccount) return;
  const on = !threadAccounts.has(currentAccount);
  setThreads(currentAccount, on);
  setStatus(t(on ? 'threads.enabled' : 'threads.disabled'));
});

// Open/close a conversation (capture: before the row's own click selects the mail)
el('#mail-list').addEventListener(
  'click',
  (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-thread-toggle]')?.dataset.threadToggle;
    if (!id) return;
    e.stopPropagation();
    if (expandedThreads.has(id)) expandedThreads.delete(id);
    else expandedThreads.add(id);
    renderList();
  },
  true,
);

// One row of the mail list. thread: head of a conversation (count, open/closed); child: an older mail in it
function mailRowHtml(m: MailSummary, o: { showTo: boolean; listFolder: string; animateNew: boolean; thread?: { id: string; n: number; open: boolean; unread: boolean }; child?: boolean }): string {
  const { showTo, listFolder, animateNew } = o;
  const key = mailKey(m);
  const color = colorOf(m.accountId);
  const accName = accLabel(accountOf(m.accountId)).toUpperCase();
  const otherFolder = m.folder !== listFolder || !currentAccount ? ` · ${folderLabel(m.accountId, m.folder).toUpperCase()}` : '';
  const who = showTo ? t('mail.toName', { name: m.toName || '–' }) : m.from || m.fromAddress || t('mail.unknown');
  const prio = m.priority === 'high' ? `<span class="prio high" title="${esc(t('prio.high'))}">!</span>` : m.priority === 'low' ? `<span class="prio low" title="${esc(t('prio.low'))}">↓</span>` : '';
  const isNew = animateNew && !listKeysBefore.has(key);
  const lbls = labelsOf(m);
  const unread = !m.seen;
  const threadBtn = o.thread
    ? `<span class="thread-n${o.thread.open ? ' open' : ''}${o.thread.unread ? ' has-unread' : ''}" data-thread-toggle="${esc(o.thread.id)}" role="button" aria-expanded="${o.thread.open}" title="${esc(t(o.thread.open ? 'threads.collapse' : 'threads.expand'))}">${svgIco('<path d="m9 6 6 6-6 6"/>', 11)}${o.thread.n}</span>`
    : '';
  return `<button class="mail${unread ? ' unread' : ''}${o.child ? ' thread-child' : ''}${o.thread?.open ? ' thread-open' : ''}${selected.has(key) ? ' selected' : ''}${isNew ? ' entering' : ''}" data-key="${esc(key)}" draggable="true">
    ${showTo ? avatarHtml('', m.toName || '?', 'avatar m-av') : avatarHtml(m.fromAddress, m.from, 'avatar m-av')}
    <span class="m-body">
      <span class="row">
        <span class="from">${esc(who)}</span>${threadBtn}
        ${!showTo && isExternal(m.fromAddress) ? `<span class="ext-tag sm" title="${esc(t('ext.banner'))}">${esc(t('ext.tag'))}</span>` : ''}${prio}${m.hasAttachments ? `<span class="clip" title="${esc(t('mail.attachmentTag'))}">${svgIco('<path d="m21 12-8.5 8.5a5 5 0 0 1-7-7L14 5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15.5 8"/>', 12)}</span>` : ''}
        <span class="time">${fmtShort(m.date)}</span>
        <span class="star${m.flagged ? ' on' : ''}" data-star role="button" title="${esc(t(m.flagged ? 'mail.unflag' : 'mail.flag'))}">${m.flagged ? '★' : '☆'}</span>
      </span>
      <span class="subject">${unread ? '<span class="new-dot"></span>' : ''}${esc(m.subject || t('mail.noSubject'))}</span>
      <span class="acc-row-line"><span class="acc" style="color:${color}">${esc(accName)}${esc(otherFolder)}</span>${lbls.length ? `<span class="lbls">${labelPills(lbls)}</span>` : ''}</span>
    </span>
  </button>`;
}

function renderList(): void {
  const q = el<HTMLInputElement>('#search').value.trim().toLowerCase();
  // While the server search runs: filter locally by sender/subject
  let shown = searchResults ?? (q ? mails.filter((m) => `${m.subject} ${m.from} ${m.fromAddress} ${m.toName ?? ''}`.toLowerCase().includes(q)) : mails);
  if (listFilter === 'unread') shown = shown.filter((m) => !m.seen);
  else if (listFilter === 'attach') shown = shown.filter((m) => m.hasAttachments);
  else if (listFilter === 'flagged') shown = shown.filter((m) => m.flagged);
  if (labelFilter) shown = shown.filter((m) => (mailLabels[labelKey(m)] ?? []).includes(labelFilter!));
  const ctxNow = `${currentAccount}|${currentFolder}|${q}|${listFilter}|${labelFilter}`;
  const animateNew = ctxNow === listContext && listKeysBefore.size > 0 && !reduceMotion();
  listContext = ctxNow;
  // In Sent/Drafts the recipient matters, not yourself
  const use = currentAccount ? folderInfo(currentAccount, currentFolder)?.specialUse : '';
  const showTo = use === '\\Sent' || use === '\\Drafts';
  const listFolder = currentAccount ? currentFolder : 'INBOX';

  el('#scope-seg').hidden = !q;
  el('#kind-seg').hidden = !q;
  // Search also finds appointments and contacts (not with the mail-only filters)
  const others = !!q && listFilter === 'all' && !labelFilter;
  const evs = others ? eventHits : [];
  const cts = others ? contactHits : [];
  const tks = others ? taskHits : [];
  // counts only once the search is finished – the interim numbers would jump around
  const phase = q ? searchPhase : 'idle';
  const busy = phase !== 'idle';
  const typing = phase === 'typing';
  el('#kind-n-mail').textContent = q && !busy ? String(shown.length) : '';
  el('#kind-n-event').textContent = evs.length && !typing ? String(evs.length) : '';
  el('#kind-n-contact').textContent = cts.length && !typing ? String(cts.length) : '';
  el('#kind-n-task').textContent = tks.length && !typing ? String(tks.length) : '';
  if (q && searchKind !== 'all' && searchKind !== 'mail') shown = [];
  const progressRow = (text: string) => `<div class="search-progress" role="status"><span class="search-spin"></span>${esc(text)}</div>`;
  // first the fast hits; the mails from the server are added below them later
  const serverRow = phase === 'server' && (searchKind === 'all' || searchKind === 'mail') ? progressRow(t('search.runningServer')) : '';
  const extraHtml = (typing ? progressRow(t('search.runningAll')) : '') + (q ? searchHitsHtml(evs, cts, tks, shown.length) : '') + serverRow;
  // Conversations: only in normal folders, not while searching or in filtered/virtual views
  const rows = !q && !inVirtual() ? buildThreads(shown) : shown;
  closedThreads.clear(); // filled again while the rows are drawn
  const rowOpts = { showTo, listFolder, animateNew };
  shownKeys = rows.flatMap((row) => (isThread(row) ? (expandedThreads.has(row.id) ? row.mails : [row.mails[0]]) : [row]).map(mailKey));
  paintThreadToggle();
  if (!accounts.length) {
    el('#mail-list').innerHTML = `<div class="list-empty">${esc(t('mail.noAccount'))}<br><button class="btn ghost" data-action="add-account">${esc(t('settings.addMailAccount'))}</button></div>`;
    return;
  }
  el('#mail-list').innerHTML =
    extraHtml +
    (rows
      .map((row) => (isThread(row) ? threadRowsHtml(row, rowOpts) : mailRowHtml(row, rowOpts)))
      .join('') || (extraHtml || busy ? '' : `<div class="list-empty">${esc(q ? t('mail.noHits') : listFilter !== 'all' || labelFilter ? t('mail.noFiltered') : t('mail.folderEmpty'))}</div>`));
  listKeysBefore = new Set(shownKeys);
  if (typeof renderLabelSidebar === 'function') renderLabelSidebar();
}

// ---------- Right-click on a folder: all read; trash / spam as a whole ----------

const folderMenu = document.createElement('div');
folderMenu.className = 'ctx-menu';
folderMenu.setAttribute('role', 'menu');
folderMenu.hidden = true;
document.body.appendChild(folderMenu);
let folderMenuAcc = '';
let folderMenuPath = '';

el('#account-list').addEventListener('contextmenu', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.folder[data-folder]');
  const accId = row?.dataset.account;
  if (!row || !accId) return;
  e.preventDefault();
  const use = folderInfo(accId, row.dataset.folder!)?.specialUse;
  folderMenuAcc = accId;
  folderMenuPath = row.dataset.folder!;
  folderMenu.innerHTML =
    `<button type="button" role="menuitem" data-folder-act="allRead">${ACT_ICONS.read}<span>${esc(t('folder.markAllRead'))}</span></button>` +
    (use === '\\Trash'
      ? `<hr><button type="button" role="menuitem" class="danger" data-folder-act="emptyTrash">${ACT_ICONS.trash}<span>${esc(t('folder.emptyTrash'))}</span></button>`
      : use === '\\Junk'
        ? `<hr><button type="button" role="menuitem" data-folder-act="junkToTrash">${ACT_ICONS.trash}<span>${esc(t('folder.junkToTrash'))}</span></button>`
        : '');
  folderMenu.hidden = false;
  const r = folderMenu.getBoundingClientRect();
  folderMenu.style.left = `${Math.min(e.clientX, innerWidth - r.width - 6)}px`;
  folderMenu.style.top = `${Math.min(e.clientY, innerHeight - r.height - 6)}px`;
});
document.addEventListener('mousedown', (e) => {
  if (!folderMenu.contains(e.target as Node)) folderMenu.hidden = true;
});
document.addEventListener('scroll', () => (folderMenu.hidden = true), true); // e.g. the sidebar

// No question: marking read can be undone mail by mail
async function markFolderRead(accountId: string, folder: string): Promise<void> {
  setStatus(t('status.updating'));
  try {
    const n = await window.api.markFolderSeen(accountId, folder);
    // the open list shows it right away
    for (const m of mails) if (m.accountId === accountId && m.folder === folder) m.seen = true;
    renderList();
    updateCounts();
    loadFolders(accountId);
    setStatus(n ? t('folder.markedRead', { n }) : t('folder.noneUnread'));
  } catch (err) {
    setStatus(errMsg(err));
  }
}

folderMenu.addEventListener('click', async (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-folder-act]')?.dataset.folderAct as 'allRead' | 'emptyTrash' | 'junkToTrash' | undefined;
  const acc = accountOf(folderMenuAcc);
  folderMenu.hidden = true;
  if (!act || !acc) return;
  if (act === 'allRead') return void markFolderRead(acc.id, folderMenuPath);
  if (!confirm(t(act === 'emptyTrash' ? 'folder.emptyTrashConfirm' : 'folder.junkToTrashConfirm', { email: acc.email }))) return;
  setStatus(t('status.updating'));
  try {
    const done = act === 'emptyTrash' ? await window.api.emptyTrash(acc.id) : await window.api.junkToTrash(acc.id);
    setStatus(done ? t(act === 'emptyTrash' ? 'folder.trashEmptied' : 'folder.junkMoved', { n: done }) : t('folder.alreadyEmpty'));
    // the open folder was affected → reload the list
    const openUse = currentAccount === acc.id ? folderInfo(acc.id, currentFolder)?.specialUse : '';
    if (openUse === '\\Trash' || openUse === '\\Junk') {
      clearReader();
      await loadMails();
    }
    loadFolders(acc.id);
  } catch (err) {
    setStatus(errMsg(err));
  }
});

// ---------- Reading pane ----------

function clearReader(text = t('mail.noneSelected')): void {
  clearTimeout(readTimer);
  currentMsg = null;
  selectedKey = '';
  selected.clear();
  el('#reader').innerHTML = `<div class="empty">${esc(text)}</div>`;
}

function setSeenLocal(key: string): void {
  for (const m of [summaryOf(key), ...mails, ...flaggedMails, ...(searchResults ?? [])]) if (m && mailKey(m) === key) m.seen = true;
}

// Still the same mail on screen → mark read quietly (no status message)
async function markReadAfterDelay(key: string): Promise<void> {
  if (selectedKey !== key || summaryOf(key)?.seen !== false) return;
  setSeenLocal(key);
  renderList();
  updateCounts();
  const { accountId, folder, uid } = parseKey(key);
  try {
    await window.api.setSeen(accountId, folder, [uid], true);
    if (folderCache.has(accountId)) loadFolders(accountId);
  } catch {
    /* offline – stays read locally, the next sync corrects it */
  }
}

async function openMail(key: string, loadImages = false): Promise<void> {
  const { accountId, folder, uid } = parseKey(key);
  selectedKey = key;
  selected = new Set([key]);
  anchorKey = key;

  // Read: at once, after a few seconds on this mail, or only by hand
  clearTimeout(readTimer);
  const unread = summaryOf(key)?.seen === false;
  if (unread && readDelay === 0) setSeenLocal(key);
  else if (unread && readDelay > 0) readTimer = window.setTimeout(() => markReadAfterDelay(key), readDelay * 1000);
  renderList();
  updateCounts();

  const reader = el('#reader');
  if (!loadImages) reader.innerHTML = `<div class="empty">${esc(t('status.loading'))}</div>`;

  let msg: MailDetail;
  try {
    msg = await window.api.getMail(accountId, folder, uid, loadImages, readDelay === 0);
  } catch (e) {
    if (selectedKey === key) reader.innerHTML = `<div class="empty">${esc(errMsg(e))}</div>`;
    return;
  }
  if (selectedKey !== key) return; // another mail selected in the meantime
  currentMsg = { ...msg, folder };

  // Archive only if the account has an archive folder (move: drag the mail onto a folder)
  if (!folderCache.has(accountId)) await loadFolders(accountId);
  const isArchive = folderInfo(accountId, folder)?.specialUse === '\\Archive';
  const hasArchive = (folderCache.get(accountId) ?? []).some((f) => f.specialUse === '\\Archive');
  const inTrash = folderInfo(accountId, folder)?.specialUse === '\\Trash';
  const inJunk = folderInfo(accountId, folder)?.specialUse === '\\Junk';
  const hasJunk = (folderCache.get(accountId) ?? []).some((f) => f.specialUse === '\\Junk');
  const flagged = !!summaryOf(key)?.flagged;
  const acc = accountOf(accountId);

  reader.innerHTML = `
    <div class="reader-actions">
      ${replyButtonsHtml()}
      <span class="spacer"></span>
      <button class="icon-btn sm star-btn${flagged ? ' on' : ''}" data-action="flag" aria-pressed="${flagged}" aria-label="${esc(t(flagged ? 'mail.unflag' : 'mail.flag'))}" title="${esc(t(flagged ? 'mail.unflag' : 'mail.flag'))}">${flagged ? '★' : '☆'}</button>
      <button class="icon-btn sm" data-action="window" aria-label="${esc(t('mail.openWindow'))}" title="${esc(t('mail.openWindow'))}">${ACT_ICONS.window}</button>
      <button class="icon-btn sm" data-action="unread" aria-label="${esc(t('mail.markUnread'))}" title="${esc(t('mail.markUnread'))}">${ACT_ICONS.unread}</button>
      ${inJunk ? `<button class="icon-btn sm" data-action="notspam" aria-label="${esc(t('mail.notSpam'))}" title="${esc(t('mail.notSpam'))}">${ACT_ICONS.notSpam}</button>` : hasJunk ? `<button class="icon-btn sm" data-action="spam" aria-label="${esc(t('mail.spam'))}" title="${esc(t('mail.spam'))}">${ACT_ICONS.spam}</button>` : ''}
      ${hasArchive && !isArchive ? `<button class="icon-btn sm" data-action="archive" aria-label="${esc(t('mail.archive'))}" title="${esc(t('mail.archive'))}">${icon('\\Archive')}</button>` : ''}
      <button class="icon-btn sm danger" data-action="delete" aria-label="${esc(t(inTrash ? 'mail.deleteForever' : 'mail.delete'))}" title="${esc(t(inTrash ? 'mail.deleteForever' : 'mail.deleteTip'))}">${icon('\\Trash')}</button>
    </div>
    ${metaHtml(msg, `${accLabel(acc).toUpperCase()} · ${folderLabel(accountId, folder).toUpperCase()}`, colorOf(accountId), labelPills(labelsOf({ ...msg, folder })))}
    ${inviteCardHtml(currentMsg)}
    <div id="body"></div>
    ${attachmentsHtml(msg)}`;

  mountMailBody(el('#body'), msg, () => openMail(key, true));
  fillInviteCalendars();
}

// ---------- Selection: Ctrl+click single, Shift+click range, Ctrl+A all ----------

function paintSelection(): void {
  // Only toggle classes – no rebuild (would cancel a running drag)
  document.querySelectorAll<HTMLElement>('#mail-list .mail').forEach((r) => r.classList.toggle('selected', selected.has(r.dataset.key!)));
}

function showSelection(): void {
  paintSelection();
  if (selected.size === 1) {
    const [only] = selected;
    if (only !== selectedKey || !currentMsg) openMail(only);
  } else if (selected.size > 1) {
    showMulti();
  } else {
    clearReader();
  }
}

function showMulti(): void {
  currentMsg = null;
  selectedKey = '';
  const n = selected.size;
  el('#reader').innerHTML = `
    <div class="multi">
      <div class="multi-count">${n}</div>
      <h2>${t('mail.multiTitle')}</h2>
      <p class="hint">${esc(t('mail.multiHint'))}</p>
      <div class="multi-actions">
        <button class="btn ghost with-ico" data-action="seen">${ACT_ICONS.read}${esc(t('mail.markRead'))}</button>
        <button class="btn ghost with-ico" data-action="unseen">${ACT_ICONS.unread}${esc(t('mail.markUnread'))}</button>
        <button class="btn ghost" data-action="archive">${icon('\\Archive')} ${esc(t('mail.archive'))}</button>
        <button class="btn ghost danger-text" data-action="delete">${icon('\\Trash')} ${esc(t('mail.delete'))}</button>
        <button class="link" data-action="clear-selection">${esc(t('mail.clearSelection'))}</button>
      </div>
    </div>`;
}

function selectRange(toKey: string): void {
  const a = shownKeys.indexOf(anchorKey);
  const b = shownKeys.indexOf(toKey);
  if (a === -1 || b === -1) {
    selected = new Set([toKey]);
    anchorKey = toKey;
    return;
  }
  const [from, to] = a < b ? [a, b] : [b, a];
  selected = new Set(shownKeys.slice(from, to + 1));
}

// ---------- Move / archive / delete (one or more mails) ----------

// Hide rows: delete slides left (red), move/archive slides right
function animateRowsOut(keys: string[], kind: 'delete' | 'move'): Promise<void> {
  const rows = keys.map((k) => document.querySelector<HTMLElement>(`#mail-list [data-key="${CSS.escape(k)}"]`)).filter(Boolean) as HTMLElement[];
  if (!rows.length || reduceMotion()) return Promise.resolve();
  for (const r of rows) {
    r.style.height = `${r.offsetHeight}px`;
    r.getBoundingClientRect(); // remember the start value
    r.classList.add('leaving', kind === 'delete' ? 'leave-left' : 'leave-right');
  }
  return new Promise((res) => setTimeout(res, 280));
}

const isTrash = (accountId: string, folder: string) => folderInfo(accountId, folder)?.specialUse === '\\Trash';

async function removeMails(keys: string[], action: 'delete' | 'archive' | { move: string }): Promise<void> {
  if (!keys.length) return;
  // one call per account and folder
  const groups = new Map<string, { accountId: string; folder: string; uids: number[] }>();
  for (const k of keys) {
    const p = parseKey(k);
    const g = groups.get(`${p.accountId}|${p.folder}`) ?? { accountId: p.accountId, folder: p.folder, uids: [] };
    g.uids.push(p.uid);
    groups.set(`${p.accountId}|${p.folder}`, g);
  }
  const n = keys.length;
  if (action === 'delete' && [...groups.values()].some((g) => isTrash(g.accountId, g.folder))) {
    if (!confirm(n === 1 ? t('mail.confirmDeleteForever') : t('mail.confirmDeleteForeverN', { n }))) return;
  }
  const firstIdx = Math.min(...keys.map((k) => shownKeys.indexOf(k)).filter((i) => i >= 0));
  let deletedForever = false;
  const anim = animateRowsOut(keys, action === 'delete' ? 'delete' : 'move');
  try {
    for (const g of groups.values()) {
      if (action === 'delete') {
        if ((await window.api.deleteMails(g.accountId, g.folder, g.uids)) === 'deleted') deletedForever = true;
      } else {
        await window.api.moveMails(g.accountId, g.folder, g.uids, action === 'archive' ? '\\Archive' : action.move);
      }
    }
  } catch (err) {
    setStatus(errMsg(err));
    await anim;
    listContext = ''; // redraw without the fade-in animation
    loadMails(); // fetch the state from the server in case part of it was already done
    return;
  }
  await anim;
  const one = n === 1;
  if (action === 'delete') setStatus(deletedForever ? (one ? t('mail.deletedForever') : t('mail.deletedForeverN', { n })) : one ? t('mail.movedToTrash') : t('mail.movedToTrashN', { n }));
  else if (action === 'archive') setStatus(one ? t('mail.archived') : t('mail.archivedN', { n }));
  else {
    const folder = action.move === '\\Junk' ? t('folder.junk') : folderLabel([...groups.values()][0].accountId, action.move);
    setStatus(one ? t('mail.movedTo', { folder }) : t('mail.movedToN', { n, folder }));
  }

  const gone = new Set(keys);
  mails = mails.filter((m) => !gone.has(mailKey(m)));
  if (searchResults) searchResults = searchResults.filter((m) => !gone.has(mailKey(m)));
  clearReader();
  renderList();
  updateCounts();
  // Continue: the mail that now sits where the first removed one was
  const next = Number.isFinite(firstIdx) ? shownKeys[Math.min(firstIdx, shownKeys.length - 1)] : undefined;
  if (next) openMail(next);
  for (const id of new Set([...groups.values()].map((g) => g.accountId))) loadFolders(id); // update counts
}

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || el('.app').dataset.view !== 'mail') return;
  const tgt = e.target as HTMLElement;
  if (tgt.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (e.key === 'Delete' && selected.size) {
    e.preventDefault();
    removeMails([...selected], 'delete');
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && shownKeys.length) {
    e.preventDefault();
    selected = new Set(shownKeys);
    anchorKey = shownKeys[0];
    showSelection();
  } else if (e.key === 'Escape' && selected.size > 1) {
    clearReader();
    paintSelection();
  }
});

// ---------- Drag & drop: drag mails onto a folder ----------

let dragKeys: string[] = [];

el('#mail-list').addEventListener('dragstart', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
  if (!row || !e.dataTransfer) return;
  const key = row.dataset.key!;
  if (!selected.has(key)) {
    selected = new Set([key]);
    anchorKey = key;
    paintSelection();
  }
  dragKeys = [...new Set([...selected].flatMap((k) => closedThreads.get(k) ?? [k]))];
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-agenoras', JSON.stringify(dragKeys));
  // drag image: "3 messages" or the subject
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  const subject = summaryOf(dragKeys[0])?.subject || t('mail.noSubject');
  ghost.textContent = dragKeys.length === 1 ? subject : t('mail.dragCount', { n: dragKeys.length });
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, -12, -12);
  setTimeout(() => ghost.remove(), 0);
  document.querySelectorAll<HTMLElement>('#mail-list .mail.selected').forEach((r) => r.classList.add('dragging'));
});

el('#mail-list').addEventListener('dragend', () => {
  dragKeys = [];
  document.querySelectorAll('.dragging').forEach((r) => r.classList.remove('dragging'));
  document.querySelectorAll('.drop-target').forEach((r) => r.classList.remove('drop-target'));
  if (selected.size === 1) showSelection(); // dragged but not dropped → show the mail
});

// Valid target: folder (or inbox) of the same account, not the folder the mails come from
function dropTarget(e: DragEvent): { el: HTMLElement; accountId: string; folder: string } | null {
  if (!dragKeys.length) return null;
  const tgt = (e.target as HTMLElement).closest<HTMLElement>('#account-list .folder, #account-list .acc-row');
  if (!tgt?.dataset.account) return null;
  const accountId = tgt.dataset.account;
  const folder = tgt.dataset.folder ?? 'INBOX';
  const keys = dragKeys.map(parseKey);
  if (!keys.every((k) => k.accountId === accountId) || keys.every((k) => k.folder === folder)) return null;
  return { el: tgt, accountId, folder };
}

el('#account-list').addEventListener('dragover', (e) => {
  const target = dropTarget(e);
  document.querySelectorAll('.drop-target').forEach((r) => r !== target?.el && r.classList.remove('drop-target'));
  if (!target) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'move';
  target.el.classList.add('drop-target');
});

el('#account-list').addEventListener('dragleave', (e) => {
  if (!el('#account-list').contains(e.relatedTarget as Node)) document.querySelectorAll('.drop-target').forEach((r) => r.classList.remove('drop-target'));
});

el('#account-list').addEventListener('drop', (e) => {
  const target = dropTarget(e);
  if (!target) return;
  e.preventDefault();
  const keys = dragKeys.filter((k) => parseKey(k).folder !== target.folder);
  dragKeys = [];
  target.el.classList.remove('drop-target');
  target.el.classList.add('drop-hit');
  setTimeout(() => target.el.classList.remove('drop-hit'), 600);
  removeMails(keys, { move: target.folder });
});

// ---------- Account dialog ----------

const dlg = el<HTMLDialogElement>('#dlg-add');
const form = el<HTMLFormElement>('#form-add');
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;

let editingAccountId: string | null = null; // set = edit account
const ACC_COLORS = ['#2BA89F', '#7FA6CF', '#E0574B', '#E0A458', '#B48EAD', '#4DB37A', '#D9C35B', '#969993'];
let accColor = ACC_COLORS[0];

function paintAccColors(): void {
  const custom = !ACC_COLORS.includes(accColor);
  el('#acc-colors').innerHTML =
    ACC_COLORS.map(
      (c) => `<button type="button" role="radio" aria-checked="${c === accColor}" class="swatch${c === accColor ? ' on' : ''}" data-acc-color="${c}" style="background:${c}" aria-label="${c}"></button>`,
    ).join('') +
    `<label class="swatch custom${custom ? ' on' : ''}" style="background:${accColor}" title="${esc(t('account.customColor'))}">+<input type="color" id="acc-color-custom" value="${accColor}" aria-label="${esc(t('account.customColor'))}"></label>`;
}

el('#acc-colors').addEventListener('click', (e) => {
  const c = (e.target as HTMLElement).closest<HTMLElement>('[data-acc-color]')?.dataset.accColor;
  if (!c) return;
  accColor = c;
  paintAccColors();
});
el('#acc-colors').addEventListener('change', (e) => {
  const inp = e.target as HTMLInputElement;
  if (inp.id !== 'acc-color-custom') return;
  accColor = inp.value.toUpperCase();
  paintAccColors();
});

function setAccountDialogMode(edit: boolean): void {
  dlg.querySelector('h2')!.innerHTML = t(edit ? 'account.editTitle' : 'account.addTitle');
  field('pass').required = !edit;
  field('pass').placeholder = edit ? t('account.passKeep') : '';
  el('#btn-save').textContent = t(edit ? 'btn.saveConnect' : 'btn.connect');
}

function openAddMailAccount(): void {
  editingAccountId = null;
  form.reset();
  accColor = ACC_COLORS[accounts.length % ACC_COLORS.length];
  paintAccColors();
  fillPrivacyFields(null);
  fillProtocolFields(null);
  setAccountDialogMode(false);
  el('#add-error').textContent = '';
  dlg.showModal();
}

function openEditMailAccount(id: string): void {
  const acc = accountOf(id);
  if (!acc) return;
  editingAccountId = id;
  form.reset();
  accColor = acc.color;
  paintAccColors();
  fillPrivacyFields(acc);
  setAccountDialogMode(true);
  field('name').value = acc.name === acc.email ? '' : acc.name;
  field('email').value = acc.email;
  field('host').value = acc.host;
  field('port').value = String(acc.port);
  field('secure').checked = acc.secure;
  field('smtpHost').value = acc.smtpHost;
  field('smtpPort').value = String(acc.smtpPort);
  field('smtpSecure').checked = acc.smtpSecure;
  field('user').value = acc.user;
  fillProtocolFields(acc);
  el('#add-error').textContent = '';
  dlg.showModal();
}
el('#btn-cancel').addEventListener('click', () => dlg.close());

// ---------- Private account (PIN) in the account dialog ----------

const AUTOLOCK_CHOICES = [1, 2, 5, 10, 15, 30];
const lockSelect = () => form.elements.namedItem('autoLockMin') as HTMLSelectElement;

function fillPrivacyFields(acc: Account | null): void {
  field('private').checked = !!acc?.private;
  el('#priv-fields').hidden = !acc?.private;
  lockSelect().innerHTML = AUTOLOCK_CHOICES.map((n) => `<option value="${n}">${esc(t('account.autoLockMin', { n }))}</option>`).join('');
  lockSelect().value = String(acc?.autoLockMin ?? 5);
  // already private: empty PIN = keep the current one
  for (const f of ['pin', 'pin2']) field(f).placeholder = acc?.private ? t('account.passKeep') : '';
}

field('private').addEventListener('change', () => {
  el('#priv-fields').hidden = !field('private').checked;
  if (field('private').checked) field('pin').focus();
});

function readPrivacyFields(wasPrivate: boolean): { on: boolean; pin: string; min: number } {
  const on = field('private').checked;
  const pin = field('pin').value.trim();
  const min = Number(lockSelect().value) || 5;
  if (on && (pin || !wasPrivate)) {
    if (!/^\d{4,8}$/.test(pin)) throw new Error(t('err.pinFormat'));
    if (pin !== field('pin2').value.trim()) throw new Error(t('err.pinMismatch'));
  }
  return { on, pin, min };
}

// ---------- Incoming mail: IMAP or POP3 ----------

const protoSelect = () => form.elements.namedItem('protocol') as HTMLSelectElement;
const isPopForm = () => protoSelect().value === 'pop3';
const POP_DAYS = [0, 7, 14, 30, 90, 365];
const defaultPort = (pop: boolean, secure: boolean) => (pop ? (secure ? 995 : 110) : secure ? 993 : 143);

// Labels, placeholder and POP3 options follow the protocol; a default port is switched along
function syncProtocolUi(switched = false): void {
  const pop = isPopForm();
  el('#host-label').textContent = t(pop ? 'account.popServer' : 'account.imapServer');
  field('host').placeholder = pop ? 'pop.example.com' : 'imap.example.com';
  el('#secure-label').textContent = field('secure').checked ? 'SSL/TLS' : t('account.startTls');
  el('#pop-fields').hidden = !pop;
  (form.elements.namedItem('deleteAfterDays') as HTMLSelectElement).disabled = !field('leaveOnServer').checked;
  if (switched) {
    const port = Number(field('port').value);
    if (!port || [993, 143, 995, 110].includes(port)) field('port').value = String(defaultPort(pop, field('secure').checked));
    const host = field('host').value.trim();
    if (pop && /^imap\./i.test(host)) field('host').value = host.replace(/^imap\./i, 'pop.');
    if (!pop && /^pop3?\./i.test(host)) field('host').value = host.replace(/^pop3?\./i, 'imap.');
  }
}

function fillProtocolFields(acc: Account | null): void {
  protoSelect().value = acc?.protocol === 'pop3' ? 'pop3' : 'imap';
  field('leaveOnServer').checked = acc?.leaveOnServer !== false;
  const days = form.elements.namedItem('deleteAfterDays') as HTMLSelectElement;
  days.innerHTML = POP_DAYS.map((n) => `<option value="${n}">${esc(n ? t('account.afterDays', { n }) : t('account.never'))}</option>`).join('');
  days.value = String(acc?.deleteAfterDays ?? 0);
  syncProtocolUi();
}

protoSelect().addEventListener('change', () => syncProtocolUi(true));
field('secure').addEventListener('change', () => syncProtocolUi(true));
field('leaveOnServer').addEventListener('change', () => syncProtocolUi());

field('email').addEventListener('change', () => {
  const email = field('email').value.trim();
  const domain = email.split('@')[1];
  if (!domain) return;
  if (!field('user').value) field('user').value = email;
  if (!field('host').value) field('host').value = `${isPopForm() ? 'pop' : 'imap'}.${domain}`;
  if (!field('smtpHost').value) field('smtpHost').value = `smtp.${domain}`;
});

field('smtpSecure').addEventListener('change', () => {
  field('smtpPort').value = field('smtpSecure').checked ? '465' : '587';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const save = el<HTMLButtonElement>('#btn-save');
  let priv: ReturnType<typeof readPrivacyFields>;
  try {
    priv = readPrivacyFields(!!(editingAccountId && accountOf(editingAccountId)?.private));
  } catch (err) {
    el('#add-error').textContent = errMsg(err);
    return;
  }
  save.disabled = true;
  save.textContent = t('btn.connecting');
  el('#add-error').textContent = '';
  const input = {
    name: field('name').value.trim(),
    email: field('email').value.trim(),
    host: field('host').value.trim(),
    port: Number(field('port').value) || 993,
    secure: field('secure').checked,
    user: field('user').value.trim(),
    smtpHost: field('smtpHost').value.trim(),
    smtpPort: Number(field('smtpPort').value) || 465,
    smtpSecure: field('smtpSecure').checked,
    protocol: protoSelect().value as 'imap' | 'pop3',
    leaveOnServer: field('leaveOnServer').checked,
    deleteAfterDays: Number((form.elements.namedItem('deleteAfterDays') as HTMLSelectElement).value) || 0,
    pass: field('pass').value,
    color: accColor,
    ...(priv.on && !editingAccountId ? { pin: priv.pin, autoLockMin: priv.min } : {}),
  };
  const editing = editingAccountId;
  const old = editing ? accountOf(editing) : undefined;
  // PIN protection on/off/changed: saved on its own (no reconnect)
  if (old && (priv.on !== !!old.private || (priv.on && (priv.pin || priv.min !== old.autoLockMin)))) {
    try {
      await window.api.privacy.set(old.id, priv.on ? priv.pin : null, priv.min);
    } catch (err) {
      el('#add-error').textContent = errMsg(err);
      save.disabled = false;
      save.textContent = t('btn.saveConnect');
      return;
    }
  }
  // Only colour/privacy changed → save without testing and reconnecting
  const sameProtocol = input.protocol === (old?.protocol ?? 'imap') && (input.protocol !== 'pop3' || (input.leaveOnServer === (old?.leaveOnServer !== false) && input.deleteAfterDays === (old?.deleteAfterDays ?? 0)));
  if (old && !input.pass && sameProtocol && (['email', 'host', 'port', 'secure', 'user', 'smtpHost', 'smtpPort', 'smtpSecure'] as const).every((k) => input[k] === old[k]) && (input.name || input.email) === old.name) {
    try {
      await window.api.setAccountColor(old.id, accColor);
      dlg.close();
      await loadAccounts();
      markActive();
      renderList();
      if (currentMsg) openMail(mailKey(currentMsg));
      setStatus(t('account.saved', { email: old.email }));
    } catch (err) {
      el('#add-error').textContent = errMsg(err);
    } finally {
      save.disabled = false;
      save.textContent = t('btn.saveConnect');
    }
    return;
  }
  try {
    const acc = editing ? await window.api.updateAccount(editing, input) : await window.api.addAccount(input);
    dlg.close();
    folderCache.delete(acc.id);
    await loadAccounts();
    if (!editing) currentAccount = null;
    markActive();
    await loadMails();
    if (currentAccount) loadFolders(currentAccount);
    setStatus(t(editing ? 'account.updated' : 'account.connected', { email: acc.email }));
  } catch (err) {
    el('#add-error').textContent = errMsg(err);
  } finally {
    save.disabled = false;
    save.textContent = t(editingAccountId ? 'btn.saveConnect' : 'btn.connect');
  }
});

// ---------- Open the compose window: new, reply, forward ----------
// The window itself (editor, recipients, attachments, sending) lives in compose.html / compose.ts.

function openCompose(opts: ComposeOpts = {}): void {
  if (!accounts.length) {
    setStatus(t('mail.addAccountFirst'));
    return;
  }
  window.api.compose.open({ accountId: currentAccount ?? undefined, ...opts });
}

function reply(all: boolean): void {
  if (currentMsg) openCompose(replyOpts(currentMsg, all));
}

function forward(): void {
  if (currentMsg) openCompose(forwardOpts(currentMsg));
}

el('#btn-compose').addEventListener('click', () => openCompose());

// Reading pane: reply/forward/archive/delete and open/save attachments
el('#reader').addEventListener('click', async (e) => {
  const tgt = e.target as HTMLElement;
  const action = tgt.closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action === 'reply') return reply(false);
  if (action === 'replyAll') return reply(true);
  if (action === 'forward') return forward();
  if (action === 'window' && currentMsg) return void window.api.mailview.open(parseKey(mailKey(currentMsg)));
  if (action === 'flag' && currentMsg) return toggleFlag([mailKey(currentMsg)]);
  if (action === 'spam' && currentMsg) return removeMails([mailKey(currentMsg)], { move: '\\Junk' });
  if (action === 'notspam' && currentMsg) return removeMails([mailKey(currentMsg)], { move: 'INBOX' });
  if (action === 'unread' && currentMsg) {
    const key = mailKey(currentMsg);
    clearReader();
    return markSeen([key], false);
  }
  if (action === 'archive' || action === 'delete') return removeMails(selected.size ? [...selected] : currentMsg ? [mailKey(currentMsg)] : [], action);
  if (action === 'seen') return markSeen([...selected], true);
  if (action === 'unseen') return markSeen([...selected], false);
  if (action === 'clear-selection') {
    clearReader();
    return paintSelection();
  }
  if (currentMsg && (await reactionAction(currentMsg, tgt, setStatus))) return;
  if (currentMsg) await attachmentAction(currentMsg, tgt, setStatus);
});

// Drop files onto the main window → new mail with these attachments; never navigate away
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (!e.dataTransfer?.files.length || document.querySelector('dialog[open]')) return;
  const files: PickedFile[] = [];
  for (const f of Array.from(e.dataTransfer.files)) {
    try {
      files.push(await window.api.files.dropped(f));
    } catch {
      /* skip folders */
    }
  }
  if (files.length) openCompose({ files });
});

// Feedback from the compose window ("Sent to …")
window.api.onStatus((text) => setStatus(text));

// Light/dark switched: recompute account colors
LIGHT_MQ.addEventListener('change', () => {
  renderAccounts();
  renderList();
  if (selectedKey) openMail(selectedKey);
});

// ---------- Events ----------

el('.side').addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>('[data-virtual]')?.dataset.virtual;
  if (v) return openVirtual(v);
  const twAcc = (e.target as HTMLElement).closest<HTMLElement>('[data-tw-acc]')?.dataset.twAcc;
  if (twAcc) return toggleAccountOpen(twAcc);
  const twFolder = (e.target as HTMLElement).closest<HTMLElement>('[data-tw-folder]');
  if (twFolder) {
    const key = `${twFolder.closest<HTMLElement>('[data-account]')!.dataset.account}|${twFolder.dataset.twFolder}`;
    if (collapsedFolders.has(key)) collapsedFolders.delete(key);
    else collapsedFolders.add(key);
    saveSet('mail.collapsedFolders', collapsedFolders);
    return renderAccounts();
  }
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-account]');
  if (!b || b.closest('#side-contacts')) return;
  flaggedView = false;
  labelView = null;
  const account = b.dataset.account || null;
  const folder = b.dataset.folder ?? 'INBOX';
  if (account && b.dataset.folder === undefined) {
    // Clicking an account expands it; clicking the active account again collapses it
    if (account === currentAccount && currentFolder === 'INBOX') expandedAccs.has(account) ? expandedAccs.delete(account) : expandedAccs.add(account);
    else expandedAccs.add(account);
    saveSet('mail.expandedAccounts', expandedAccs);
  }
  currentAccount = account;
  currentFolder = account ? folder : 'INBOX';
  resetSearch();
  clearReader();
  renderAccounts();
  loadMails();
  if (account) loadFolders(account);
});


el('#mail-list').addEventListener('click', (e) => {
  const tgt = e.target as HTMLElement;
  if (tgt.closest('[data-action="add-account"]')) return openAddMailAccount();
  const go = tgt.closest<HTMLElement>('[data-kind-go]')?.dataset.kindGo;
  if (go) return setSearchKind(go as typeof searchKind);
  const evIdx = tgt.closest<HTMLElement>('[data-hit-event]')?.dataset.hitEvent;
  if (evIdx !== undefined) {
    const ev = eventHits[Number(evIdx)];
    if (ev) {
      setView('cal');
      void openEventAt(ev);
    }
    return;
  }
  const taskIdx = tgt.closest<HTMLElement>('[data-hit-task]')?.dataset.hitTask;
  if (taskIdx !== undefined) {
    const task = taskHits[Number(taskIdx)];
    if (task) {
      setView('tasks');
      openTaskDialog(taskItems.find((x) => x.id === task.id) ?? task);
    }
    return;
  }
  const contactId = tgt.closest<HTMLElement>('[data-hit-contact]')?.dataset.hitContact;
  if (contactId) {
    setView('contacts');
    return void showContact(contactId);
  }
  const starKey = (e.target as HTMLElement).closest('[data-star]') && (e.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key;
  if (starKey) {
    e.stopPropagation();
    return void toggleFlag([starKey]);
  }
  const key = (e.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key;
  if (!key) return;
  // Double-click → own window. Detected by hand: the first click re-renders the list, so the
  // browser's own dblclick never fires (the second click hits a new element)
  const now = Date.now();
  const isDouble = lastListClick.key === key && now - lastListClick.at < 450 && !e.ctrlKey && !e.metaKey && !e.shiftKey;
  lastListClick = isDouble ? { key: '', at: 0 } : { key, at: now };
  if (isDouble) return void window.api.mailview.open(parseKey(key));
  if (e.ctrlKey || e.metaKey) {
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    anchorKey = key;
  } else if (e.shiftKey && anchorKey) {
    selectRange(key);
  } else {
    openMail(key);
    return;
  }
  showSelection();
});

// Shift+click should not select text
el('#mail-list').addEventListener('mousedown', (e) => {
  if (e.shiftKey) e.preventDefault();
});

// Double-click: mail in its own window
let lastListClick = { key: '', at: 0 }; // double-click detection, see the click handler above

// ---------- Filters and search (full text on the server) ----------

let searchTimer: number | undefined;

// Search running: ring in the field; while waiting for the first hits the old ones are dimmed
function setSearchPhase(phase: typeof searchPhase): void {
  searchPhase = phase;
  el('#search-box').classList.toggle('busy', phase !== 'idle');
  el('#mail-list').classList.toggle('searching', phase === 'typing');
}

function resetSearch(): void {
  el<HTMLInputElement>('#search').value = '';
  searchResults = null;
  eventHits = [];
  contactHits = [];
  taskHits = [];
  searchKind = 'all';
  paintSegs();
  searchSeq++;
  setSearchPhase('idle');
}

const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

// Contacts and tasks: what's loaded, otherwise the local cache – the server load runs in the background
async function quickContacts(ql: string): Promise<Contact[]> {
  void ensureContacts().catch(() => {});
  const list = contacts.length ? contacts : (await window.api.contacts.cached().catch(() => ({ contacts: [] as Contact[] }))).contacts;
  return list.filter((c) => contactMatches(c, ql));
}
async function quickTasks(ql: string): Promise<Task[]> {
  void ensureTasks().catch(() => {});
  const list = taskItems.length ? taskItems : (await window.api.tasks.cached().catch(() => ({ tasks: [] as Task[] }))).tasks;
  return list.filter((x) => `${x.title} ${x.notes}`.toLowerCase().includes(ql)).sort((a, b) => Number(a.done) - Number(b.done));
}

// Two steps so that something shows up right away:
// 1. local copies of the mails + contacts, tasks, appointments (≈ instantly)
// 2. full-text search on the mail server – its hits are added below
async function runSearch(): Promise<void> {
  const q = el<HTMLInputElement>('#search').value.trim();
  const seq = ++searchSeq;
  if (q.length < 2) {
    setSearchPhase('idle');
    return renderList();
  }
  setSearchPhase('typing');
  renderList();
  setStatus(t('search.running'));
  const folder = searchScope === 'all' ? null : currentAccount ? currentFolder : 'INBOX';
  const ql = q.toLowerCase();
  type MailRes = { mails: MailSummary[] | null; errors: { accountId: string; message: string }[]; failed?: string };
  const server: Promise<MailRes> = accounts.length
    ? window.api.searchMail(currentAccount, folder, q).catch((err) => ({ mails: null, errors: [], failed: errMsg(err) }))
    : Promise.resolve({ mails: [], errors: [] });
  const events = ensureCalendars()
    .then(() => window.api.cal.search(q, visibleCalIds()))
    .catch(() => [] as CalEvent[]);
  const [local, cts, tks, evsQuick] = await Promise.all([
    accounts.length ? window.api.searchCachedMail(currentAccount, folder, q).catch(() => [] as MailSummary[]) : Promise.resolve([] as MailSummary[]),
    quickContacts(ql),
    quickTasks(ql),
    withTimeout(events, 800, null), // calendar server slow → appointments follow later
  ]);
  if (seq !== searchSeq) return; // user kept typing in the meantime
  searchResults = local;
  contactHits = cts;
  taskHits = tks;
  eventHits = evsQuick ?? [];
  setSearchPhase('server');
  renderList();
  if (!evsQuick) {
    events.then((evs) => {
      if (seq !== searchSeq) return;
      eventHits = evs;
      renderList();
    });
  }
  const mailRes = await server;
  if (seq !== searchSeq) return;
  if (mailRes.mails) {
    // server hits plus local ones the server limit cut off; server version wins
    const byKey = new Map(local.map((m) => [mailKey(m), m]));
    for (const m of mailRes.mails) byKey.set(mailKey(m), m);
    searchResults = [...byKey.values()].sort((a, b) => b.date.localeCompare(a.date));
  }
  setSearchPhase('idle');
  renderList();
  const errs = mailRes.errors.map((er) => `${accountOf(er.accountId)?.email ?? ''}: ${er.message}`);
  if (mailRes.failed) errs.unshift(mailRes.failed);
  const n = (searchResults?.length ?? 0) + eventHits.length + contactHits.length + taskHits.length;
  setStatus([t('search.done', { n }), ...errs].join(' · '));
}

const HIT_PREVIEW = 3; // under "All": this many appointments/contacts, the rest behind "show more"

// Contacts and appointments above the mail hits, clearly marked by kind
function searchHitsHtml(evs: CalEvent[], cts: Contact[], tks: Task[], nMails: number): string {
  const show = (k: typeof searchKind) => searchKind === 'all' || searchKind === k;
  const group = (kind: 'contact' | 'event' | 'task', n: number, rows: string[]) => {
    if (!n || !show(kind)) return '';
    const more = searchKind === 'all' && n > HIT_PREVIEW ? `<button type="button" class="hit-more" data-kind-go="${kind}">${esc(t('search.more', { n: n - HIT_PREVIEW }))}</button>` : '';
    return `<div class="hit-head"><span>${esc(t(`search.kind.${kind}`))}</span><span class="n">${n}</span></div>${rows.join('')}${more}`;
  };
  const limit = <T,>(list: T[]) => (searchKind === 'all' ? list.slice(0, HIT_PREVIEW) : list);
  const contactRows = limit(cts).map((c) => {
    const sub = [c.emails[0]?.value, c.org].filter(Boolean).join(' · ') || c.phones[0]?.value || '';
    return `<button type="button" class="hit hit-contact" data-hit-contact="${esc(c.id)}">
      ${c.photo ? `<span class="avatar m-av has-img"><img src="${esc(c.photo)}" alt=""></span>` : avatarHtml(c.emails[0]?.value ?? '', c.name, 'avatar m-av')}
      <span class="hit-body"><b>${esc(c.name)}</b><span>${esc(sub)}</span></span>
      <span class="hit-tag">${esc(t('search.tag.contact'))}</span>
    </button>`;
  });
  const eventRows = limit(evs).map((ev, i) => {
    const d = ev.allDay ? parseYmd(ev.start) : new Date(ev.start);
    const past = new Date(ev.end).getTime() < Date.now();
    const when = `${d.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} · ${ev.allDay ? t('agenda.allDay') : hm(d)}`;
    return `<button type="button" class="hit hit-event${past ? ' past' : ''}" data-hit-event="${i}" style="--ec:${calColor(ev.calendarId)}">
      <span class="hit-cal">${svgIco('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>', 16)}</span>
      <span class="hit-body"><b>${ev.recurring ? '↻ ' : ''}${esc(ev.title)}</b><span>${esc(when)}${ev.location ? ` · ${esc(ev.location)}` : ''}</span></span>
      <span class="hit-tag">${esc(t('search.tag.event'))}</span>
    </button>`;
  });
  const taskRows = limit(tks).map((task, i) => {
    const list = tlistOf(task.listId);
    const due = dueLabel(task);
    const sub = [due.text, list?.name].filter(Boolean).join(' · ');
    return `<button type="button" class="hit hit-task${task.done ? ' done' : ''}" data-hit-task="${i}" style="--ec:${list?.color ?? '#969993'}">
      <span class="hit-cal">${svgIco(task.done ? '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8 12 3 3 5-6"/>' : '<rect x="4" y="4" width="16" height="16" rx="4"/>', 16)}</span>
      <span class="hit-body"><b>${esc(task.title)}</b><span class="${due.cls}">${esc(sub)}</span></span>
      <span class="hit-tag">${esc(t('search.tag.task'))}</span>
    </button>`;
  });
  const html = group('contact', cts.length, contactRows) + group('event', evs.length, eventRows) + group('task', tks.length, taskRows);
  // Heading for the mails only when other kinds are listed above them
  return html && searchKind === 'all' && nMails ? `${html}<div class="hit-head"><span>${esc(t('search.kind.mail'))}</span><span class="n">${nMails}</span></div>` : html;
}

el('#search').addEventListener('input', () => {
  searchResults = null;
  searchSeq++;
  const pending = el<HTMLInputElement>('#search').value.trim().length >= 2;
  if (!pending) {
    eventHits = [];
    contactHits = [];
    taskHits = [];
  }
  setSearchPhase(pending ? 'typing' : 'idle');
  renderList();
  clearTimeout(searchTimer);
  if (pending) searchTimer = window.setTimeout(runSearch, 300);
  else setStatus('');
});
el('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(searchTimer);
    runSearch();
  } else if (e.key === 'Escape') {
    clearTimeout(searchTimer);
    resetSearch();
    renderList();
    setStatus('');
  }
});

function paintSegs(): void {
  document.querySelectorAll<HTMLElement>('#filter-seg [data-filter]').forEach((b) => b.classList.toggle('on', b.dataset.filter === listFilter));
  document.querySelectorAll<HTMLElement>('#scope-seg [data-scope]').forEach((b) => b.classList.toggle('on', b.dataset.scope === searchScope));
  document.querySelectorAll<HTMLElement>('#kind-seg [data-kind]').forEach((b) => b.classList.toggle('on', b.dataset.kind === searchKind));
}

function setSearchKind(kind: typeof searchKind): void {
  searchKind = kind;
  paintSegs();
  renderList();
  el('#mail-list').scrollTop = 0;
}

el('#kind-seg').addEventListener('click', (e) => {
  const k = (e.target as HTMLElement).closest<HTMLElement>('[data-kind]')?.dataset.kind as typeof searchKind | undefined;
  if (k && k !== searchKind) setSearchKind(k);
});

el('#filter-seg').addEventListener('click', (e) => {
  const f = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]')?.dataset.filter;
  if (!f) return;
  listFilter = f as typeof listFilter;
  paintSegs();
  renderList();
});

el('#scope-seg').addEventListener('click', (e) => {
  const sc = (e.target as HTMLElement).closest<HTMLElement>('[data-scope]')?.dataset.scope as 'folder' | 'all' | undefined;
  if (!sc || sc === searchScope) return;
  searchScope = sc;
  paintSegs();
  searchResults = null;
  renderList();
  runSearch();
});

// ---------- Read / unread ----------

async function markSeen(keys: string[], seen: boolean): Promise<void> {
  const groups = new Map<string, MailRef & { uids: number[] }>();
  for (const k of keys) {
    const p = parseKey(k);
    const g = groups.get(`${p.accountId}|${p.folder}`) ?? { ...p, uids: [] };
    g.uids.push(p.uid);
    groups.set(`${p.accountId}|${p.folder}`, g);
  }
  const set = new Set(keys);
  for (const m of [...mails, ...(searchResults ?? [])]) if (set.has(mailKey(m))) m.seen = seen;
  renderList();
  updateCounts();
  try {
    for (const g of groups.values()) await window.api.setSeen(g.accountId, g.folder, g.uids, seen);
    setStatus(t(seen ? 'mail.markedRead' : 'mail.markedUnread', { n: keys.length }));
  } catch (err) {
    setStatus(errMsg(err));
    loadMails();
  }
  for (const id of new Set([...groups.values()].map((g) => g.accountId))) if (folderCache.has(id)) loadFolders(id);
}

// ---------- Star (important) ----------

async function toggleFlag(keys: string[], force?: boolean): Promise<void> {
  const list = keys.map(summaryOf).filter(Boolean) as MailSummary[];
  const on = force ?? !list.every((m) => m.flagged);
  const groups = new Map<string, MailRef & { uids: number[] }>();
  for (const k of keys) {
    const p = parseKey(k);
    const g = groups.get(`${p.accountId}|${p.folder}`) ?? { ...p, uids: [] };
    g.uids.push(p.uid);
    groups.set(`${p.accountId}|${p.folder}`, g);
  }
  const set = new Set(keys);
  for (const m of [...mails, ...(searchResults ?? []), ...flaggedMails]) if (set.has(mailKey(m))) m.flagged = on;
  // update the "Important" collection right away
  if (on) for (const m of list) if (!flaggedMails.some((x) => mailKey(x) === mailKey(m))) flaggedMails.unshift({ ...m, flagged: true });
  else flaggedMails = flaggedMails.filter((m) => !set.has(mailKey(m)));
  if (flaggedView && !on) {
    await animateRowsOut(keys, 'move');
    mails = mails.filter((m) => !set.has(mailKey(m)));
    clearReader();
  }
  renderList();
  renderVirtualList();
  if (currentMsg && set.has(mailKey(currentMsg)) && !flaggedView) openMail(mailKey(currentMsg));
  try {
    for (const g of groups.values()) await window.api.setFlagged(g.accountId, g.folder, g.uids, on);
    setStatus(t(on ? 'mail.flagged' : 'mail.unflagged', { n: keys.length }));
  } catch (err) {
    setStatus(errMsg(err));
    loadFlagged();
  }
}

// ---------- Context menu (right-click on a mail) ----------

const ctx = document.createElement('div');
ctx.className = 'ctx-menu';
ctx.hidden = true;
ctx.setAttribute('role', 'menu');
document.body.appendChild(ctx);
let ctxKeys: string[] = [];

function hideCtx(): void {
  ctx.hidden = true;
}

el('#mail-list').addEventListener('contextmenu', (e) => {
  const key = (e.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key;
  if (!key) return;
  e.preventDefault();
  if (!selected.has(key)) {
    selected = new Set([key]);
    anchorKey = key;
    showSelection();
  }
  ctxKeys = [...selected];
  const one = ctxKeys.length === 1;
  const list = ctxKeys.map(summaryOf).filter(Boolean) as MailSummary[];
  const anyUnread = list.some((m) => !m.seen);
  const accIds = new Set(ctxKeys.map((k) => parseKey(k).accountId));
  const canArchive = [...accIds].every((id) => (folderCache.get(id) ?? []).some((f) => f.specialUse === '\\Archive'));
  const canSpam = [...accIds].every((id) => (folderCache.get(id) ?? []).some((f) => f.specialUse === '\\Junk'));
  const allJunk = ctxKeys.every((k) => { const p = parseKey(k); return folderInfo(p.accountId, p.folder)?.specialUse === '\\Junk'; });
  const allFlagged = list.length > 0 && list.every((m) => m.flagged);
  const item = (action: string, ico: string, label: string, cls = '') => `<button type="button" role="menuitem" class="${cls}" data-ctx="${action}">${ico}<span>${esc(label)}</span></button>`;
  ctx.innerHTML = [
    one ? item('window', ACT_ICONS.window, t('mail.openWindow')) : '',
    one ? item('reply', ACT_ICONS.reply, t('mail.reply')) : '',
    one ? item('replyAll', ACT_ICONS.replyAll, t('mail.replyAll')) : '',
    one ? item('forward', ACT_ICONS.forward, t('mail.forward')) : '',
    one ? '<hr>' : '',
    anyUnread ? item('seen', ACT_ICONS.read, t('mail.markRead')) : item('unseen', ACT_ICONS.unread, t('mail.markUnread')),
    item(allFlagged ? 'unflag' : 'flag', `<span class="ctx-star">${allFlagged ? '☆' : '★'}</span>`, t(allFlagged ? 'mail.unflag' : 'mail.flag')),
    '<hr>',
    canArchive ? item('archive', ACT_ICONS.archive, t('mail.archive')) : '',
    allJunk ? item('notspam', ACT_ICONS.notSpam, t('mail.notSpam')) : canSpam ? item('spam', ACT_ICONS.spam, t('mail.spam')) : '',
    item('delete', ACT_ICONS.trash, t('mail.delete'), 'danger'),
    one ? item('rule', svgIco('<path d="M4 6h10M4 12h7M4 18h4"/><path d="m15 15 3 3 4-6"/>'), t('rules.createFromMail')) : '',
    '<hr>',
    `<div class="ctx-head">${esc(t('labels.title').toUpperCase())}</div>`,
    ...labels.map((l) => {
      const on = list.length > 0 && list.every((m) => (mailLabels[labelKey(m)] ?? []).includes(l.id));
      return `<button type="button" role="menuitemcheckbox" aria-checked="${on}" data-ctx="label:${esc(l.id)}"><span class="lbl-dot" style="background:${l.color}">${on ? '✓' : ''}</span><span>${esc(l.name)}</span></button>`;
    }),
    item('label-new', svgIco('<path d="M12 5v14M5 12h14"/>'), t('labels.new')),
  ].join('');
  ctx.hidden = false;
  const r = ctx.getBoundingClientRect();
  ctx.style.left = `${Math.min(e.clientX, innerWidth - r.width - 6)}px`;
  ctx.style.top = `${Math.min(e.clientY, innerHeight - r.height - 6)}px`;
  ctx.querySelector<HTMLElement>('button')?.focus();
});

ctx.addEventListener('click', async (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>('[data-ctx]')?.dataset.ctx;
  if (!action) return;
  hideCtx();
  const keys = ctxKeys;
  if (action === 'seen' || action === 'unseen') return markSeen(keys, action === 'seen');
  if (action === 'flag' || action === 'unflag') return toggleFlag(keys, action === 'flag');
  if (action === 'rule') {
    const m = summaryOf(keys[0]);
    if (m) openRuleFromMail(m);
    return;
  }
  if (action === 'spam') return removeMails(keys, { move: '\\Junk' });
  if (action === 'notspam') return removeMails(keys, { move: 'INBOX' });
  if (action === 'archive' || action === 'delete') return removeMails(keys, action);
  if (action === 'window') return void window.api.mailview.open(parseKey(keys[0]));
  if (action.startsWith('label:')) return toggleLabel(keys, action.slice(6));
  if (action === 'label-new') return openLabelDialog(null, keys);
  // reply/forward need the body
  const { accountId, folder, uid } = parseKey(keys[0]);
  let msg = currentMsg && mailKey(currentMsg) === keys[0] ? currentMsg : null;
  if (!msg) {
    try {
      msg = { ...(await window.api.getMail(accountId, folder, uid)), folder };
    } catch (err) {
      return setStatus(errMsg(err));
    }
  }
  if (action === 'forward') openCompose(forwardOpts(msg));
  else openCompose(replyOpts(msg, action === 'replyAll'));
});

document.addEventListener('mousedown', (e) => {
  if (!ctx.hidden && !ctx.contains(e.target as Node)) hideCtx();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !ctx.hidden) hideCtx();
});
window.addEventListener('blur', hideCtx);
window.addEventListener('resize', hideCtx);
el('#mail-list').addEventListener('scroll', hideCtx);

// ---------- Title bar: refresh, new (mail / event / contact) ----------

async function refreshAll(): Promise<void> {
  const btn = el('#tb-refresh');
  if (btn.classList.contains('spin')) return;
  btn.classList.add('spin');
  try {
    const view = el('.app').dataset.view;
    if (view === 'cal') await loadCalendars();
    else if (view === 'contacts') await loadContacts();
    else if (view === 'tasks') await loadTasks();
    else {
      await loadAccounts();
      await Promise.all([
        loadMails(),
        loadFlagged(),
        ...accounts.filter((a) => a.id === currentAccount || folderCache.has(a.id)).map((a) => loadFolders(a.id)),
        ...(agenda.on && agenda.cal ? [loadAgendaEvents(true)] : []),
        ...(agenda.on && agenda.tasks ? [loadTasks()] : []),
      ]);
      if (el<HTMLInputElement>('#search').value.trim().length >= 2) await runSearch();
    }
  } finally {
    btn.classList.remove('spin');
  }
}

function setupTitlebarActions(): void {
  const box = el('#tb-actions');
  const b = (id: string, ico: string, label: string) => `<button type="button" class="tb-btn" id="${id}" aria-label="${esc(label)}" title="${esc(label)}">${ico}</button>`;
  box.innerHTML = [
    b('tb-refresh', ACT_ICONS.refresh, t('tb.refresh')),
    '<span class="tb-sep"></span>',
    b('tb-new-mail', ACT_ICONS.newMail, t('tb.newMail')),
    b('tb-new-event', ACT_ICONS.newEvent, t('tb.newEvent')),
    b('tb-new-contact', ACT_ICONS.newContact, t('tb.newContact')),
    b('tb-new-task', ACT_ICONS.newTask, t('tb.newTask')),
  ].join('');
  el('#tb-refresh').addEventListener('click', refreshAll);
  el('#tb-new-mail').addEventListener('click', () => openCompose());
  el('#tb-new-event').addEventListener('click', async () => {
    setView('cal');
    await ensureCalendars();
    openEventDialog(null);
  });
  el('#tb-new-task').addEventListener('click', async () => {
    setView('tasks');
    await ensureTasks();
    openTaskDialog(null);
  });
  el('#tb-new-contact').addEventListener('click', async () => {
    setView('contacts');
    await ensureContacts();
    openContactDialog(null);
  });
}
setupTitlebarActions();

document.addEventListener('keydown', (e) => {
  if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
    e.preventDefault();
    refreshAll();
  }
});

// ---------- Sound for new mail (default or per account, see Settings → Sounds) ----------

let notify: NotifySettings = { enabled: true, sound: 'app:newMail_Arcade.wav', volume: 0.7, perAccount: {} };
const soundCache = new Map<string, string | null>();
let audioCtx: AudioContext | null = null;

// Built-in sound: two soft chimes (Web Audio, no file needed)
function playChime(volume: number): void {
  audioCtx ??= new AudioContext();
  const ctx = audioCtx;
  const t0 = ctx.currentTime + 0.02;
  [
    [880, 0],
    [1318.5, 0.13],
  ].forEach(([freq, delay]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0 + delay);
    gain.gain.linearRampToValueAtTime(0.25 * volume, t0 + delay + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.9);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + delay);
    osc.stop(t0 + delay + 1);
  });
}

// Built-in "ding" for sent mail (if sentMail_Ding.wav is missing)
function playDing(volume: number): void {
  audioCtx ??= new AudioContext();
  const ctx = audioCtx;
  const t0 = ctx.currentTime + 0.01;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(1568, t0);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.22 * volume, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.65);
}

async function playSound(id: string, volume = notify.volume, fallback: (v: number) => void = playChime): Promise<void> {
  if (!id || id === 'none') return;
  if (id === 'builtin') return fallback(volume);
  let data = soundCache.get(id);
  if (data === undefined) {
    data = await window.api.sounds.data(id).catch(() => null);
    soundCache.set(id, data);
  }
  if (!data) return fallback(volume); // file missing → built-in sound
  const audio = new Audio(data);
  audio.volume = volume;
  audio.play().catch(() => {});
}

let lastSoundAt = 0;
function newMailSound(accountId: string): void {
  if (!notify.enabled || Date.now() - lastSoundAt < 2500) return; // several mails at once = one sound
  lastSoundAt = Date.now();
  playSound(notify.perAccount[accountId] || notify.sound);
}

window.api.settings
  .get()
  .then((s) => {
    if (s.notify) notify = s.notify;
    labels = s.labels ?? [];
    readDelay = s.readDelay ?? 3;
    mailLabels = s.mailLabels ?? {};
    renderList();
  })
  .catch(() => {});

// Mail sent → "ding" (Settings → Notifications → Sound when sending)
window.api.onMailSent(() => playSound(notify.sentSound ?? 'app:sentMail_Ding.wav', notify.volume, playDing));

// Click on a desktop notification: show the account's inbox and open the mail
window.api.onOpenMail(async (ref) => {
  setView('mail');
  currentAccount = ref.accountId;
  currentFolder = ref.folder;
  resetSearch();
  listFilter = 'all';
  paintSegs();
  renderAccounts();
  loadFolders(ref.accountId);
  await loadMails();
  openMail(mailKey(ref));
});

let newMailTimer: number | undefined;
window.api.onNewMail((accountId, grew) => {
  if (grew) newMailSound(accountId);
  clearTimeout(newMailTimer);
  newMailTimer = window.setTimeout(() => {
    if (currentFolder === 'INBOX' || !currentAccount) loadMails();
    if (folderCache.has(accountId)) loadFolders(accountId);
  }, 800);
});

// ---------- Private accounts: unlock with PIN, lock (manually or automatically) ----------


function renderPrivacy(): void {
  el('#privacy-row').innerHTML =
    (privacy.locked ? `<button class="box priv-btn" data-privacy="unlock"><span class="vico">${svgIco(LOCK_ICO, 14)}</span><span class="name">${esc(t('privacy.unlockBtn'))}</span></button>` : '') +
    (privacy.unlocked ? `<button class="box priv-btn open" data-privacy="lock"><span class="vico">${svgIco(UNLOCK_ICO, 14)}</span><span class="name">${esc(t('privacy.lockBtn'))}</span></button>` : '');
}

const pinDlg = el<HTMLDialogElement>('#dlg-pin');
const pinForm = el<HTMLFormElement>('#form-pin');
const pinField = () => pinForm.elements.namedItem('pin') as HTMLInputElement;

function openPinDialog(): void {
  pinForm.reset();
  el('#pin-error').textContent = '';
  pinDlg.showModal();
  pinField().focus();
}

el('#privacy-row').addEventListener('click', async (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-privacy]')?.dataset.privacy;
  if (act === 'unlock') openPinDialog();
  if (act === 'lock') {
    await window.api.privacy.lock();
    setStatus(t('privacy.locked'));
  }
});
el('#btn-pin-cancel').addEventListener('click', () => pinDlg.close());
pinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const n = await window.api.privacy.unlock(pinField().value.trim());
    pinDlg.close();
    setStatus(t('privacy.unlocked', { n }));
  } catch (err) {
    el('#pin-error').textContent = errMsg(err);
    pinField().select();
  }
});

// Locked or unlocked (also by the auto-lock): drop everything of the accounts that are gone
window.api.privacy.onChanged(async (state) => {
  privacy = state;
  await loadAccounts();
  const gone = (m: { accountId: string }) => !accountOf(m.accountId);
  if (currentAccount && !accountOf(currentAccount)) {
    currentAccount = null;
    currentFolder = 'INBOX';
  }
  for (const id of [...folderCache.keys()]) if (!accountOf(id)) folderCache.delete(id);
  mails = mails.filter((m) => !gone(m));
  flaggedMails = flaggedMails.filter((m) => !gone(m));
  if (searchResults) searchResults = searchResults.filter((m) => !gone(m));
  selected = new Set([...selected].filter((k) => accountOf(parseKey(k).accountId)));
  if (currentMsg && gone(currentMsg)) clearReader();
  renderAccounts();
  renderList();
  await loadMails();
  if (el<HTMLInputElement>('#search').value.trim().length >= 2) runSearch();
});

// Any use of the app postpones the auto-lock (sent at most every 15 s)
let lastActivityPing = 0;
const activityPing = () => {
  if (!privacy.unlocked || Date.now() - lastActivityPing < 15_000) return;
  lastActivityPing = Date.now();
  window.api.privacy.activity().catch(() => {});
};
for (const ev of ['pointerdown', 'keydown', 'wheel', 'mousemove']) document.addEventListener(ev, activityPing, { capture: true, passive: true });

// ---------- Views (mail / calendar / contacts) ----------

type View = 'mail' | 'cal' | 'contacts' | 'tasks';

function setView(view: View): void {
  el('.app').dataset.view = view;
  applyCols();
  document.querySelectorAll<HTMLElement>('.view-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.dispatchEvent(new CustomEvent<View>('viewchange', { detail: view }));
}

document.querySelectorAll<HTMLElement>('.view-btn[data-view]').forEach((b) => {
  b.addEventListener('click', () => setView(b.dataset.view as View));
});

// ---------- Column widths (drag the dividers, double-click = default; saved) ----------

const COLS = { side: { def: 228, min: 180, max: 380 }, list: { def: 340, min: 280, max: 640 } } as const;
type ColName = keyof typeof COLS;
const READER_MIN = 380;
const AGENDA_W = 300; // right sidebar (calendar/tasks), see agenda.ts
const colWidth: Record<ColName, number> = { side: COLS.side.def, list: COLS.list.def };

function applyCols(save = false): void {
  const app = el('.app');
  colWidth.side = Math.min(COLS.side.max, Math.max(COLS.side.min, colWidth.side));
  const agendaW = document.body.classList.contains('agenda-on') && app.dataset.view === 'mail' ? AGENDA_W : 0;
  const listMax = Math.max(COLS.list.min, Math.min(COLS.list.max, innerWidth - colWidth.side - READER_MIN - agendaW));
  colWidth.list = Math.min(listMax, Math.max(COLS.list.min, colWidth.list));
  app.style.setProperty('--side-w', `${colWidth.side}px`);
  app.style.setProperty('--list-w', `${colWidth.list}px`);
  if (save) {
    try {
      localStorage.setItem('ciegolink.cols', JSON.stringify(colWidth));
    } catch {
      /* not critical */
    }
  }
}

try {
  const saved = JSON.parse(localStorage.getItem('ciegolink.cols') || '{}');
  if (Number(saved.side)) colWidth.side = Number(saved.side);
  if (Number(saved.list)) colWidth.list = Number(saved.list);
} catch {
  /* default */
}
applyCols();
window.addEventListener('resize', () => applyCols());

document.querySelectorAll<HTMLElement>('.col-resizer').forEach((h) => {
  const col = h.dataset.col as ColName;
  h.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = colWidth[col];
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      colWidth[col] = startW + ev.clientX - startX;
      applyCols();
    };
    const up = () => {
      h.removeEventListener('pointermove', move);
      document.body.classList.remove('resizing');
      applyCols(true);
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up, { once: true });
    h.addEventListener('pointercancel', up, { once: true });
  });
  h.addEventListener('dblclick', () => {
    colWidth[col] = COLS[col].def;
    applyCols(true);
  });
});

// ---------- Startup ----------

(async () => {
  setView('mail');
  paintSegs();
  await loadAccounts();
  await loadMails();
  loadFlagged();
})();

// Compose popup open → darken the main window; a click brings the popup back to the front
window.api.compose.onDim((on) => (el('#popup-dim').hidden = !on));
el('#popup-dim').addEventListener('mousedown', (e) => {
  e.preventDefault();
  window.api.compose.focusPopup();
});
