import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Local cache (SQLite, built into Electron): fast startup and offline reading.
// The server stays the source of truth – the cache is overwritten on every fetch.

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  const file = path.join(app.getPath('userData'), 'cache.db');
  let handle: DatabaseSync | null = null;
  try {
    handle = new DatabaseSync(file);
    db = setup(handle);
  } catch (err) {
    // damaged file (crash, full disk): put it aside and start with an empty cache instead of not starting at all
    console.error('cache.db unreadable, starting a new one:', (err as Error).message);
    try {
      handle?.close(); // Windows can't rename an open file
    } catch {
      /* already closed */
    }
    const aside = `${file}.broken-${Date.now()}`;
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(file + ext)) fs.renameSync(file + ext, aside + ext);
    db = setup(new DatabaseSync(file));
  }
  return db;
}

function setup(db: DatabaseSync): DatabaseSync {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS mail (
      account_id TEXT NOT NULL, uid INTEGER NOT NULL, date TEXT NOT NULL, summary TEXT NOT NULL,
      PRIMARY KEY (account_id, uid));
    CREATE INDEX IF NOT EXISTS mail_date ON mail (date DESC);
    CREATE TABLE IF NOT EXISTS mail_body (
      account_id TEXT NOT NULL, uid INTEGER NOT NULL, detail TEXT NOT NULL,
      PRIMARY KEY (account_id, uid));
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS addr (email TEXT PRIMARY KEY, name TEXT NOT NULL, last TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS cal_week (
      calendar_id TEXT NOT NULL, week_start TEXT NOT NULL, events TEXT NOT NULL,
      PRIMARY KEY (calendar_id, week_start));
  `);
  // first layout of the offline copy (no full-text index yet): start over, it is only a copy
  const cols = (db.prepare("PRAGMA table_info('offline_mail')").all() as { name: string }[]).map((c) => c.name);
  if (cols.length && !cols.includes('id')) db.exec('DROP TABLE offline_mail; DROP TABLE IF EXISTS offline_body;');
  // Offline copy of a whole period per account (Settings → General), kept apart from the "newest mails" cache above.
  // offline_fts: full-text index (trigram = finds parts of words, ignores accents) over headers and text
  db.exec(`
    CREATE TABLE IF NOT EXISTS offline_mail (
      id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, uid INTEGER NOT NULL, date TEXT NOT NULL,
      message_id TEXT NOT NULL DEFAULT '', in_reply_to TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL,
      UNIQUE (account_id, uid));
    CREATE INDEX IF NOT EXISTS offline_mail_date ON offline_mail (date DESC);
    CREATE INDEX IF NOT EXISTS offline_mail_msgid ON offline_mail (message_id);
    CREATE INDEX IF NOT EXISTS offline_mail_reply ON offline_mail (in_reply_to);
    CREATE INDEX IF NOT EXISTS offline_mail_acc_date ON offline_mail (account_id, date DESC);
    CREATE TABLE IF NOT EXISTS offline_body (
      account_id TEXT NOT NULL, uid INTEGER NOT NULL, detail TEXT NOT NULL,
      PRIMARY KEY (account_id, uid));
    CREATE VIRTUAL TABLE IF NOT EXISTS offline_fts USING fts5(text, content='', contentless_delete=1, tokenize='trigram remove_diacritics 1');
  `);
  return db;
}

// Transactions may nest (a helper inside another transaction): only the outermost one commits
let depth = 0;
function tx(fn: () => void): void {
  const d = open();
  if (depth) {
    depth++;
    try {
      return fn();
    } finally {
      depth--;
    }
  }
  d.exec('BEGIN');
  depth = 1;
  try {
    fn();
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  } finally {
    depth = 0;
  }
}

// Mail
// Cache key per account and folder (INBOX keeps the old key = account ID)
export const folderKey = (accountId: string, folder = 'INBOX') => (folder === 'INBOX' ? accountId : `${accountId}#${folder}`);

export function removeCachedMail(key: string, uid: number): void {
  const d = open();
  d.prepare('DELETE FROM mail WHERE account_id = ? AND uid = ?').run(key, uid);
  d.prepare('DELETE FROM mail_body WHERE account_id = ? AND uid = ?').run(key, uid);
  removeOffline(key, [uid]);
}

export function cachedMail<T>(accountIds: string[]): T[] {
  if (!accountIds.length) return [];
  const marks = accountIds.map(() => '?').join(',');
  const rows = open()
    .prepare(`SELECT summary FROM mail WHERE account_id IN (${marks}) ORDER BY date DESC LIMIT 2000`) // newest + the unread ones of several inboxes
    .all(...accountIds) as { summary: string }[];
  return rows.map((r) => JSON.parse(r.summary));
}

export function storeMail<T extends { uid: number; date: string }>(accountId: string, list: T[]): void {
  const d = open();
  tx(() => {
    d.prepare('DELETE FROM mail WHERE account_id = ?').run(accountId);
    const ins = d.prepare('INSERT INTO mail (account_id, uid, date, summary) VALUES (?, ?, ?, ?)');
    for (const m of list) ins.run(accountId, m.uid, m.date, JSON.stringify(m));
    rememberFromSummaries(list as unknown as AddrSource[]);
    // Only keep bodies for mails that are still in the list
    d.prepare('DELETE FROM mail_body WHERE account_id = ? AND uid NOT IN (SELECT uid FROM mail WHERE account_id = ?)').run(accountId, accountId);
  });
}

// Instant search in the local copies (summary fields and cached bodies) – shown before the server answers.
// folder null = every cached folder of the accounts
// range: the query is a date ("12.3.2024") → also every mail of that day or month
export function searchCachedMail<T>(accountIds: string[], folder: string | null, query: string, limit = 200, range?: { since: Date; before: Date } | null): T[] {
  if (!accountIds.length) return [];
  const where = (a: string) => accountIds.map(() => (folder ? `${a}.account_id = ?` : `(${a}.account_id = ? OR ${a}.account_id LIKE ?)`)).join(' OR ');
  const keys = accountIds.flatMap((id) => (folder ? [folderKey(id, folder)] : [id, `${id.replace(/[\\%_]/g, '\\$&')}#%`]));
  const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const d = open();
  // newest-mails cache: small, a plain scan is fine
  const recent = d
    .prepare(
      `SELECT m.summary, (b.detail LIKE ? ESCAPE '\\') AS in_body FROM mail m LEFT JOIN mail_body b ON b.account_id = m.account_id AND b.uid = m.uid
       WHERE (${where('m')}) AND (m.summary LIKE ? ESCAPE '\\' OR b.detail LIKE ? ESCAPE '\\') ORDER BY m.date DESC LIMIT ?`,
    )
    .all(like, ...keys, like, like, limit) as { summary: string; in_body: number | null }[];
  const q = query.toLowerCase();
  const hits = recent
    .map((r) => ({ s: JSON.parse(r.summary), body: !!r.in_body }))
    .filter(({ s, body }) => body || [s.subject, s.from, s.fromAddress, s.toName, s.toAddress].some((v) => typeof v === 'string' && v.toLowerCase().includes(q)))
    .map(({ s }) => s);
  // offline copy: full-text index (needs 3 characters, shorter queries only look at the headers)
  const offline = (
    query.length >= 3
      ? d.prepare(`SELECT o.summary FROM offline_fts f JOIN offline_mail o ON o.id = f.rowid WHERE offline_fts MATCH ? AND (${where('o')}) ORDER BY o.date DESC LIMIT ?`).all(`"${query.replace(/"/g, '""')}"`, ...keys, limit)
      : d.prepare(`SELECT o.summary FROM offline_mail o WHERE (${where('o')}) AND o.summary LIKE ? ESCAPE '\\' ORDER BY o.date DESC LIMIT ?`).all(...keys, like, limit)
  ) as { summary: string }[];
  const byDate = range
    ? (d
        .prepare(
          `SELECT m.summary FROM mail m WHERE (${where('m')}) AND m.date >= ? AND m.date < ?
           UNION ALL SELECT o.summary FROM offline_mail o WHERE (${where('o')}) AND o.date >= ? AND o.date < ? LIMIT ?`,
        )
        .all(...keys, range.since.toISOString(), range.before.toISOString(), ...keys, range.since.toISOString(), range.before.toISOString(), limit) as { summary: string }[])
    : [];
  const seen = new Set<string>();
  return [...byDate.map((r) => JSON.parse(r.summary)), ...hits, ...offline.map((r) => JSON.parse(r.summary))]
    .filter((s) => {
      const k = `${s.accountId}|${s.folder}|${s.uid}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, limit) as T[];
}

export function setCachedSeen(accountId: string, uid: number, seen = true): void {
  const d = open();
  for (const table of ['mail', 'offline_mail']) {
    const row = d.prepare(`SELECT summary FROM ${table} WHERE account_id = ? AND uid = ?`).get(accountId, uid) as { summary: string } | undefined;
    if (!row) continue;
    const s = JSON.parse(row.summary);
    s.seen = seen;
    d.prepare(`UPDATE ${table} SET summary = ? WHERE account_id = ? AND uid = ?`).run(JSON.stringify(s), accountId, uid);
  }
}

export function cachedBody<T>(accountId: string, uid: number): T | null {
  const row = open().prepare('SELECT detail FROM mail_body WHERE account_id = ? AND uid = ?').get(accountId, uid) as { detail: string } | undefined;
  return row ? JSON.parse(row.detail) : null;
}

// Offline copy of a mail body (partial = only the first part of a big mail)
export function offlineBody<T>(accountId: string, uid: number): (T & { partial?: boolean }) | null {
  const row = open().prepare('SELECT detail FROM offline_body WHERE account_id = ? AND uid = ?').get(accountId, uid) as { detail: string } | undefined;
  return row ? JSON.parse(row.detail) : null;
}

export function storeBody(accountId: string, uid: number, detail: unknown): void {
  open().prepare('INSERT OR REPLACE INTO mail_body (account_id, uid, detail) VALUES (?, ?, ?)').run(accountId, uid, JSON.stringify(detail));
}

// One folder emptied/moved on the server → drop its local copies
export function forgetFolder(key: string): void {
  const d = open();
  tx(() => {
    d.prepare('DELETE FROM mail WHERE account_id = ?').run(key);
    d.prepare('DELETE FROM mail_body WHERE account_id = ?').run(key);
    dropOffline('account_id = ?', [key]);
  });
}

export function forgetMailAccount(accountId: string): void {
  const d = open();
  tx(() => {
    for (const t of ['mail', 'mail_body']) {
      d.prepare(`DELETE FROM ${t} WHERE account_id = ? OR account_id LIKE ?`).run(accountId, `${accountId}#%`);
    }
    dropOffline('account_id = ? OR account_id LIKE ?', [accountId, `${accountId}#%`]);
  });
}

// Addresses: who wrote to me / whom I wrote to (suggestions when composing)
interface AddrSource {
  from?: string;
  fromAddress?: string;
  toName?: string;
  toAddress?: string;
  date?: string;
}

const upsertAddr = () =>
  open().prepare(
    `INSERT INTO addr (email, name, last, hits) VALUES (?, ?, ?, 1)
     ON CONFLICT(email) DO UPDATE SET name = CASE WHEN excluded.name <> '' AND excluded.name <> excluded.email THEN excluded.name ELSE addr.name END,
       last = MAX(addr.last, excluded.last), hits = addr.hits + 1`,
  );

function rememberFromSummaries(list: AddrSource[]): void {
  const up = upsertAddr();
  for (const m of list) {
    if (m.fromAddress) up.run(m.fromAddress.toLowerCase(), m.from || '', m.date || '');
    if (m.toAddress) up.run(m.toAddress.toLowerCase(), m.toName || '', m.date || '');
  }
}

export function rememberAddresses(list: { name: string; address: string }[]): void {
  const up = upsertAddr();
  const now = new Date().toISOString();
  for (const a of list) if (a.address) up.run(a.address.toLowerCase(), a.name || '', now);
}

export function knownAddresses(limit = 3000): { name: string; address: string }[] {
  const rows = open().prepare('SELECT email, name FROM addr ORDER BY last DESC LIMIT ?').all(limit) as { email: string; name: string }[];
  return rows.map((r) => ({ name: r.name, address: r.email }));
}

// Cached mails by Message-ID (for categories across all folders)
export function cachedByMessageIds<T>(ids: string[]): T[] {
  const want = new Set(ids);
  const d = open();
  const rows = d.prepare('SELECT account_id, summary FROM mail').all() as { account_id: string; summary: string }[];
  // offline copy: by the indexed Message-ID column
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    rows.push(...(d.prepare(`SELECT account_id, summary FROM offline_mail WHERE message_id IN (${part.map(() => '?').join(',')})`).all(...part) as { account_id: string; summary: string }[]));
  }
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const s = JSON.parse(r.summary);
    if (!s.messageId || !want.has(s.messageId) || seen.has(s.messageId + '|' + s.accountId)) continue;
    seen.add(s.messageId + '|' + s.accountId);
    out.push({ ...s, folder: s.folder ?? (r.account_id.includes('#') ? r.account_id.split('#').slice(1).join('#') : 'INBOX') });
  }
  return out;
}

