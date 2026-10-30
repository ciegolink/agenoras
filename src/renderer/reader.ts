// Mail display, shared by the reading pane (main window) and the separate mail window (mailview.html):
// icons, sender pictures, header, body with image banner, attachments, reply/forward.

const svgIco = (paths: string, size = 15, sw = 2) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ACT_ICONS = {
  reply: svgIco('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  replyAll: svgIco('<path d="M8 14 3 9l5-5"/><path d="M13 14 8 9l5-5"/><path d="M8 9h7.5a5.5 5.5 0 0 1 0 11H13"/>'),
  copy: svgIco('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  translate: svgIco('<path d="M4 5h8M8 3v2M5.5 5c.7 2.8 2.7 5 5.5 6.2M10.5 5c-.8 3.4-3 6-6.5 7.5"/><path d="m12 21 4.5-10 4.5 10M13.6 17.5h5.8"/>'),
  forward: svgIco('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  window: svgIco('<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18"/>'),
  read: svgIco('<path d="M3 8l9 6 9-6"/><rect x="3" y="5" width="18" height="14" rx="2"/>'),
  unread: svgIco('<path d="M3 8l9 6 9-6"/><path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h9"/><circle cx="19" cy="18" r="3" fill="currentColor"/>'),
  image: svgIco('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5L5 20"/>'),
  spam: svgIco('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z"/><path d="m9 9 6 6M15 9l-6 6"/>'),
  notSpam: svgIco('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>'),
  archive: svgIco('<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/>'),
  trash: svgIco('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>'),
  refresh: svgIco('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>', 16),
  newMail: svgIco('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>', 16),
  newEvent: svgIco('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M12 13v5M9.5 15.5h5"/>', 16),
  newTask: svgIco('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>', 16),
  newContact: svgIco('<circle cx="10" cy="8" r="4"/><path d="M3 20a7 7 0 0 1 12.5-4.3"/><path d="M19 14v6M16 17h6"/>', 16),
};

// ---------- Sender picture: contact photo → website icon → initials ----------

const avatarCache = new Map<string, string | null>();
const avatarQueue = new Set<string>();
let avatarTimer: number | undefined;

// Contact photos come with a "photo:" prefix (round, filling), website icons without (fitted)
const avatarSrc = (v: string) => (v.startsWith('photo:') ? v.slice(6) : v);
const avatarCls = (v: string | null | undefined) => (v ? ' has-img' + (v.startsWith('photo:') ? ' photo' : '') : '');

function avatarHtml(email: string, name: string, cls = 'avatar'): string {
  const key = (email || '').toLowerCase();
  const img = avatarCache.get(key);
  if (key && img === undefined) queueAvatar(key);
  const inner = img ? `<img src="${esc(avatarSrc(img))}" alt="">` : esc(initials(name || email || '?'));
  return `<span class="${cls}${avatarCls(img)}" data-avatar="${esc(key)}" data-name="${esc(name || email || '?')}">${inner}</span>`;
}

// After a contact photo changes: reload (existing displays are replaced directly)
function refreshAvatars(emails: string[]): void {
  for (const e of emails) {
    const key = e.toLowerCase();
    avatarCache.delete(key);
    document.querySelectorAll<HTMLElement>(`[data-avatar="${CSS.escape(key)}"]`).forEach((n) => {
      if (!n.classList.contains('has-img')) return;
      n.classList.remove('has-img', 'photo');
      n.textContent = initials(n.dataset.name || key);
    });
    queueAvatar(key);
  }
}

function queueAvatar(email: string): void {
  avatarQueue.add(email);
  clearTimeout(avatarTimer);
  avatarTimer = window.setTimeout(flushAvatars, 60);
}

async function flushAvatars(): Promise<void> {
  const list = [...avatarQueue].filter((e) => !avatarCache.has(e));
  avatarQueue.clear();
  if (!list.length) return;
  for (const e of list) avatarCache.set(e, null); // do not request twice
  try {
    const res = await window.api.avatars(list);
    for (const [email, data] of Object.entries(res)) {
      avatarCache.set(email, data);
      if (!data) continue;
      document.querySelectorAll<HTMLElement>(`[data-avatar="${CSS.escape(email)}"]`).forEach((n) => {
        n.innerHTML = `<img src="${esc(avatarSrc(data))}" alt="">`;
        n.classList.add('has-img');
        n.classList.toggle('photo', data.startsWith('photo:'));
      });
    }
  } catch {
    /* offline: initials stay */
  }
}

// ---------- Body ----------

function wrapHtml(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<style>body{margin:18px;font-family:Manrope,system-ui,sans-serif;font-size:14px;line-height:1.5;color:#1F2126;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>
</head><body>${html}</body></html>`;
}

function priorityBadge(p?: Priority): string {
  if (p === 'high') return `<span class="prio-badge high">${esc(t('prio.highBadge'))}</span>`;
  if (p === 'low') return `<span class="prio-badge low">${esc(t('prio.lowBadge'))}</span>`;
  return '';
}

function attachmentsHtml(msg: MailDetail): string {
  if (!msg.attachments.length) return '';
  return `<div class="tiles">${msg.attachments
    .map(
      (a, i) => `<div class="tile">
        <button class="tile-main" data-att-open="${i}" title="${esc(t('att.openTip', { name: a.filename, size: fmtSize(a.size) }))}">
          ${fileIcon(a.filename)}<span class="tname">${esc(a.filename)}</span><span class="tsize">${fmtSize(a.size)}</span>
        </button>
        <button class="tile-act" data-att-save="${i}" aria-label="${esc(t('att.saveAria', { name: a.filename }))}" title="${esc(t('att.save'))}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12"></path><path d="m7 11 5 5 5-5"></path><path d="M5 20h14"></path></svg>
        </button>
      </div>`,
    )
    .join('')}</div>`;
}

// Header: account · folder, subject, sender with picture
function metaHtml(msg: MailDetail, accLine: string, accColor: string, extra = ''): string {
  return `<div class="meta">
      <div class="acc" style="color:${accColor}">${esc(accLine)}${extra ? ` <span class="lbls">${extra}</span>` : ''}</div>
      <h2>${esc(msg.subject || t('mail.noSubject'))} ${priorityBadge(msg.priority)}</h2>
      <div class="who-row">
        ${avatarHtml(msg.fromAddress, msg.fromName)}
        <span class="who"><b><button type="button" class="person-link" data-person="${esc(msg.fromAddress)}" data-pname="${esc(msg.fromName)}">${esc(msg.fromName || msg.fromAddress)}</button></b><span>${esc(msg.fromAddress)}</span></span>
        <span class="when">${fmtLong(msg.date)}</span>
      </div>
      ${recipientsHtml(msg)}
    </div>`;
}

// ---------- Recipients: clickable, each with its own menu (e.g. write to everyone in Cc individually) ----------

let readerOwn = new Set<string>(); // own addresses (accounts + aliases) – do not suggest as recipients
// Mark external senders (Settings → Appearance); only active when switched on
// Show mailboxes by name or address (Settings → Appearance)
let accLabelMode: 'name' | 'email' = 'email';
const accLabel = (a?: { name: string; email: string } | null) => (!a ? '' : accLabelMode === 'name' && a.name ? a.name : a.email);
let extMarkOn = false;
let extDomains = new Set<string>(); // own domains + additionally entered ones
const FREEMAIL = /^(gmail|googlemail|gmx|web|bluewin|outlook|hotmail|live|msn|yahoo|icloud|me|mac|sunrise|hispeed|proton|protonmail|pm|aol|t-online|freenet|yandex|mail|zoho)\./i;
function setExternalPrefs(on: boolean, extra: string[]): void {
  extMarkOn = on;
  const own = [...readerOwn].map((a) => a.split('@')[1] ?? '').filter((d) => d && !FREEMAIL.test(d)); // never treat Gmail & co. as a whole internal domain
  extDomains = new Set([...own, ...extra.map((d) => d.toLowerCase())]);
}
function isExternal(addr: string): boolean {
  if (!extMarkOn || !addr) return false;
  const a = addr.toLowerCase();
  if (readerOwn.has(a)) return false;
  const dom = a.split('@')[1] ?? '';
  return ![...extDomains].some((d) => dom === d || dom.endsWith('.' + d));
}
Promise.all([window.api.listAccounts(), window.api.settings.get()])
  .then(([accs, s]) => {
    readerOwn = new Set([...accs.map((a) => a.email), ...s.identities.map((i) => i.email)].map((x) => x.toLowerCase()));
    accLabelMode = s.accountLabel === 'name' ? 'name' : 'email';
    setExternalPrefs(!!s.externalMark, s.internalDomains ?? []);
    document.dispatchEvent(new Event('externalprefs'));
  })
  .catch(() => {});

// Names from the header "Name <address>, …"
function namesFrom(header: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of header.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const x = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(part);
    if (x) m.set(x[2].toLowerCase(), x[1].trim());
  }
  return m;
}

function recipientsHtml(msg: MailDetail): string {
  const names = namesFrom(msg.to);
  const chip = (a: string) => `<button type="button" class="person-chip" data-person="${esc(a)}" data-pname="${esc(names.get(a.toLowerCase()) ?? '')}">${esc(names.get(a.toLowerCase()) || a)}</button>`;
  const others = [...new Set([msg.fromAddress, ...msg.toList, ...msg.ccList].filter(Boolean))];
  return `<div class="who-to">
      <span class="wt-label">${esc(t('compose.to'))}</span>${msg.toList.map(chip).join('') || '–'}
      ${msg.ccList.length ? `<span class="wt-label">CC</span>${msg.ccList.map(chip).join('')}` : ''}
      ${others.length > 1 ? `<button type="button" class="link wt-pick" data-action="pick-people">${esc(t('people.pick', { n: others.length }))}</button>` : ''}
    </div>
    <div class="people-pick" id="people-pick" hidden>
      ${others
        .map((a) => {
          const own = readerOwn.has(a.toLowerCase());
          const role = a === msg.fromAddress ? t('people.sender') : msg.ccList.includes(a) ? 'Cc' : t('compose.to');
          const name = names.get(a.toLowerCase()) ?? (a === msg.fromAddress ? msg.fromName : '');
          // Each person clickable on their own → menu (write, contact, copy address/name)
          return `<button type="button" class="pp-row${own ? ' own' : ''}" data-person="${esc(a)}" data-pname="${esc(name)}" data-own="${own ? 1 : ''}">
            ${avatarHtml(a, name || a)}<span class="pp-who"><b>${esc(name || a)}</b><small>${esc(a)}</small></span><span class="pp-role">${esc(role)}${own ? ` · ${esc(t('people.you'))}` : ''}</span><span class="pp-chev">›</span></button>`;
        })
        .join('')}
      <div class="pp-actions">
        <button type="button" class="btn ghost sm" data-pp="mail">${esc(t('people.mailAll'))}</button>
        <button type="button" class="btn primary sm" data-pp="each">${esc(t('people.mailEach'))}</button>
      </div>
    </div>`;
}

// Click on a person: small menu (write, add contact, copy address)
const personPop = document.createElement('div');
personPop.className = 'ctx-menu person-pop';
personPop.hidden = true;
document.body.appendChild(personPop);

const COPY_ICO = svgIco('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>');

// Set by the window: create a new contact (not available in the mail window)
let readerCreateContact: ((name: string, email: string) => void) | null = null;

async function showPersonPop(anchor: HTMLElement): Promise<void> {
  const email = anchor.dataset.person!;
  const name = anchor.dataset.pname || '';
  let known = false;
  try {
    known = (await window.api.contacts.cached()).contacts.some((c) => c.emails.some((e) => e.value.toLowerCase() === email.toLowerCase()));
  } catch {
    /* without an address book */
  }
  personPop.innerHTML = `
    <div class="pp-head">${avatarHtml(email, name || email)}<span><b>${esc(name || email)}</b><small>${esc(email)}</small></span></div>
    <button type="button" data-pop="mail">${ACT_ICONS.newMail}<span>${esc(t('people.write'))}</span></button>
    ${readerCreateContact && !known ? `<button type="button" data-pop="contact">${ACT_ICONS.newContact}<span>${esc(t('people.addContact'))}</span></button>` : ''}
    ${known ? `<div class="pp-known">✓ ${esc(t('people.inBook'))}</div>` : ''}
    <hr>
    <button type="button" data-pop="copy">${COPY_ICO}<span>${esc(t('people.copy'))}</span></button>
    ${name && name !== email ? `<button type="button" data-pop="copyName">${COPY_ICO}<span>${esc(t('people.copyName'))}</span></button>` : ''}
    <button type="button" data-pop="copyFull">${COPY_ICO}<span>${esc(t('people.copyFull'))}</span></button>`;
  personPop.dataset.email = email;
  personPop.dataset.name = name;
  personPop.hidden = false;
  const r = anchor.getBoundingClientRect();
  personPop.style.top = `${Math.min(r.bottom + 4, innerHeight - personPop.offsetHeight - 8)}px`;
  personPop.style.left = `${Math.min(r.left, innerWidth - personPop.offsetWidth - 8)}px`;
}

personPop.addEventListener('click', async (e) => {
  const what = (e.target as HTMLElement).closest<HTMLElement>('[data-pop]')?.dataset.pop;
  if (!what) return;
  const email = personPop.dataset.email!;
  const name = personPop.dataset.name || '';
  personPop.hidden = true;
  if (what === 'mail') window.api.compose.open({ to: [name ? `${name} <${email}>` : email] });
  else if (what === 'contact') readerCreateContact?.(name, email);
  else if (what === 'copy') await navigator.clipboard.writeText(email).catch(() => {});
  else if (what === 'copyName') await navigator.clipboard.writeText(name).catch(() => {});
  else if (what === 'copyFull') await navigator.clipboard.writeText(name ? `${name} <${email}>` : email).catch(() => {});
});

document.addEventListener('mousedown', (e) => {
  if (!personPop.hidden && !personPop.contains(e.target as Node)) personPop.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') personPop.hidden = true;
});

document.addEventListener('click', (e) => {
  const tgt = e.target as HTMLElement;
  const person = tgt.closest<HTMLElement>('.meta [data-person]');
  if (person) return void showPersonPop(person);
  if (tgt.closest('[data-action="pick-people"]')) {
    const p = document.querySelector<HTMLElement>('#people-pick');
    if (p) p.hidden = !p.hidden;
    return;
  }
  const pp = tgt.closest<HTMLElement>('[data-pp]')?.dataset.pp;
  if (pp) {
    // to all participants except myself
    const picked = [...document.querySelectorAll<HTMLElement>('#people-pick .pp-row:not(.own)')].map((b) => (b.dataset.pname ? `${b.dataset.pname} <${b.dataset.person}>` : b.dataset.person!));
    if (!picked.length) return;
    window.api.compose.open({ to: picked, sendMode: pp === 'each' ? 'each' : 'all' });
  }
});

// Insert the body. External images are blocked → banner with "Load images" / "Always load from …".
function mountMailBody(box: HTMLElement, msg: MailDetail, reload: () => void): void {
  bodyMsg = msg;
  // another mail: menu and translation of the previous one go away; own addresses may have changed
  trMenu.hidden = true;
  trPop.hidden = true;
  loadOwnAddrs();
  box.innerHTML = '';
  if (isExternal(msg.fromAddress)) {
    const ext = document.createElement('div');
    ext.className = 'ext-banner';
    ext.innerHTML = `<span class="ext-tag">${esc(t('ext.tag'))}</span><span>${esc(t('ext.banner'))}</span>`;
    box.appendChild(ext);
  }
  if (msg.remoteImages && !msg.imagesLoaded) {
    const bar = document.createElement('div');
    bar.className = 'img-banner';
    bar.innerHTML = `${ACT_ICONS.image}<span>${esc(t('img.blocked'))}</span>
      <button type="button" class="btn ghost sm" data-img="load">${esc(t('img.load'))}</button>
      <button type="button" class="link" data-img="trust">${esc(t('img.always', { email: msg.fromAddress }))}</button>`;
    bar.addEventListener('click', async (e) => {
      const what = (e.target as HTMLElement).closest<HTMLElement>('[data-img]')?.dataset.img;
      if (!what) return;
      bar.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
      if (what === 'trust') await window.api.settings.trustSender(msg.fromAddress).catch(() => {});
      reload();
    });
    box.appendChild(bar);
  }
  if (msg.html) {
    // Sandbox without scripts; the CSP only allows data: images (the main process fetches external ones on request)
    const frame = document.createElement('iframe');
    frame.className = 'mail-frame';
    frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.srcdoc = wrapHtml(msg.html);
    frame.onload = () => {
      const fit = () => (frame.style.height = (frame.contentDocument?.documentElement.scrollHeight ?? 600) + 'px');
      fit();
      frame.contentDocument?.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit));
      hookTranslate(frame);
    };
    box.appendChild(frame);
  } else {
    const div = document.createElement('div');
    div.className = 'text-body';
    div.textContent = msg.text;
    box.appendChild(div);
  }
}

async function attachmentAction(msg: MailDetail, target: HTMLElement, status: (s: string) => void): Promise<boolean> {
  const openI = target.closest<HTMLElement>('[data-att-open]')?.dataset.attOpen;
  const saveI = target.closest<HTMLElement>('[data-att-save]')?.dataset.attSave;
  if (openI === undefined && saveI === undefined) return false;
  try {
    if (openI !== undefined) {
      status(t('att.opening'));
      await window.api.openAttachment(msg.accountId, msg.folder, msg.uid, Number(openI));
      status('');
    } else {
      const saved = await window.api.saveAttachment(msg.accountId, msg.folder, msg.uid, Number(saveI));
      if (saved) status(t('att.saved', { path: saved }));
    }
  } catch (err) {
    status(errMsg(err));
  }
  return true;
}

// ---------- Reply / forward ----------

function plainText(msg: MailDetail): string {
  if (msg.text.trim()) return msg.text;
  if (!msg.html) return '';
  return new DOMParser().parseFromString(msg.html, 'text/html').body.textContent ?? '';
}

function withPrefix(prefix: 'Re' | 'Fwd', subject: string): string {
  const already = prefix === 'Re' ? /^(re|aw|antw):/i : /^(fwd?|wg):/i;
  return already.test(subject.trim()) ? subject : `${prefix}: ${subject}`;
}

// Always quote the original as text – foreign HTML never goes into the editor
function quoteHtml(msg: MailDetail): string {
  return `<p>${esc(t('quote.header', { date: fmtLong(msg.date), name: msg.fromName, email: msg.fromAddress }))}</p><blockquote style="margin: 0 0 0 4px; padding-left: 10px; border-left: 2px solid #C1C8BE; color: #555">${textToHtml(plainText(msg))}</blockquote>`;
}

function replyOpts(msg: MailDetail, all: boolean): ComposeOpts {
  const to = msg.replyTo || msg.fromAddress;
  // The compose window filters out own addresses (it knows all aliases)
  const cc = all ? [...new Set([...msg.toList, ...msg.ccList])].filter((a) => a.toLowerCase() !== to.toLowerCase()) : [];
  return {
    accountId: msg.accountId,
    matchAddresses: [...msg.toList, ...msg.ccList],
    to: [to],
    cc,
    subject: withPrefix('Re', msg.subject),
    quoteHtml: quoteHtml(msg),
    inReplyTo: msg.messageId,
    references: [...msg.references, msg.messageId].filter(Boolean),
    mode: all ? 'replyAll' : 'reply',
  };
}

function forwardOpts(msg: MailDetail): ComposeOpts {
  const header = [
    t('fwd.header'),
    `${t('fwd.from')}: ${msg.fromName} <${msg.fromAddress}>`,
    `${t('fwd.date')}: ${fmtLong(msg.date)}`,
    `${t('fwd.subject')}: ${msg.subject}`,
    `${t('fwd.to')}: ${msg.to}`,
  ]
    .map(esc)
    .join('<br>');
  return {
    accountId: msg.accountId,
    matchAddresses: [...msg.toList, ...msg.ccList],
    subject: withPrefix('Fwd', msg.subject),
    quoteHtml: `<p>${header}</p>${textToHtml(plainText(msg))}`,
    mode: 'forward',
    forward: { accountId: msg.accountId, folder: msg.folder, uid: msg.uid, attachments: msg.attachments.map((a) => ({ filename: a.filename, size: a.size })) },
  };
}

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉'];

const replyButtonsHtml = () => `
  <button class="btn primary with-ico" data-action="reply">${ACT_ICONS.reply}${esc(t('mail.reply'))}</button>
  <button class="btn ghost with-ico" data-action="replyAll">${ACT_ICONS.replyAll}${esc(t('mail.replyAll'))}</button>
  <button class="btn ghost with-ico" data-action="forward">${ACT_ICONS.forward}${esc(t('mail.forward'))}</button>
  <span class="react-wrap">
    <button type="button" class="btn ghost react-btn" data-react-menu title="${esc(t('react.tip'))}" aria-label="${esc(t('react.tip'))}" aria-haspopup="true">😊</button>
    <span class="react-pop" role="menu" hidden>${REACTIONS.map((r) => `<button type="button" role="menuitem" data-react="${r}">${r}</button>`).join('')}</span>
  </span>`;

// Reaction: emoji menu open/close, one click sends it right away as a short reply mail
async function reactionAction(msg: MailDetail, target: HTMLElement, status: (s: string) => void): Promise<boolean> {
  const pop = target.closest('.react-wrap')?.querySelector<HTMLElement>('.react-pop');
  if (target.closest('[data-react-menu]') && pop) {
    pop.hidden = !pop.hidden;
    return true;
  }
  const emoji = target.closest<HTMLElement>('[data-react]')?.dataset.react;
  if (!emoji || !pop) return false;
  pop.hidden = true;
  // keep the bar closed while the mouse is still over it (otherwise hover would reopen it at once)
  const wrap = target.closest<HTMLElement>('.react-wrap')!;
  wrap.classList.add('no-hover');
  wrap.addEventListener('mouseleave', () => wrap.classList.remove('no-hover'), { once: true });
  const btn = target.closest('.react-wrap')!.querySelector<HTMLButtonElement>('[data-react-menu]')!;
  btn.disabled = true;
  await sendReaction(msg, emoji, status);
  btn.disabled = false;
  return true;
}

// Also used by the right-click menu in the mail body; the 😊 button shows what was sent
// Like sending a mail: the ring counts down the undo delay (Settings → Sending), then a check mark
// and the "sent" sound.
async function sendReaction(msg: MailDetail, emoji: string, status: (s: string) => void): Promise<void> {
  const delay = await window.api.settings
    .get()
    .then((s) => Math.min(5, Math.max(0, s.sendDelay ?? 2)) * 1000)
    .catch(() => 2000);
  if (!(await reactCountdown(emoji, delay))) return void status(t('react.cancelled'));
  status(t('react.sending'));
  try {
    const to = await window.api.react(msg.accountId, msg.folder, msg.uid, emoji);
    document.querySelectorAll<HTMLElement>('[data-react-menu]').forEach((b) => (b.textContent = emoji));
    window.api.compose.sent().catch(() => {}); // the "ding" comes from the main window
    status(t('react.sent', { emoji, to }));
    reactToastState('sent', t('compose.sentShort'));
    setTimeout(() => (reactToast.hidden = true), 900);
  } catch (err) {
    reactToast.hidden = true;
    status(errMsg(err));
  }
}

const reactToast = document.createElement('div');
reactToast.className = 'send-undo react-undo';
reactToast.hidden = true;
reactToast.setAttribute('role', 'status');
reactToast.innerHTML = `
  <svg class="ring" width="34" height="34" viewBox="0 0 36 36" aria-hidden="true">
    <circle cx="18" cy="18" r="15" class="ring-bg"/><circle cx="18" cy="18" r="15" class="ring-fg"/>
    <path class="ring-check" d="m11.5 18.5 4.5 4.5 8.5-9"/>
  </svg>
  <span class="su-text"></span>
  <button type="button" class="btn ghost sm su-undo"></button>`;
document.body.appendChild(reactToast);
let cancelReact: (() => void) | null = null; // a reaction still waiting – a new one replaces it

function reactToastState(state: 'counting' | 'sending' | 'sent', text: string): void {
  reactToast.className = `send-undo react-undo ${state}`;
  reactToast.hidden = false;
  reactToast.querySelector('.su-text')!.textContent = text;
  reactToast.querySelector<HTMLButtonElement>('.su-undo')!.hidden = state !== 'counting';
}

// true = send, false = undone (button, Esc or Ctrl+Z)
function reactCountdown(emoji: string, ms: number): Promise<boolean> {
  cancelReact?.();
  if (ms <= 0) {
    reactToastState('sending', t('react.pending', { emoji }));
    return Promise.resolve(true);
  }
  reactToast.querySelector<SVGElement>('.ring-fg')!.style.animationDuration = `${ms}ms`;
  const undo = reactToast.querySelector<HTMLButtonElement>('.su-undo')!;
  undo.textContent = t('compose.undo');
  reactToastState('counting', t('react.pending', { emoji }));
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      cancelReact = null;
      clearTimeout(timer);
      undo.removeEventListener('click', onUndo);
      document.removeEventListener('keydown', onKey, true);
      if (ok) reactToastState('sending', t('react.pending', { emoji }));
      else reactToast.hidden = true;
      resolve(ok);
    };
    const onUndo = () => finish(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z')) {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    };
    undo.addEventListener('click', onUndo);
    document.addEventListener('keydown', onKey, true);
    cancelReact = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
  });
}

document.addEventListener('mousedown', (e) => {
  if (!(e.target as HTMLElement).closest('.react-wrap')) document.querySelectorAll<HTMLElement>('.react-pop').forEach((p) => (p.hidden = true));
});

// ---------- Meeting invitations in mails (accept / maybe / decline) ----------

let inviteMsg: MailDetail | null = null;

function inviteWhen(inv: InviteInfo): string {
  if (inv.allDay) return new Date(`${inv.start}T12:00`).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const s = new Date(inv.start);
  const e = new Date(inv.end);
  return `${s.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${s.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}–${e.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}`;
}

function inviteCardHtml(msg: MailDetail): string {
  const inv = msg.invite;
  inviteMsg = inv ? msg : null;
  if (!inv) return '';
  const head = (label: string, cls = '') => `<div class="inv-top ${cls}">${svgIco('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>', 16)}<span>${esc(label)}</span></div>`;
  const facts = `<div class="inv-title">${inv.recurring ? '↻ ' : ''}${esc(inv.summary || t('cal.untitled'))}</div>
    <div class="inv-when">${esc(inviteWhen(inv))}</div>
    ${inv.location ? `<div class="inv-loc">${esc(inv.location)}</div>` : ''}`;
  if (inv.method === 'REQUEST') {
    const others = inv.attendees.filter((a) => a.email.toLowerCase() !== inv.organizer?.email.toLowerCase());
    const mine = inv.attendees.find((a) => readerOwn.has(a.email.toLowerCase()));
    return `<div class="invite-card">${head(t('invite.cardRequest'))}${facts}
      <div class="inv-meta">${esc(t('invite.organizer'))}: <b>${esc(inv.organizer?.name || inv.organizer?.email || '–')}</b>${others.length ? ` · ${esc(t('invite.nParticipants', { n: others.length }))}` : ''}${mine && mine.partstat && mine.partstat !== 'NEEDS-ACTION' ? ` · ${esc(t(`invite.ps.${mine.partstat}`))}` : ''}</div>
      <div class="inv-actions">
        <select class="inv-cal" data-inv-cal aria-label="${esc(t('cal.calendar'))}"><option value="">${esc(t('invite.loadingCals'))}</option></select>
        <button type="button" class="btn primary sm" data-inv="ACCEPTED">✓ ${esc(t('invite.accept'))}</button>
        <button type="button" class="btn ghost sm" data-inv="TENTATIVE">? ${esc(t('invite.tentative'))}</button>
        <button type="button" class="btn ghost sm danger-text" data-inv="DECLINED">✗ ${esc(t('invite.decline'))}</button>
      </div>
      <p class="hint inv-status" data-inv-status></p></div>`;
  }
  if (inv.method === 'REPLY') {
    const a = inv.attendees[0];
    const ps = a?.partstat ?? 'NEEDS-ACTION';
    return `<div class="invite-card reply ps-${ps.toLowerCase()}">${head(t(`invite.replied.${ps}`, { name: a?.name || a?.email || '' }), `ps-${ps.toLowerCase()}`)}${facts}
      <div class="inv-actions"><button type="button" class="btn ghost sm" data-inv-apply>${esc(t('invite.applyReply'))}</button></div>
      <p class="hint inv-status" data-inv-status></p></div>`;
  }
  if (inv.method === 'CANCEL') {
    return `<div class="invite-card cancel">${head(t('invite.cardCancel'), 'ps-declined')}${facts}
      <div class="inv-actions"><button type="button" class="btn ghost sm danger-text" data-inv-apply>${esc(t('invite.removeFromCal'))}</button></div>
      <p class="hint inv-status" data-inv-status></p></div>`;
  }
  return `<div class="invite-card">${head(t('invite.cardPublish'))}${facts}</div>`;
}

// Fill the calendar picker (from the cache; current in the main window)
async function fillInviteCalendars(): Promise<void> {
  const sel = document.querySelector<HTMLSelectElement>('[data-inv-cal]');
  if (!sel) return;
  let cals: CalendarInfo[] = [];
  try {
    cals = (await window.api.cal.cached([], new Date().toISOString())).calendars;
    if (!cals.length) cals = (await window.api.cal.listCalendars()).calendars;
  } catch {
    /* no calendar */
  }
  let last = '';
  try {
    last = localStorage.getItem('invite.calendar') ?? '';
  } catch {
    /* ignore */
  }
  sel.innerHTML = cals.length
    ? cals.map((c) => `<option value="${esc(c.id)}"${c.id === last ? ' selected' : ''}>${esc(c.name)} · ${esc(c.accountName)}</option>`).join('')
    : `<option value="">${esc(t('invite.noCalendar'))}</option>`;
}

document.addEventListener('click', async (e) => {
  const tgt = e.target as HTMLElement;
  const ps = tgt.closest<HTMLElement>('[data-inv]')?.dataset.inv as 'ACCEPTED' | 'TENTATIVE' | 'DECLINED' | undefined;
  const apply = tgt.closest('[data-inv-apply]');
  if ((!ps && !apply) || !inviteMsg) return;
  const card = tgt.closest<HTMLElement>('.invite-card')!;
  const status = card.querySelector<HTMLElement>('[data-inv-status]')!;
  card.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
  status.textContent = t('status.saving');
  const m = inviteMsg;
  try {
    if (ps) {
      const calId = card.querySelector<HTMLSelectElement>('[data-inv-cal]')?.value || null;
      try {
        if (calId) localStorage.setItem('invite.calendar', calId);
      } catch {
        /* ignore */
      }
      await window.api.invite.respond(m.accountId, m.folder, m.uid, ps, ps === 'DECLINED' ? null : calId);
      status.textContent = t(`invite.done.${ps}`) + (ps !== 'DECLINED' && calId ? ` ${t('invite.addedToCal')}` : '');
      card.classList.add(`answered`, `ps-${ps.toLowerCase()}`);
    } else {
      const ok = await window.api.invite.apply(m.accountId, m.folder, m.uid);
      status.textContent = ok ? t('invite.applied') : t('invite.notInCal');
    }
  } catch (err) {
    status.textContent = errMsg(err);
    card.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = false));
  }
});

// ---------- Right-click menu in the mail body ----------
// Always: reply, reply all, reply to one participant, reactions. With selected text also "Copy" and
// "Translate → <default language>" (mini AI); the translation opens in a panel with "Copy".
// Works in the HTML frame and in plain-text mails.

let bodyMsg: MailDetail | null = null; // the mail shown in the body (set by mountMailBody)
const bodyStatus = (s: string) => {
  const st = document.querySelector('#status');
  if (st) st.textContent = s;
};

let trAi: AiState | null = null;
window.api.ai.state().then((s) => (trAi = s)).catch(() => {});
window.api.ai.onState((s) => (trAi = s));
// own addresses never show up as "reply only to …" (reloaded with every mail: senders can be added)
let ownAddrs = new Set<string>();
function loadOwnAddrs(): void {
  window.api.settings
    .get()
    .then((s) => (ownAddrs = new Set(s.identities.map((i) => i.email.toLowerCase()))))
    .catch(() => {});
}

const trMenu = document.createElement('div');
trMenu.className = 'ctx-menu';
trMenu.setAttribute('role', 'menu');
trMenu.hidden = true;
const trPop = document.createElement('div');
trPop.className = 'tr-pop';
trPop.hidden = true;
document.body.append(trMenu, trPop);
let trText = '';
let trAt = { x: 0, y: 0 }; // where the menu opened, in window coordinates

function placeFixed(box: HTMLElement, x: number, y: number): void {
  box.style.left = `${Math.max(8, Math.min(x, innerWidth - box.offsetWidth - 8))}px`;
  box.style.top = `${Math.max(8, Math.min(y, innerHeight - box.offsetHeight - 8))}px`;
}

// Everyone in the conversation except yourself; the sender (or Reply-To) first
function participants(msg: MailDetail): { addr: string; name: string }[] {
  const seen = new Set<string>();
  const list = [{ addr: msg.replyTo || msg.fromAddress, name: msg.fromName }, ...[...msg.toList, ...msg.ccList].map((a) => ({ addr: a, name: '' }))];
  return list.filter((p) => {
    const k = p.addr.toLowerCase();
    if (!k || seen.has(k) || ownAddrs.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// frame = the HTML mail's iframe, if any
function openBodyMenu(e: MouseEvent, sel: Selection | null, frame?: HTMLIFrameElement): void {
  const msg = bodyMsg;
  if (!msg) return;
  e.preventDefault();
  const off = frame?.getBoundingClientRect() ?? { left: 0, top: 0 };
  trText = sel && !sel.isCollapsed ? sel.toString().trim() : '';
  trAt = { x: off.left + e.clientX, y: off.top + e.clientY };
  const item = (attr: string, ico: string, label: string) => `<button type="button" role="menuitem" ${attr}>${ico}<span>${esc(label)}</span></button>`;
  const people = participants(msg);
  const def = translateTarget(trAi);
  trMenu.innerHTML = [
    trText ? item('data-bm="copy"', ACT_ICONS.copy, t('tr.copy')) : '',
    trText && trAi?.ready ? item(`data-tr-lang="${def}"`, ACT_ICONS.translate, t('tr.translateDefault', { lang: trLangName(def) })) : '',
    trText ? '<hr>' : '',
    item('data-bm="reply"', ACT_ICONS.reply, t('mail.reply')),
    people.length > 1 ? item('data-bm="replyAll"', ACT_ICONS.replyAll, t('mail.replyAll')) : '',
    people.length > 1
      ? `<hr><div class="ctx-head">${esc(t('bm.replyOnly').toUpperCase())}</div>` +
        people.map((p, i) => `<button type="button" role="menuitem" data-bm-to="${i}" title="${esc(p.addr)}">${ACT_ICONS.reply}<span>${esc(p.name ? `${p.name} <${p.addr}>` : p.addr)}</span></button>`).join('')
      : '',
    `<hr><div class="ctx-react" role="group" aria-label="${esc(t('react.tip'))}">${REACTIONS.map((r) => `<button type="button" data-bm-react="${r}" title="${esc(t('react.tip'))}">${r}</button>`).join('')}</div>`,
  ].join('');
  trMenu.dataset.people = JSON.stringify(people.map((p) => p.addr));
  trMenu.hidden = false;
  placeFixed(trMenu, trAt.x, trAt.y);
}

async function runTranslate(target: string): Promise<void> {
  const head = `<div class="tr-head"><span>${ACT_ICONS.translate}${esc(t('tr.title', { lang: trLangName(target) }))}</span><button type="button" class="icon-btn sm" data-tr-close aria-label="${esc(t('win.close'))}">✕</button></div>`;
  trPop.innerHTML = `${head}<div class="tr-busy"><span class="ai-spin" aria-hidden="true"></span>${esc(t('tr.working'))}</div>`;
  trPop.hidden = false;
  placeFixed(trPop, trAt.x, trAt.y + 12);
  const source = trText;
  try {
    const out = await window.api.ai.translate(source, target);
    if (trPop.hidden || source !== trText) return; // closed or replaced meanwhile
    trPop.innerHTML = `${head}<div class="tr-text"></div><div class="tr-foot"><button type="button" class="btn ghost sm" data-tr-copy>${esc(t('tr.copy'))}</button></div>`;
    trPop.querySelector('.tr-text')!.textContent = out;
  } catch (err) {
    if (trPop.hidden) return;
    trPop.innerHTML = `${head}<div class="tr-text error"></div>`;
    trPop.querySelector('.tr-text')!.textContent = errMsg(err);
  }
  placeFixed(trPop, trAt.x, trAt.y + 12);
}

trMenu.addEventListener('click', (e) => {
  const tgt = e.target as HTMLElement;
  const msg = bodyMsg;
  const btn = tgt.closest<HTMLElement>('button');
  if (!btn || !msg) return;
  trMenu.hidden = true;
  const d = btn.dataset;
  if (d.trLang) return void runTranslate(d.trLang);
  if (d.bmReact) return void sendReaction(msg, d.bmReact, bodyStatus);
  if (d.bm === 'copy') return void navigator.clipboard.writeText(trText).catch(() => {});
  if (d.bm === 'reply' || d.bm === 'replyAll') return void window.api.compose.open(replyOpts(msg, d.bm === 'replyAll'));
  if (d.bmTo !== undefined) {
    const addr = (JSON.parse(trMenu.dataset.people || '[]') as string[])[Number(d.bmTo)];
    if (addr) window.api.compose.open({ ...replyOpts(msg, false), to: [addr], matchAddresses: [...msg.toList, ...msg.ccList] });
  }
});
trPop.addEventListener('click', async (e) => {
  const tgt = e.target as HTMLElement;
  if (tgt.closest('[data-tr-close]')) trPop.hidden = true;
  else if (tgt.closest('[data-tr-copy]')) {
    await navigator.clipboard.writeText(trPop.querySelector('.tr-text')?.textContent ?? '').catch(() => {});
    tgt.closest('button')!.textContent = t('tr.copied');
  }
});

// Plain-text mails live in the page itself; HTML mails are hooked up in mountMailBody
document.addEventListener('contextmenu', (e) => {
  if ((e.target as HTMLElement).closest('.text-body')) openBodyMenu(e, getSelection());
});
document.addEventListener('mousedown', (e) => {
  if (!(e.target as HTMLElement).closest('.ctx-menu')) trMenu.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    trMenu.hidden = true;
    trPop.hidden = true;
  }
});
document.addEventListener('scroll', () => (trMenu.hidden = true), true);

function hookTranslate(frame: HTMLIFrameElement): void {
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.addEventListener('contextmenu', (e) => openBodyMenu(e, frame.contentWindow!.getSelection(), frame));
  doc.addEventListener('mousedown', () => (trMenu.hidden = true));
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') trMenu.hidden = trPop.hidden = true;
  });
}
