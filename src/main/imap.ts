import { ImapFlow, MessageStructureObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Socket } from 'node:net';
import { Account, getAccount, getPassword } from './accounts';
import { accessToken, forgetToken } from './oauth';
import { t } from './i18n';
import { log, resolved } from './log';
import type { InviteInfo } from './invites';
import * as pop from './pop3';
import { AttachmentFile, buildDetail, inviteIcs, parsePriority, splitAttachments } from './mailparse';

export { parsePriority };
export type { AttachmentFile };

export interface MailSummary {
  accountId: string;
  folder: string;
  uid: number;
  from: string;
  fromAddress: string;
  toName: string; // first recipient – shown instead of the sender in the Sent folder
  subject: string;
  date: string; // ISO
  seen: boolean;
  hasAttachments: boolean;
  priority: Priority;
  messageId: string; // for categories (stays the same when moving)
  inReplyTo?: string; // Message-ID of the mail this one answers – for conversations
  beyond?: boolean; // unread mail further back than the newest ones of the list (not where "load older" starts)
  flagged: boolean; // star / "important" (\Flagged)
  answered?: boolean; // replied to (\Answered) – also set by other mail programs
  forwarded?: boolean; // forwarded ($Forwarded)
  toAddress: string; // address of the first recipient (address book suggestions)
  rcpt?: string; // all recipients (To + Cc), for mail rules
}

export type Priority = 'high' | 'normal' | 'low';

export interface MailDetail {
  accountId: string;
  folder: string;
  uid: number;
  subject: string;
  fromName: string;
  fromAddress: string;
  to: string;
  toList: string[];
  ccList: string[];
  replyTo: string;
  messageId: string;
  references: string[];
  date: string;
  html: string | null;
  text: string;
  priority: Priority;
  attachments: { filename: string; size: number; contentType: string }[];
  invite?: InviteInfo | null; // meeting invitation/reply (text/calendar)
  unsubscribe?: { url?: string; mail?: string }; // newsletter: List-Unsubscribe header
}

export interface FolderInfo {
  path: string;
  name: string;
  depth: number;
  specialUse: string; // \Inbox, \Sent, \Drafts, \Junk, \Trash, \Archive … or ''
  unseen: number;
  selectable: boolean;
}

interface ConnCfg {
  protocol?: 'imap' | 'pop3';
  host: string;
  port: number;
  secure: boolean;
  user: string;
}

const clients = new Map<string, ImapFlow>();
const lastUid = new Map<string, number>(); // highest UID already reported in the inbox
let stopping = false;
let onNew: (accountId: string, grew: boolean) => void = () => {};

// grew = really a new message (not just deleted/moved) → sound
// Connected again after a drop: the main window reloads and its error line goes away
let onReconnect: (accountId: string) => void = () => {};
const wasConnected = new Set<string>();
export function setOnReconnect(fn: (accountId: string) => void): void {
  onReconnect = fn;
}

export function setOnNewMail(fn: (accountId: string, grew: boolean) => void): void {
  onNew = fn;
  pop.setOnNew(fn);
}

export function friendlyError(err: unknown): string {
  const e = err as { responseText?: string; message?: string; authenticationFailed?: boolean };
  if (e?.authenticationFailed) return t('err.authFailed');
  return e?.responseText || e?.message || String(err);
}

// Password or OAuth access token
export type Secret = string | { accessToken: string };

// ImapFlow turns on TCP keepalive after 5 s; with Electron's libuv that means a probe every second and
// "dead" after 10 missed ones, so a short network hiccup kills every idle connection (read ETIMEDOUT).
// Like other mail clients we rely on IDLE being renewed every 4 minutes instead.
type SocketHook = { configureSocket(socket: Socket): void };

function makeClient(cfg: ConnCfg, secret: Secret): ImapFlow {
  const c = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: typeof secret === 'string' ? { user: cfg.user, pass: secret } : { user: cfg.user, accessToken: secret.accessToken },
    logger: false,
    maxIdleTime: 4 * 60_000,
  });
  const hook = c as unknown as SocketHook;
  const configure = hook.configureSocket;
  hook.configureSocket = function (socket) {
    configure.call(this, socket);
    socket?.setKeepAlive?.(false);
  };
  return c;
}

export async function testConnection(cfg: ConnCfg, secret: Secret): Promise<void> {
  if (cfg.protocol === 'pop3' && typeof secret === 'string') return pop.testConnection(cfg, secret);
  const c = makeClient(cfg, secret);
  await c.connect();
  await c.logout();
}

