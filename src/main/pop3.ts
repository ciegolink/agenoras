// POP3 accounts: the server only hands out the inbox, so mails are downloaded into a local store
// (pop3.db) with the usual folders. Unlike cache.db this is the real mailbox of the account –
// it is never wiped automatically.
// Every function here mirrors the IMAP function of the same name; imap.ts forwards POP3 accounts.
import { app } from 'electron';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { simpleParser } from 'mailparser';
import { Account, getAccount, getPassword } from './accounts';
import { t } from './i18n';
import type { FolderInfo, MailDetail, MailSummary } from './imap';
import { log } from './log';
import { AttachmentFile, buildDetail, inviteIcs, splitAttachments, summaryFromParsed } from './mailparse';
import { Pop3Cfg, Pop3Client } from './pop3client';

export const POP_FOLDERS: { path: string; specialUse: string }[] = [
  { path: 'INBOX', specialUse: '\\Inbox' },
  { path: 'Sent', specialUse: '\\Sent' },
  { path: 'Archive', specialUse: '\\Archive' },
  { path: 'Junk', specialUse: '\\Junk' },
  { path: 'Trash', specialUse: '\\Trash' },
];
const POLL_MS = 2 * 60_000;

let db: DatabaseSync | null = null;
function open(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(path.join(app.getPath('userData'), 'pop3.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS msg (
      account_id TEXT NOT NULL, uid INTEGER NOT NULL, folder TEXT NOT NULL, uidl TEXT,
      date TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', raw BLOB NOT NULL,
      PRIMARY KEY (account_id, uid));
    CREATE INDEX IF NOT EXISTS msg_folder ON msg (account_id, folder, date DESC);
    -- every UIDL ever downloaded (also after deleting locally – so it doesn't come back);
    -- remove = 1: delete it on the server at the next fetch
    CREATE TABLE IF NOT EXISTS seen_uidl (
      account_id TEXT NOT NULL, uidl TEXT NOT NULL, fetched TEXT NOT NULL, remove INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, uidl));
  `);
  return db;
}

export const isPop = (acc: { protocol?: string } | undefined) => acc?.protocol === 'pop3';

type Row = { uid: number; folder: string; seen: number; flagged: number; summary: string };
const toSummary = (r: Row): MailSummary => ({ ...JSON.parse(r.summary), folder: r.folder, uid: r.uid, seen: !!r.seen, flagged: !!r.flagged });

function nextUid(accountId: string): number {
  const r = open().prepare('SELECT MAX(uid) AS m FROM msg WHERE account_id = ?').get(accountId) as { m: number | null };
  return (r.m ?? 0) + 1;
}

async function store(acc: Account, folder: string, raw: Buffer, uidl: string | null, seen: boolean): Promise<MailSummary> {
  const parsed = await simpleParser(raw);
  const uid = nextUid(acc.id);
  const sum = summaryFromParsed(acc, folder, uid, parsed);
  open()
    .prepare('INSERT INTO msg (account_id, uid, folder, uidl, date, seen, flagged, summary, text, raw) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)')
    .run(acc.id, uid, folder, uidl, sum.date, seen ? 1 : 0, JSON.stringify(sum), `${parsed.subject ?? ''}\n${parsed.text ?? ''}`.slice(0, 200_000), raw);
  return { ...sum, seen };
}

// Fetching from the server
const cfgOf = (acc: Account): Pop3Cfg => ({ host: acc.host, port: acc.port, secure: acc.secure, user: acc.user });
const running = new Map<string, Promise<MailSummary[]>>(); // one fetch per account at a time
const timers = new Map<string, NodeJS.Timeout>();
let onNew: (accountId: string, grew: boolean) => void = () => {};

export function setOnNew(fn: (accountId: string, grew: boolean) => void): void {
  onNew = fn;
}

export function sync(acc: Account): Promise<MailSummary[]> {
  const busy = running.get(acc.id);
  if (busy) return busy;
  const p = doSync(acc).finally(() => running.delete(acc.id));
  running.set(acc.id, p);
  return p;
}

async function doSync(acc: Account): Promise<MailSummary[]> {
  let c: Pop3Client;
  try {
    c = await Pop3Client.connect(cfgOf(acc), await getPassword(acc.id));
  } catch (err) {
    log('error', 'POP3', acc.email, t('log.connFailed', { host: `${acc.host}:${acc.port}`, msg: (err as Error).message }));
    throw err;
  }
  const d = open();
  const fresh: MailSummary[] = [];
  try {
    const list = await c.uidl();
    const known = new Map((d.prepare('SELECT uidl, fetched, remove FROM seen_uidl WHERE account_id = ?').all(acc.id) as { uidl: string; fetched: string; remove: number }[]).map((r) => [r.uidl, r]));
    const maxAge = acc.deleteAfterDays ? Date.now() - acc.deleteAfterDays * 86_400_000 : 0;
    for (const [n, uidl] of list) {
      const k = known.get(uidl);
      if (!k) {
        const raw = await c.retr(n);
        fresh.push(await store(acc, 'INBOX', raw, uidl, false));
        d.prepare('INSERT OR REPLACE INTO seen_uidl (account_id, uidl, fetched, remove) VALUES (?, ?, ?, 0)').run(acc.id, uidl, new Date().toISOString());
        if (acc.leaveOnServer === false) await c.dele(n); // stored safely → off the server
      } else if (k.remove || acc.leaveOnServer === false || (maxAge && Date.parse(k.fetched) < maxAge)) {
        await c.dele(n); // deleted here permanently, or older than the chosen number of days
      }
    }
    // forget UIDLs that are gone from the server (keeps the table small)
    const onServer = new Set(list.values());
    for (const uidl of known.keys()) if (!onServer.has(uidl)) d.prepare('DELETE FROM seen_uidl WHERE account_id = ? AND uidl = ?').run(acc.id, uidl);
  } catch (err) {
    log('error', 'POP3', acc.email, (err as Error).message);
    c.close();
    throw err;
  }
  await c.quit();
  if (fresh.length) onNew(acc.id, true);
  return fresh;
}

export async function start(acc: Account): Promise<void> {
  stop(acc.id);
  // like IMAP: only mail arriving from now on is announced
  if (!lastReported.has(acc.id)) lastReported.set(acc.id, maxUid(acc, 'INBOX'));
  timers.set(
    acc.id,
    setInterval(() => {
      const still = getAccount(acc.id);
      if (still && isPop(still)) sync(still).catch(() => {}); // logged in doSync
      else stop(acc.id);
    }, POLL_MS),
  );
  await sync(acc);
}

export function stop(id: string): void {
  clearInterval(timers.get(id));
  timers.delete(id);
}

export const stopAll = () => [...timers.keys()].forEach(stop);

export async function testConnection(cfg: Pop3Cfg, pass: string): Promise<void> {
  const c = await Pop3Client.connect(cfg, pass);
  await c.uidl();
  await c.quit();
}

// The local mailbox
export function listFolders(acc: Account): FolderInfo[] {
  const counts = new Map(
    (open().prepare('SELECT folder, COUNT(*) AS n FROM msg WHERE account_id = ? AND seen = 0 GROUP BY folder').all(acc.id) as { folder: string; n: number }[]).map((r) => [r.folder, r.n]),
  );
  return POP_FOLDERS.map((f) => ({ path: f.path, name: f.path, depth: 0, specialUse: f.specialUse, unseen: counts.get(f.path) ?? 0, selectable: true }));
}

export async function fetchFolder(acc: Account, folder = 'INBOX', limit = 300): Promise<MailSummary[]> {
  if (folder === 'INBOX') await sync(acc);
  const rows = open().prepare('SELECT uid, folder, seen, flagged, summary FROM msg WHERE account_id = ? AND folder = ? ORDER BY date DESC LIMIT ?').all(acc.id, folder, limit) as Row[];
  return rows.map(toSummary).reverse(); // oldest first, like IMAP
}

function rawOf(acc: Account, uid: number): Buffer {
  const r = open().prepare('SELECT raw FROM msg WHERE account_id = ? AND uid = ?').get(acc.id, uid) as { raw: Uint8Array } | undefined;
  if (!r) throw new Error(t('err.messageNotFound'));
  return Buffer.from(r.raw);
}

export async function getMessage(acc: Account, folder: string, uid: number, markRead = true): Promise<MailDetail> {
  const parsed = await simpleParser(rawOf(acc, uid));
  if (markRead) setSeen(acc, folder, [uid], true);
  return buildDetail(acc, folder, uid, parsed);
}

export async function getAttachmentFiles(acc: Account, _folder: string, uid: number): Promise<AttachmentFile[]> {
  return splitAttachments(await simpleParser(rawOf(acc, uid))).files;
}

export async function getInviteIcs(acc: Account, _folder: string, uid: number): Promise<string | null> {
  return inviteIcs(await simpleParser(rawOf(acc, uid)));
}

const inList = (uids: number[]) => uids.map(Number).filter(Number.isInteger).join(',') || '0';

export function markFolderSeen(acc: Account, folder: string): number {
  return Number(open().prepare('UPDATE msg SET seen = 1 WHERE account_id = ? AND folder = ? AND seen = 0').run(acc.id, folder).changes);
}

export function setSeen(acc: Account, _folder: string, uids: number[], seen: boolean): void {
  open().prepare(`UPDATE msg SET seen = ? WHERE account_id = ? AND uid IN (${inList(uids)})`).run(seen ? 1 : 0, acc.id);
}

export function setFlagged(acc: Account, _folder: string, uids: number[], flagged: boolean): void {
  open().prepare(`UPDATE msg SET flagged = ? WHERE account_id = ? AND uid IN (${inList(uids)})`).run(flagged ? 1 : 0, acc.id);
}

export function fetchFlagged(acc: Account): MailSummary[] {
  const rows = open().prepare("SELECT uid, folder, seen, flagged, summary FROM msg WHERE account_id = ? AND flagged = 1 AND folder NOT IN ('Trash', 'Junk') ORDER BY date DESC LIMIT 300").all(acc.id) as Row[];
  return rows.map(toSummary);
}

export function moveMessages(acc: Account, folder: string, uids: number[], target: string): void {
  if (!POP_FOLDERS.some((f) => f.path === target)) throw new Error(t('err.moveFailed'));
  open().prepare(`UPDATE msg SET folder = ? WHERE account_id = ? AND folder = ? AND uid IN (${inList(uids)})`).run(target, acc.id, folder);
}

// Permanently gone: also remove the server copy at the next fetch (if it was left there)
function destroy(acc: Account, where: string, ...args: (string | number)[]): number {
  const d = open();
  d.prepare(`UPDATE seen_uidl SET remove = 1 WHERE account_id = ? AND uidl IN (SELECT uidl FROM msg WHERE account_id = ? AND ${where})`).run(acc.id, acc.id, ...args);
  return Number(d.prepare(`DELETE FROM msg WHERE account_id = ? AND ${where}`).run(acc.id, ...args).changes);
}

export function deleteMessages(acc: Account, folder: string, uids: number[]): 'trash' | 'deleted' {
  if (folder !== 'Trash') {
    moveMessages(acc, folder, uids, 'Trash');
    return 'trash';
  }
  destroy(acc, `folder = 'Trash' AND uid IN (${inList(uids)})`);
  return 'deleted';
}

export const emptyFolder = (acc: Account, folder: string) => destroy(acc, 'folder = ?', folder);

export function moveAllMessages(acc: Account, folder: string, target: string): number {
  return Number(open().prepare('UPDATE msg SET folder = ? WHERE account_id = ? AND folder = ?').run(target, acc.id, folder).changes);
}

// Local full-text search (subject, people, body text)
export function searchFolders(acc: Account, folders: string[], query: string, limit: number): MailSummary[] {
  if (!folders.length) return [];
  const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = open()
    .prepare(
      `SELECT uid, folder, seen, flagged, summary FROM msg WHERE account_id = ? AND folder IN (${folders.map(() => '?').join(',')})
       AND (summary LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\') ORDER BY date DESC LIMIT ?`,
    )
    .all(acc.id, ...folders, like, like, limit * folders.length) as Row[];
  return rows.map(toSummary);
}

// Notifications: unread inbox mails newer than the last report
const lastReported = new Map<string, number>();
export function fetchNewSince(acc: Account): MailSummary[] {
  const from = lastReported.get(acc.id) ?? 0;
  const rows = open().prepare("SELECT uid, folder, seen, flagged, summary FROM msg WHERE account_id = ? AND folder = 'INBOX' AND uid > ? ORDER BY uid").all(acc.id, from) as Row[];
  const out = rows.map(toSummary);
  if (out.length) lastReported.set(acc.id, Math.max(...out.map((m) => m.uid)));
  return out.filter((m) => !m.seen);
}

// Mail rules
export function fetchSinceUid(acc: Account, folder: string, fromUid: number): MailSummary[] {
  const rows = open().prepare('SELECT uid, folder, seen, flagged, summary FROM msg WHERE account_id = ? AND folder = ? AND uid >= ? ORDER BY uid').all(acc.id, folder, fromUid) as Row[];
  return rows.map(toSummary);
}

export function maxUid(acc: Account, folder = 'INBOX'): number {
  const r = open().prepare('SELECT MAX(uid) AS m FROM msg WHERE account_id = ? AND folder = ?').get(acc.id, folder) as { m: number | null };
  return r.m ?? 0;
}

// Sent mails have no server copy with POP3 → keep them locally
export async function appendToSent(acc: Account, raw: Buffer): Promise<void> {
  await store(acc, 'Sent', raw, null, true);
}

// Account removed → its local mailbox goes too
export function forgetAccount(id: string): void {
  const d = open();
  d.prepare('DELETE FROM msg WHERE account_id = ?').run(id);
  d.prepare('DELETE FROM seen_uidl WHERE account_id = ?').run(id);
}

export function closeStore(): void {
  db?.close();
  db = null;
}
