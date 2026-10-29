import { app } from 'electron';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Local cache (SQLite, built into Electron): fast startup and offline reading.
// The server stays the source of truth – the cache is overwritten on every fetch.

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(path.join(app.getPath('userData'), 'cache.db'));
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
  return db;
}

function tx(fn: () => void): void {
  const d = open();
  d.exec('BEGIN');
  try {
    fn();
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

// ---------- Mail ----------

// Cache key per account and folder (INBOX keeps the old key = account ID)
export const folderKey = (accountId: string, folder = 'INBOX') => (folder === 'INBOX' ? accountId : `${accountId}#${folder}`);

export function removeCachedMail(key: string, uid: number): void {
  const d = open();
  d.prepare('DELETE FROM mail WHERE account_id = ? AND uid = ?').run(key, uid);
  d.prepare('DELETE FROM mail_body WHERE account_id = ? AND uid = ?').run(key, uid);
}

export function cachedMail<T>(accountIds: string[]): T[] {
  if (!accountIds.length) return [];
  const marks = accountIds.map(() => '?').join(',');
  const rows = open()
    .prepare(`SELECT summary FROM mail WHERE account_id IN (${marks}) ORDER BY date DESC LIMIT 500`)
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
export function searchCachedMail<T>(accountIds: string[], folder: string | null, query: string, limit = 200): T[] {
  if (!accountIds.length) return [];
  const where = accountIds.map(() => (folder ? 'm.account_id = ?' : '(m.account_id = ? OR m.account_id LIKE ?)')).join(' OR ');
  const keys = accountIds.flatMap((id) => (folder ? [folderKey(id, folder)] : [id, `${id.replace(/[\\%_]/g, '\\$&')}#%`]));
  const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = open()
    .prepare(
      `SELECT m.summary, (b.detail LIKE ? ESCAPE '\\') AS in_body FROM mail m LEFT JOIN mail_body b ON b.account_id = m.account_id AND b.uid = m.uid
       WHERE (${where}) AND (m.summary LIKE ? ESCAPE '\\' OR b.detail LIKE ? ESCAPE '\\') ORDER BY m.date DESC LIMIT ?`,
    )
    .all(like, ...keys, like, like, limit) as { summary: string; in_body: number | null }[];
  const q = query.toLowerCase();
  return rows
    .map((r) => ({ s: JSON.parse(r.summary), body: !!r.in_body }))
    .filter(({ s, body }) => body || [s.subject, s.from, s.fromAddress, s.toName, s.toAddress].some((v) => typeof v === 'string' && v.toLowerCase().includes(q)))
    .map(({ s }) => s as T);
}

export function setCachedSeen(accountId: string, uid: number, seen = true): void {
  const d = open();
  const row = d.prepare('SELECT summary FROM mail WHERE account_id = ? AND uid = ?').get(accountId, uid) as { summary: string } | undefined;
  if (!row) return;
  const s = JSON.parse(row.summary);
  s.seen = seen;
  d.prepare('UPDATE mail SET summary = ? WHERE account_id = ? AND uid = ?').run(JSON.stringify(s), accountId, uid);
}

export function cachedBody<T>(accountId: string, uid: number): T | null {
  const row = open().prepare('SELECT detail FROM mail_body WHERE account_id = ? AND uid = ?').get(accountId, uid) as { detail: string } | undefined;
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
  });
}

export function forgetMailAccount(accountId: string): void {
  const d = open();
  tx(() => {
    for (const t of ['mail', 'mail_body']) {
      d.prepare(`DELETE FROM ${t} WHERE account_id = ? OR account_id LIKE ?`).run(accountId, `${accountId}#%`);
    }
  });
}

// ---------- Addresses: who wrote to me / whom I wrote to (suggestions when composing) ----------

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
  const rows = open().prepare('SELECT account_id, summary FROM mail').all() as { account_id: string; summary: string }[];
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

// ---------- Key/value (calendar list, contacts) ----------

export function getKv<T>(key: string): T | null {
  const row = open().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

export function setKv(key: string, value: unknown): void {
  open().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

// ---------- Calendar (per calendar and week) ----------

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
  db?.close();
  db = null;
}