// One persistent connection per account. INBOX stays open → ImapFlow goes into IDLE automatically.
// Concurrent callers wait for the same connect, some servers limit connections per user.
const connecting = new Map<string, Promise<ImapFlow>>();
const DROPPED = new Set(['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'NoConnection']);

function getClient(acc: Account): Promise<ImapFlow> {
  const existing = clients.get(acc.id);
  if (existing && existing.usable) return Promise.resolve(existing);
  let p = connecting.get(acc.id);
  if (!p) {
    p = connectClient(acc).finally(() => connecting.delete(acc.id));
    connecting.set(acc.id, p);
  }
  return p;
}

async function connectClient(acc: Account): Promise<ImapFlow> {
  const c = makeClient(acc, acc.oauth ? { accessToken: await accessToken(acc) } : await getPassword(acc.id));
  c.on('exists', (data: { path?: string; count?: number; prevCount?: number }) => {
    if (!data?.path || data.path === 'INBOX') onNew(acc.id, (data?.count ?? 0) > (data?.prevCount ?? 0));
  });
  // A dropped connection (timeout, reset) is followed by "close" and a reconnect: one warning is enough.
  // Only a failing reconnect is logged as an error (in connectClient).
  let dropReason = '';
  c.on('error', (err) => {
    const code = (err as { code?: string })?.code ?? '';
    if (DROPPED.has(code)) dropReason = code;
    else log('error', 'IMAP', acc.email, friendlyError(err));
  });
  c.on('close', () => {
    const wasActive = clients.get(acc.id) === c;
    if (wasActive) clients.delete(acc.id);
    if (!stopping && getAccount(acc.id)) {
      if (wasActive) log('warn', 'IMAP', acc.email, t('log.connLost') + (dropReason ? ` (${dropReason})` : ''));
      setTimeout(() => {
        const still = getAccount(acc.id);
        if (still && !stopping) getClient(still).catch(() => {}); // failure is logged in getClient
      }, wasActive ? 5_000 : 30_000);
    }
  });

  try {
    await c.connect();
  } catch (err) {
    if (acc.oauth) forgetToken(acc.id); // next attempt gets a fresh token
    log('error', 'IMAP', acc.email, t('log.connFailed', { host: `${acc.host}:${acc.port}`, msg: friendlyError(err) }));
    throw err;
  }
  let box: Awaited<ReturnType<ImapFlow['mailboxOpen']>>;
  try {
    box = await c.mailboxOpen('INBOX');
  } catch (err) {
    c.close();
    throw err;
  }
  // From here on everything counts as "new" (for notifications); do not reset on reconnect
  if (!lastUid.has(acc.id)) lastUid.set(acc.id, Math.max(0, Number(box.uidNext ?? 1) - 1));
  clients.set(acc.id, c);
  if (wasConnected.has(acc.id)) onReconnect(acc.id);
  wasConnected.add(acc.id);
  resolved('IMAP', acc.email);
  resolved('Offline', acc.email); // connected again: the offline sync's complaints are over too
  return c;
}

export async function startAccount(acc: Account): Promise<void> {
  if (pop.isPop(acc)) return pop.start(acc);
  await getClient(acc);
}

// Works in a folder and then returns to INBOX so IDLE reports new mail
// The connection went away in the middle (timeout, server closed it): not a real error, it reconnects
const isDropped = (err: unknown) => DROPPED.has(String((err as { code?: string })?.code ?? '')) || /connection not available|connection closed/i.test(String((err as Error)?.message ?? ''));

// Run fn with the folder selected. A dropped connection gets one more try on a fresh one, quietly.
async function inFolder<T>(acc: Account, folder: string, fn: (c: ImapFlow) => Promise<T>, retry = true): Promise<T> {
  const c = await getClient(acc);
  let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>>;
  try {
    lock = await c.getMailboxLock(folder);
  } catch (err) {
    if (retry && isDropped(err)) return inFolder(acc, folder, fn, false);
    log('error', 'IMAP', acc.email, `${folder}: ${friendlyError(err)}`);
    throw err;
  }
  let again = false;
  try {
    return await fn(c);
  } catch (err) {
    if (retry && isDropped(err)) again = true;
    else {
      log('error', 'IMAP', acc.email, `${folder}: ${friendlyError(err)}`);
      throw err;
    }
  } finally {
    lock.release();
    if (folder !== 'INBOX') {
      c.getMailboxLock('INBOX')
        .then((l) => l.release())
        .catch(() => {});
    }
  }
  // outside the finally: the old lock is released before the new connection is used
  if (again) return inFolder(acc, folder, fn, false);
  throw new Error('unreachable');
}

// Folders
const SPECIAL_ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash', '\\All', '\\Flagged', '\\Important'];

// Servers without SPECIAL-USE: detect special folders by name (top level only)
const SPECIAL_NAMES: [string, RegExp][] = [
  ['\\Sent', /^(sent|sent items|sent messages|sent mail|gesendet|gesendete elemente|gesendete objekte|gesendete nachrichten)$/i],
  ['\\Drafts', /^(drafts|draft|entwürfe|entwurf)$/i],
  ['\\Trash', /^(trash|deleted|deleted items|deleted messages|papierkorb|gelöscht|gelöschte elemente|gelöschte objekte)$/i],
  ['\\Junk', /^(junk|spam|junk e-mail|junk-e-mail|bulk mail|unerwünscht)$/i],
  ['\\Archive', /^(archive|archives|archiv)$/i],
];

// Folders as a tree: subfolders always sit directly below their parent.
// - If all folders live under "INBOX." (common with Dovecot hosts), they are shown at the
//   top level like in Outlook.
// - Non-selectable container folders (e.g. "[Gmail]") are skipped, their children move up.
// - Top level: Inbox, then special folders in a fixed order, then alphabetical.
export async function listFolders(acc: Account): Promise<FolderInfo[]> {
  if (pop.isPop(acc)) return pop.listFolders(acc);
  const c = await getClient(acc);
  const boxes = await c.list({ statusQuery: { unseen: true } });
  const isInbox = (path: string) => path.toUpperCase() === 'INBOX';
  const byPath = new Map(boxes.map((b) => [b.path, b]));
  const selectable = (b: (typeof boxes)[number]) => !b.flags?.has('\\Noselect') && !b.flags?.has('\\NonExistent');

  const others = boxes.filter((b) => !isInbox(b.path));
  const underInbox = others.length > 0 && others.every((b) => isInbox(b.path.split(b.delimiter || '.')[0]));

  // Determine the parent folder (skipping the INBOX prefix and container folders)
  const parentOf = (b: (typeof boxes)[number]): string => {
    let parent = b.parentPath || '';
    for (;;) {
      if (!parent) return '';
      if (underInbox && isInbox(parent)) return '';
      const pb = byPath.get(parent);
      if (!pb || selectable(pb)) return parent; // missing parent folder → group anyway
      parent = pb.parentPath || '';
    }
  };

  const children = new Map<string, (typeof boxes)[number][]>();
  for (const b of boxes) {
    if (!selectable(b)) continue;
    const key = isInbox(b.path) ? '\u0000inbox' : parentOf(b);
    if (!children.has(key)) children.set(key, []);
    children.get(key)!.push(b);
  }
  // INBOX always belongs to the top level
  const roots = [...(children.get('\u0000inbox') ?? []), ...(children.get('') ?? [])];

  // Special folders: those flagged by the server first, then name detection for missing types
  const special = new Map<string, string>();
  for (const b of boxes) if (isInbox(b.path)) special.set(b.path, '\\Inbox');
  const taken = new Set<string>(['\\Inbox']);
  for (const b of boxes) if (b.specialUse && !isInbox(b.path) && !taken.has(b.specialUse)) { special.set(b.path, b.specialUse); taken.add(b.specialUse); }
  for (const b of roots) {
    if (special.has(b.path)) continue;
    const hit = SPECIAL_NAMES.find(([use, re]) => !taken.has(use) && re.test(b.name));
    if (hit) { special.set(b.path, hit[0]); taken.add(hit[0]); }
  }

  const byName = (a: (typeof boxes)[number], b: (typeof boxes)[number]) => a.name.localeCompare(b.name, 'de', { numeric: true, sensitivity: 'base' });
  const rank = (b: (typeof boxes)[number]) => {
    const i = SPECIAL_ORDER.indexOf(special.get(b.path) ?? '');
    return i === -1 ? SPECIAL_ORDER.length : i;
  };

  const out: FolderInfo[] = [];
  const visit = (b: (typeof boxes)[number], depth: number) => {
    out.push({ path: b.path, name: b.name, depth, specialUse: special.get(b.path) ?? '', unseen: b.status?.unseen ?? 0, selectable: true });
    for (const child of (children.get(b.path) ?? []).sort(byName)) visit(child, depth + 1);
  };
  for (const b of roots.sort((a, b) => rank(a) - rank(b) || byName(a, b))) visit(b, 0);
  return out;
}

async function findSpecial(c: ImapFlow, use: '\\Sent' | '\\Trash' | '\\Archive' | '\\Junk', names: RegExp): Promise<string | null> {
  const boxes = await c.list();
  const box = boxes.find((b) => b.specialUse === use) ?? boxes.find((b) => names.test(b.name));
  return box?.path ?? null;
}

// The Sent folder per account, looked up once (not again for every mail of a mass mailing)
const sentPath = new Map<string, string | null>();

export async function appendToSent(acc: Account, raw: Buffer, retry = true): Promise<void> {
  if (pop.isPop(acc)) return pop.appendToSent(acc, raw);
  const c = await getClient(acc);
  try {
    if (!sentPath.has(acc.id)) sentPath.set(acc.id, await findSpecial(c, '\\Sent', /^(sent|sent items|sent messages|gesendet|gesendete elemente|gesendete objekte)$/i));
    const sent = sentPath.get(acc.id);
    if (sent) await c.append(sent, raw, ['\\Seen']);
  } catch (err) {
    sentPath.delete(acc.id); // renamed or gone: look again next time
    if (retry && isDropped(err)) return appendToSent(acc, raw, false);
    throw err;
  }
}

// Mails
function hasAttachment(node?: MessageStructureObject): boolean {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  return (node.childNodes ?? []).some(hasAttachment);
}

const SUMMARY_QUERY = { uid: true, envelope: true, flags: true, bodyStructure: true, headers: ['x-priority', 'importance', 'priority'] };

type FetchedMsg = { uid: number; envelope?: any; flags?: Set<string>; bodyStructure?: MessageStructureObject; headers?: Buffer };

function toSummary(acc: Account, folder: string, msg: FetchedMsg): MailSummary {
  const from = msg.envelope?.from?.[0];
  const to = msg.envelope?.to?.[0];
  return {
    accountId: acc.id,
    folder,
    uid: msg.uid,
    from: from?.name || from?.address || '',
    fromAddress: from?.address || '',
    toName: to?.name || to?.address || '',
    toAddress: to?.address || '',
    rcpt: [...(msg.envelope?.to ?? []), ...(msg.envelope?.cc ?? [])].map((a: { name?: string; address?: string }) => `${a.name ?? ''} <${a.address ?? ''}>`).join(', '),
    flagged: msg.flags?.has('\\Flagged') ?? false,
    answered: msg.flags?.has('\\Answered') ?? false,
    forwarded: msg.flags?.has('$Forwarded') ?? false,
    subject: msg.envelope?.subject || '',
    date: new Date(msg.envelope?.date ?? Date.now()).toISOString(),
    seen: msg.flags?.has('\\Seen') ?? false,
    hasAttachments: hasAttachment(msg.bodyStructure),
    priority: parsePriority(msg.headers?.toString('utf8') ?? ''),
    messageId: msg.envelope?.messageId || '',
    inReplyTo: msg.envelope?.inReplyTo || '',
  };
}

// The newest mails of a folder plus every unread one further back (at most UNREAD_MAX), so the list,
// its "Unread" filter and the unread count agree
const UNREAD_MAX = 300;

export async function fetchFolder(acc: Account, folder = 'INBOX', limit = 50, withUnread = true): Promise<MailSummary[]> {
  if (pop.isPop(acc)) return pop.fetchFolder(acc, folder);
  return inFolder(acc, folder, async (c) => {
    const mb = c.mailbox;
    if (!mb || !mb.exists) return [];
    const start = Math.max(1, mb.exists - limit + 1);
    const out: MailSummary[] = [];
    for await (const msg of c.fetch(`${start}:*`, SUMMARY_QUERY)) out.push(toSummary(acc, folder, msg as FetchedMsg));
    if (start > 1 && withUnread) {
      const have = new Set(out.map((m) => m.uid));
      const unread = ((await c.search({ seen: false }, { uid: true })) || []).filter((u) => !have.has(u)).sort((a, b) => b - a).slice(0, UNREAD_MAX);
      if (unread.length) for await (const msg of c.fetch(unread.join(','), SUMMARY_QUERY, { uid: true })) out.push({ ...toSummary(acc, folder, msg as FetchedMsg), beyond: true });
    }
    return out;
  });
}

// Full-text search on the server (subject, sender, recipients, body) – newest hits first
export async function searchFolder(acc: Account, folder: string, query: string, limit = 50): Promise<MailSummary[]> {
  return inFolder(acc, folder, async (c) => {
    if (!c.mailbox || !c.mailbox.exists) return [];
    const uids = await c.search({ or: [{ subject: query }, { from: query }, { to: query }, { body: query }] }, { uid: true });
    if (!uids || !uids.length) return [];
    const pick = uids.sort((a, b) => a - b).slice(-limit);
    const out: MailSummary[] = [];
    for await (const msg of c.fetch(pick.join(','), SUMMARY_QUERY, { uid: true })) out.push(toSummary(acc, folder, msg as FetchedMsg));
    return out;
  });
}

// Search several folders in one go: no return to INBOX between the folders (halves the round trips),
// stops as soon as a newer search has started
export async function searchFolders(acc: Account, folders: string[], query: string, limit: number, cancelled: () => boolean, range?: { since: Date; before: Date } | null): Promise<MailSummary[]> {
  if (pop.isPop(acc)) return pop.searchFolders(acc, folders, query, limit, range);
  const c = await getClient(acc);
  const out: MailSummary[] = [];
  try {
    for (const folder of folders) {
      if (cancelled()) break;
      let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>>;
      try {
        lock = await c.getMailboxLock(folder);
      } catch (err) {
        log('warn', 'IMAP', acc.email, t('log.searchFolder', { folder, msg: friendlyError(err) }));
        continue; // folder not selectable
      }
      try {
        if (!c.mailbox || !c.mailbox.exists || cancelled()) continue;
        const uids = (await c.search({ or: [{ subject: query }, { from: query }, { to: query }, { body: query }] }, { uid: true })) || [];
        // a date as query: also the mails of that day / month
        if (range) for (const u of (await c.search({ since: range.since, before: range.before }, { uid: true })) || []) if (!uids.includes(u)) uids.push(u);
        if (!uids.length || cancelled()) continue;
        const pick = uids.sort((a, b) => a - b).slice(-limit);
        for await (const msg of c.fetch(pick.join(','), SUMMARY_QUERY, { uid: true })) out.push(toSummary(acc, folder, msg as FetchedMsg));
      } catch (err) {
        log('warn', 'IMAP', acc.email, t('log.searchFolder', { folder, msg: friendlyError(err) })); // the other folders go on
      } finally {
        lock.release();
      }
    }
  } finally {
    if (folders.some((f) => f !== 'INBOX')) {
      c.getMailboxLock('INBOX')
        .then((l) => l.release())
        .catch(() => {});
    }
  }
  return out;
}

// Newly arrived unread mails in the inbox since the last report (for notifications)
export async function fetchNewSince(acc: Account): Promise<MailSummary[]> {
  if (pop.isPop(acc)) return pop.fetchNewSince(acc);
  return inFolder(acc, 'INBOX', async (c) => {
    const from = (lastUid.get(acc.id) ?? 0) + 1;
    const out: MailSummary[] = [];
    for await (const msg of c.fetch(`${from}:*`, SUMMARY_QUERY, { uid: true })) {
      if (msg.uid < from) continue; // "N:*" always returns at least the last mail
      out.push(toSummary(acc, 'INBOX', msg as FetchedMsg));
    }
    if (out.length) lastUid.set(acc.id, Math.max(...out.map((m) => m.uid)));
    return out.filter((m) => !m.seen);
  });
}

// For mail rules: mails of a folder from a UID on (incl. read ones) and the current highest UID
export async function fetchSinceUid(acc: Account, folder: string, fromUid: number): Promise<MailSummary[]> {
  if (pop.isPop(acc)) return pop.fetchSinceUid(acc, folder, fromUid);
  return inFolder(acc, folder, async (c) => {
    if (!c.mailbox || !c.mailbox.exists) return [];
    const out: MailSummary[] = [];
    for await (const msg of c.fetch(`${fromUid}:*`, SUMMARY_QUERY, { uid: true })) {
      if (msg.uid >= fromUid) out.push(toSummary(acc, folder, msg as FetchedMsg));
    }
    return out;
  });
}

export async function maxUid(acc: Account, folder = 'INBOX'): Promise<number> {
  if (pop.isPop(acc)) return pop.maxUid(acc, folder);
  // highest UID of the newest message (fresh from the server – uidNext of the open mailbox can be stale)
  return inFolder(acc, folder, async (c) => {
    await c.noop().catch(() => {}); // fetch new messages from the server
    if (!c.mailbox || !c.mailbox.exists) return 0;
    const last = await c.fetchOne('*', { uid: true });
    return last ? last.uid : 0;
  });
}

// Set / remove star (\Flagged)
export async function setFlagged(acc: Account, folder: string, uids: number[], flagged: boolean): Promise<void> {
  if (pop.isPop(acc)) return pop.setFlagged(acc, folder, uids, flagged);
  if (!uids.length) return;
  await inFolder(acc, folder, (c) => (flagged ? c.messageFlagsAdd(uids.join(','), ['\\Flagged'], { uid: true }) : c.messageFlagsRemove(uids.join(','), ['\\Flagged'], { uid: true })));
}

// After a reply or forward: mark the original, like other mail programs do (POP3 has no flags)
export async function markAnswered(acc: Account, folder: string, uid: number, kind: 'reply' | 'forward'): Promise<void> {
  if (pop.isPop(acc) || !uid) return;
  await inFolder(acc, folder, (c) => c.messageFlagsAdd(String(uid), [kind === 'forward' ? '$Forwarded' : '\\Answered'], { uid: true }));
}

// Older mails when scrolling down: the next ones below the smallest UID shown so far
export async function fetchOlder(acc: Account, folder: string, beforeUid: number, limit = 50): Promise<MailSummary[]> {
  if (pop.isPop(acc) || beforeUid <= 1) return []; // POP3: the local store already gives more at once
  return inFolder(acc, folder, async (c) => {
    if (!c.mailbox || !c.mailbox.exists) return [];
    const uids = await c.search({ uid: `1:${beforeUid - 1}` }, { uid: true });
    if (!uids || !uids.length) return [];
    const pick = uids.sort((a, b) => a - b).slice(-limit);
    const out: MailSummary[] = [];
    for await (const msg of c.fetch(pick.join(','), SUMMARY_QUERY, { uid: true })) out.push(toSummary(acc, folder, msg as FetchedMsg));
    return out;
  });
}

// Offline copy (offline.ts): UIDs of a folder in the period, summaries and flags in batches, bodies
export async function offlineFolderUids(acc: Account, folder: string, since: Date | null): Promise<{ uidValidity: string; uids: number[] }> {
  return inFolder(acc, folder, async (c) => {
    const mb = c.mailbox;
    if (!mb || !mb.exists) return { uidValidity: String(mb ? mb.uidValidity : ''), uids: [] };
    const uids = await c.search(since ? { since } : { all: true }, { uid: true });
    return { uidValidity: String(mb.uidValidity), uids: uids || [] };
  });
}

export async function fetchSummaries(acc: Account, folder: string, uids: number[]): Promise<MailSummary[]> {
  if (!uids.length) return [];
  return inFolder(acc, folder, async (c) => {
    const out: MailSummary[] = [];
    for await (const msg of c.fetch(uids.join(','), SUMMARY_QUERY, { uid: true })) out.push(toSummary(acc, folder, msg as FetchedMsg));
    return out;
  });
}

export async function fetchFlags(acc: Account, folder: string, uids: number[]): Promise<Map<number, { seen: boolean; flagged: boolean; answered: boolean; forwarded: boolean }>> {
  const out = new Map<number, { seen: boolean; flagged: boolean; answered: boolean; forwarded: boolean }>();
  if (!uids.length) return out;
  return inFolder(acc, folder, async (c) => {
    for await (const msg of c.fetch(uids.join(','), { uid: true, flags: true }, { uid: true })) {
      const f = msg.flags ?? new Set<string>();
      out.set(msg.uid, { seen: f.has('\\Seen'), flagged: f.has('\\Flagged'), answered: f.has('\\Answered'), forwarded: f.has('$Forwarded') });
    }
    return out;
  });
}

// Body for the offline copy without marking it read; big mails only up to maxBytes (text first, attachments cut off)
export async function fetchOfflineBody(acc: Account, folder: string, uid: number, maxBytes: number): Promise<(MailDetail & { partial?: boolean }) | null> {
  return inFolder(acc, folder, async (c) => {
    const head = await c.fetchOne(String(uid), { size: true }, { uid: true });
    if (!head) return null;
    const big = (head.size ?? 0) > maxBytes;
    const msg = await c.fetchOne(String(uid), { source: big ? { maxLength: maxBytes } : true }, { uid: true });
    if (!msg || !msg.source) return null;
    const detail = await buildDetail(acc, folder, uid, await simpleParser(msg.source));
    return big ? { ...detail, partial: true } : detail;
  });
}

// Unread mails in the inbox, for the sidebar and "All inboxes" (the folder list is only loaded for open accounts)
export async function inboxUnseen(acc: Account): Promise<number> {
  if (pop.isPop(acc)) return pop.listFolders(acc).find((f) => f.path === 'INBOX')?.unseen ?? 0;
  return inFolder(acc, 'INBOX', async (c) => ((await c.search({ seen: false }, { uid: true })) || []).length);
}

// Mails with these Message-IDs in any folder of the account (categories of older mails that are not cached)
export async function findByMessageIds(acc: Account, ids: string[]): Promise<MailSummary[]> {
  if (pop.isPop(acc) || !ids.length) return [];
  const folders = (await listFolders(acc)).filter((f) => f.selectable && !['\\Trash', '\\Junk', '\\All', '\\Flagged', '\\Important'].includes(f.specialUse));
  const out: MailSummary[] = [];
  let left = new Set(ids);
  for (const f of folders) {
    if (!left.size) break;
    try {
      const found = await inFolder(acc, f.path, async (c) => {
        if (!c.mailbox || !c.mailbox.exists) return [];
        const uids: number[] = [];
        const want = [...left];
        for (let i = 0; i < want.length; i += 20) {
          const part = want.slice(i, i + 20).map((id) => ({ header: { 'message-id': id } }));
          const hit = await c.search(part.length === 1 ? part[0] : { or: part }, { uid: true });
          if (hit) uids.push(...hit);
        }
        if (!uids.length) return [];
        const list: MailSummary[] = [];
        for await (const msg of c.fetch(uids.join(','), SUMMARY_QUERY, { uid: true })) list.push(toSummary(acc, f.path, msg as FetchedMsg));
        return list.filter((m) => left.has(m.messageId));
      });
      out.push(...found);
      left = new Set([...left].filter((id) => !found.some((m) => m.messageId === id)));
    } catch {
      /* folder not readable */
    }
  }
  return out;
}

// All starred mails of an account (without trash, spam, drafts and Gmail collection folders)
export async function fetchFlagged(acc: Account, perFolder = 50): Promise<MailSummary[]> {
  if (pop.isPop(acc)) return pop.fetchFlagged(acc);
  const folders = (await listFolders(acc)).filter((f) => f.selectable && !['\\Trash', '\\Junk', '\\Drafts', '\\All', '\\Flagged', '\\Important'].includes(f.specialUse));
  const out: MailSummary[] = [];
  for (const f of folders) {
    try {
      out.push(
        ...(await inFolder(acc, f.path, async (c) => {
          if (!c.mailbox || !c.mailbox.exists) return [];
          const uids = await c.search({ flagged: true }, { uid: true });
          if (!uids || !uids.length) return [];
          const list: MailSummary[] = [];
          for await (const msg of c.fetch(uids.sort((a, b) => a - b).slice(-perFolder).join(','), SUMMARY_QUERY, { uid: true })) list.push(toSummary(acc, f.path, msg as FetchedMsg));
          return list;
        })),
      );
    } catch {
      /* folder not readable */
    }
  }
  return out;
}

// Mark read / unread (several UIDs in one command)
export async function setSeen(acc: Account, folder: string, uids: number[], seen: boolean): Promise<void> {
  if (pop.isPop(acc)) return pop.setSeen(acc, folder, uids, seen);
  if (!uids.length) return;
  await inFolder(acc, folder, (c) => (seen ? c.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true }) : c.messageFlagsRemove(uids.join(','), ['\\Seen'], { uid: true })));
}