// Cached mails that answer a Message-ID (In-Reply-To), e.g. own replies in "Sent"
export function cachedReplies<T>(messageId: string): T[] {
  if (!messageId) return [];
  const rows = open().prepare('SELECT summary FROM mail WHERE summary LIKE ? UNION ALL SELECT summary FROM offline_mail WHERE in_reply_to = ?').all(`%${messageId.replace(/[%_]/g, '')}%`, messageId) as { summary: string }[];
  return rows.map((r) => JSON.parse(r.summary)).filter((s) => s.inReplyTo === messageId) as T[];
}

// Key/value (calendar list, contacts)
export function getKv<T>(key: string): T | null {
  const row = open().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

export function setKv(key: string, value: unknown): void {
  open().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

// Keys with a given prefix whose value contains text. LIKE ignores case for ASCII only.
export function searchKv(prefix: string, text: string): string[] {
  const esc = (v: string) => v.replace(/[\\%_]/g, '\\$&');
  const rows = open().prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' AND value LIKE ? ESCAPE '\\'").all(`${esc(prefix)}%`, `%${esc(text)}%`) as { key: string }[];
  return rows.map((r) => r.key.slice(prefix.length));
}

export function delKv(keys: string[]): void {
  if (!keys.length) return;
  const st = open().prepare('DELETE FROM kv WHERE key = ?');
  tx(() => keys.forEach((k) => st.run(k)));
}

// Calendar (per calendar and week)
export function cachedWeek<T>(calendarIds: string[], weekStart: string): T[] {
  if (!calendarIds.length) return [];
  const marks = calendarIds.map(() => '?').join(',');
  const rows = open()
    .prepare(`SELECT events FROM cal_week WHERE week_start = ? AND calendar_id IN (${marks})`)
    .all(weekStart, ...calendarIds) as { events: string }[];
  return rows.flatMap((r) => JSON.parse(r.events));
}

export function storeWeek(calendarId: string, weekStart: string, events: unknown[]): void {
  open().prepare('INSERT OR REPLACE INTO cal_week (calendar_id, week_start, events) VALUES (?, ?, ?)').run(calendarId, weekStart, JSON.stringify(events));
}

export function closeCache(): void {
  try {
    if (db) incremental(db); // once: switch an older file over while quitting, where the pause doesn't matter
  } catch (err) {
    console.error('auto_vacuum:', err);
  }
  db?.close();
  db = null;
}

// Offline copy (see offline.ts)
type OfflineSummary = { uid: number; date: string; messageId?: string; inReplyTo?: string; subject?: string; from?: string; fromAddress?: string; toName?: string; toAddress?: string; rcpt?: string };

const headerText = (m: OfflineSummary) => [m.subject, m.from, m.fromAddress, m.toName, m.toAddress, m.rcpt].filter(Boolean).join(' ');

// Text of a mail for the index: plain text, otherwise the HTML without tags (capped, enough for searching)
function bodyText(detail: { text?: string; html?: string | null }): string {
  const text = detail.text?.trim()
    ? detail.text
    : (detail.html ?? '')
        .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
  return text.replace(/\s+/g, ' ').slice(0, 300_000);
}

function dropOffline(where: string, args: string[]): void {
  const d = open();
  d.prepare(`DELETE FROM offline_fts WHERE rowid IN (SELECT id FROM offline_mail WHERE ${where})`).run(...args);
  d.prepare(`DELETE FROM offline_body WHERE ${where}`).run(...args);
  d.prepare(`DELETE FROM offline_mail WHERE ${where}`).run(...args);
}

// Older mails of a folder from the offline copy (scrolling down without the server)
export function offlineOlder<T>(key: string, beforeUid: number, limit: number): T[] {
  return (open().prepare('SELECT summary FROM offline_mail WHERE account_id = ? AND uid < ? ORDER BY uid DESC LIMIT ?').all(key, beforeUid, limit) as { summary: string }[]).map((r) => JSON.parse(r.summary));
}

export function offlineUids(key: string): number[] {
  return (open().prepare('SELECT uid FROM offline_mail WHERE account_id = ?').all(key) as { uid: number }[]).map((r) => r.uid);
}

export function storeOffline<T extends OfflineSummary>(key: string, list: T[]): void {
  const d = open();
  const ins = d.prepare(
    `INSERT INTO offline_mail (account_id, uid, date, message_id, in_reply_to, summary) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, uid) DO UPDATE SET date = excluded.date, message_id = excluded.message_id, in_reply_to = excluded.in_reply_to, summary = excluded.summary RETURNING id`,
  );
  const del = d.prepare('DELETE FROM offline_fts WHERE rowid = ?');
  const idx = d.prepare('INSERT INTO offline_fts (rowid, text) VALUES (?, ?)');
  tx(() => {
    for (const m of list) {
      const { id } = ins.get(key, m.uid, m.date, m.messageId ?? '', m.inReplyTo ?? '', JSON.stringify(m)) as { id: number };
      del.run(id);
      idx.run(id, headerText(m));
    }
  });
}

// Flags changed on the server (read, star, answered)
export function updateOfflineFlags(key: string, flags: Map<number, { seen: boolean; flagged: boolean; answered: boolean; forwarded: boolean }>): void {
  const d = open();
  const get = d.prepare('SELECT summary FROM offline_mail WHERE account_id = ? AND uid = ?');
  const put = d.prepare('UPDATE offline_mail SET summary = ? WHERE account_id = ? AND uid = ?');
  tx(() => {
    for (const [uid, f] of flags) {
      const row = get.get(key, uid) as { summary: string } | undefined;
      if (!row) continue;
      const s = JSON.parse(row.summary);
      if (s.seen === f.seen && s.flagged === f.flagged && s.answered === f.answered && s.forwarded === f.forwarded) continue;
      put.run(JSON.stringify({ ...s, ...f }), key, uid);
    }
  });
}

export function removeOffline(key: string, uids: number[]): void {
  if (!uids.length) return;
  tx(() => {
    for (const uid of uids) dropOffline('account_id = ? AND uid = ?', [key, String(uid)]);
  });
}

// UIDs of the offline copy without a stored body, newest first
export function offlineWithoutBody(key: string, limit: number): number[] {
  return (
    open()
      .prepare('SELECT o.uid FROM offline_mail o LEFT JOIN offline_body b ON b.account_id = o.account_id AND b.uid = o.uid WHERE o.account_id = ? AND b.uid IS NULL ORDER BY o.date DESC LIMIT ?')
      .all(key, limit) as { uid: number }[]
  ).map((r) => r.uid);
}

// Body plus index: headers, attachment names and text together
export function storeOfflineBody(key: string, uid: number, detail: { text?: string; html?: string | null; attachments?: { filename: string }[] }): void {
  const d = open();
  const row = d.prepare('SELECT id, summary FROM offline_mail WHERE account_id = ? AND uid = ?').get(key, uid) as { id: number; summary: string } | undefined;
  if (!row) return;
  tx(() => {
    d.prepare('INSERT OR REPLACE INTO offline_body (account_id, uid, detail) VALUES (?, ?, ?)').run(key, uid, JSON.stringify(detail));
    d.prepare('DELETE FROM offline_fts WHERE rowid = ?').run(row.id);
    const files = (detail.attachments ?? []).map((a) => a.filename).filter(Boolean).join(' ');
    d.prepare('INSERT INTO offline_fts (rowid, text) VALUES (?, ?)').run(row.id, `${headerText(JSON.parse(row.summary))} ${files} ${bodyText(detail)}`);
  });
}

// Give the space of deleted data back to the system. With auto_vacuum = INCREMENTAL SQLite only moves the
// last pages into the free ones and cuts the file – fast, no rebuild. Returns the bytes freed.
export function vacuumCache(): number {
  return shrink(open(), path.join(app.getPath('userData'), 'cache.db'));
}

export function hasOffline(accountId: string): boolean {
  return !!open().prepare('SELECT 1 FROM offline_mail WHERE account_id = ? OR account_id LIKE ? LIMIT 1').get(accountId, `${accountId}#%`);
}

// Offline copy of one account gone (period set back to "newest only")
export function clearOfflineAccount(accountId: string): void {
  tx(() => dropOffline('account_id = ? OR account_id LIKE ?', [accountId, `${accountId}#%`]));
}

// Per account (folder keys "<id>#<folder>" belong to <id>)
export function offlineStats(): { mails: number; bodies: number; bytes: number; perAccount: Record<string, { mails: number; bodies: number; bytes: number }> } {
  const d = open();
  const per: Record<string, { mails: number; bodies: number; bytes: number }> = {};
  const acc = (key: string) => (per[key.split('#')[0]] ??= { mails: 0, bodies: 0, bytes: 0 });
  for (const r of d.prepare('SELECT account_id AS k, COUNT(*) AS n, COALESCE(SUM(LENGTH(summary)), 0) AS b FROM offline_mail GROUP BY account_id').all() as { k: string; n: number; b: number }[]) {
    acc(r.k).mails += Number(r.n);
    acc(r.k).bytes += Number(r.b);
  }
  for (const r of d.prepare('SELECT account_id AS k, COUNT(*) AS n, COALESCE(SUM(LENGTH(detail)), 0) AS b FROM offline_body GROUP BY account_id').all() as { k: string; n: number; b: number }[]) {
    acc(r.k).bodies += Number(r.n);
    acc(r.k).bytes += Number(r.b);
  }
  const all = Object.values(per);
  return { mails: all.reduce((n, x) => n + x.mails, 0), bodies: all.reduce((n, x) => n + x.bodies, 0), bytes: all.reduce((n, x) => n + x.bytes, 0), perAccount: per };
}

// SQLite keeps deleted space inside the file and reuses it; it never shrinks the file by itself.
// INCREMENTAL lets it hand free pages back on request. Switching an existing file over needs one full
// VACUUM (once, when quitting the first time with this version); after that each start frees what got deleted.
export function incremental(d: DatabaseSync): void {
  const mode = Number((d.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum);
  if (mode !== 2) {
    d.exec('PRAGMA auto_vacuum = INCREMENTAL');
    d.exec('VACUUM');
  }
}

const FREE_MIN = 2560; // pages (≈ 10 MB): below that it's not worth it

export function shrink(d: DatabaseSync, file: string, force = true): number {
  const size = () => ['', '-wal'].reduce((n, ext) => n + (fs.existsSync(file + ext) ? fs.statSync(file + ext).size : 0), 0);
  const free = Number((d.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count);
  if (!free || (!force && free < FREE_MIN)) return 0;
  const before = size();
  d.exec('PRAGMA incremental_vacuum');
  d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return Math.max(0, before - size());
}

// At start: give back what was deleted since the last time (only when it's worth it)
export function tidyCache(): number {
  return shrink(open(), path.join(app.getPath('userData'), 'cache.db'), false);
}