// "1:500,502,510:512" – keeps the IMAP command short even for thousands of UIDs
function packUids(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    parts.push(start === sorted[i] ? String(start) : `${start}:${sorted[i]}`);
  }
  return parts.join(',');
}

// Mark the whole folder read; returns how many were unread
export async function markFolderSeen(acc: Account, folder: string): Promise<number> {
  if (pop.isPop(acc)) return pop.markFolderSeen(acc, folder);
  return inFolder(acc, folder, async (c) => {
    const uids = (await c.search({ seen: false }, { uid: true })) || [];
    if (uids.length) await c.messageFlagsAdd(packUids(uids), ['\\Seen'], { uid: true });
    return uids.length;
  });
}

async function fetchSource(c: ImapFlow, uid: number): Promise<Buffer> {
  const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
  if (!msg || !msg.source) throw new Error(t('err.messageNotFound'));
  return msg.source;
}

export async function getMessage(acc: Account, folder: string, uid: number, markRead = true): Promise<MailDetail> {
  if (pop.isPop(acc)) return pop.getMessage(acc, folder, uid, markRead);
  return inFolder(acc, folder, async (c) => {
    const source = await fetchSource(c, uid);
    if (markRead) await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    return buildDetail(acc, folder, uid, await simpleParser(source));
  });
}

export async function getAttachmentFiles(acc: Account, folder: string, uid: number): Promise<AttachmentFile[]> {
  if (pop.isPop(acc)) return pop.getAttachmentFiles(acc, folder, uid);
  return inFolder(acc, folder, async (c) => splitAttachments(await simpleParser(await fetchSource(c, uid))).files);
}

export async function markSeen(acc: Account, folder: string, uid: number): Promise<void> {
  if (pop.isPop(acc)) return pop.setSeen(acc, folder, [uid], true);
  await inFolder(acc, folder, (c) => c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }));
}

// Move several mails in one IMAP command (UID list "12,15,18")
// Returns the new UIDs in the target folder (needed for undo)
export async function moveMessages(acc: Account, folder: string, uids: number[], target: string): Promise<number[]> {
  const moved = await moveRaw(acc, folder, uids, target);
  // moved into the inbox by the user (undo, not spam …): that's not new mail for the notification
  if (target === 'INBOX' && moved.length && !pop.isPop(acc)) lastUid.set(acc.id, Math.max(lastUid.get(acc.id) ?? 0, ...moved));
  return moved;
}

async function moveRaw(acc: Account, folder: string, uids: number[], target: string): Promise<number[]> {
  if (pop.isPop(acc)) {
    pop.moveMessages(acc, folder, uids, target);
    return uids; // POP: UIDs stay the same
  }
  if (target === folder || !uids.length) return [];
  // no UIDPLUS: remember the Message-IDs and look them up afterwards
  const msgIds: string[] = [];
  const res = await inFolder(acc, folder, async (c) => {
    if (!c.capabilities.has('UIDPLUS')) {
      for await (const m of c.fetch(uids.join(','), { envelope: true }, { uid: true })) if (m.envelope?.messageId) msgIds.push(m.envelope.messageId);
    }
    const ok = await c.messageMove(uids.join(','), target, { uid: true });
    if (!ok) throw new Error(t('err.moveFailed'));
    return ok;
  });
  if (res.uidMap?.size) return [...res.uidMap.values()];
  if (!msgIds.length) return [];
  return inFolder(acc, target, async (c) => {
    const found: number[] = [];
    for (const id of msgIds) {
      const hit = await c.search({ header: { 'message-id': id } }, { uid: true });
      if (hit) found.push(...hit);
    }
    return found;
  });
}

// Delete = move to trash; permanently inside the trash itself
// target/uids tell where the mails ended up (for undo)
export interface DeleteResult {
  result: 'trash' | 'deleted';
  target?: string;
  uids?: number[];
}

export async function deleteMessages(acc: Account, folder: string, uids: number[]): Promise<DeleteResult> {
  if (pop.isPop(acc)) {
    const result = pop.deleteMessages(acc, folder, uids);
    return result === 'trash' ? { result, target: 'Trash', uids } : { result };
  }
  const c = await getClient(acc);
  const trash = await findSpecial(c, '\\Trash', /^(trash|deleted items|deleted messages|papierkorb|gelöschte elemente|gelöschte objekte)$/i);
  if (trash && trash !== folder) {
    return { result: 'trash', target: trash, uids: await moveMessages(acc, folder, uids, trash) };
  }
  if (uids.length) await inFolder(acc, folder, (c2) => c2.messageDelete(uids.join(','), { uid: true }));
  return { result: 'deleted' };
}

export async function trashFolder(acc: Account): Promise<string | null> {
  if (pop.isPop(acc)) return 'Trash';
  const c = await getClient(acc);
  return findSpecial(c, '\\Trash', /^(trash|deleted items|deleted messages|papierkorb|gelöschte elemente|gelöschte objekte)$/i);
}

// Whole folder at once (1:* = every message): permanently delete …
export async function emptyFolder(acc: Account, folder: string): Promise<number> {
  if (pop.isPop(acc)) return pop.emptyFolder(acc, folder);
  return inFolder(acc, folder, async (c) => {
    const n = c.mailbox ? c.mailbox.exists : 0;
    if (n) await c.messageDelete('1:*');
    return n;
  });
}

// … or move everything into another folder
export async function moveAllMessages(acc: Account, folder: string, target: string): Promise<number> {
  if (pop.isPop(acc)) return pop.moveAllMessages(acc, folder, target);
  if (folder === target) return 0;
  return inFolder(acc, folder, async (c) => {
    const n = c.mailbox ? c.mailbox.exists : 0;
    if (n && !(await c.messageMove('1:*', target))) throw new Error(t('err.moveFailed'));
    return n;
  });
}

export async function junkFolder(acc: Account): Promise<string | null> {
  if (pop.isPop(acc)) return 'Junk';
  const c = await getClient(acc);
  return findSpecial(c, '\\Junk', /^(junk|spam|junk e-mail|junk-e-mail|bulk mail|unerwünscht)$/i);
}

export async function archiveFolder(acc: Account): Promise<string | null> {
  if (pop.isPop(acc)) return 'Archive';
  const c = await getClient(acc);
  return findSpecial(c, '\\Archive', /^(archive|archiv)$/i);
}

export async function closeAccount(id: string): Promise<void> {
  pop.stop(id);
  const c = clients.get(id);
  clients.delete(id);
  if (c) await c.logout().catch(() => c.close());
}

// After sleep the sockets are usually dead without noticing: start fresh right away, without a warning
export function reconnectAll(): void {
  for (const [id, c] of clients) {
    clients.delete(id);
    c.close();
    const acc = getAccount(id);
    if (acc) getClient(acc).catch(() => {});
  }
}

export async function closeAll(): Promise<void> {
  stopping = true;
  pop.stopAll();
  await Promise.all([...clients.keys()].map(closeAccount));
}

// Raw text of a mail's invitation (text/calendar)
export async function getInviteIcs(acc: Account, folder: string, uid: number): Promise<string | null> {
  if (pop.isPop(acc)) return pop.getInviteIcs(acc, folder, uid);
  return inFolder(acc, folder, async (c) => {
    return inviteIcs(await simpleParser(await fetchSource(c, uid)));
  });
}
