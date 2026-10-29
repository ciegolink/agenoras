// Local calendars and address books (no server): a stand-in for the tsdav DAVClient that keeps the
// iCalendar/vCard objects in local.db. caldav.ts, tasks.ts and carddav.ts use it exactly like a
// server, so events, series, invitations, tasks and contacts work the same for local accounts.
// local.db is the only copy of this data – it is never wiped automatically.
import { app } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const LOCAL_URL = 'local:';
export const isLocalDav = (acc: { serverUrl: string } | undefined) => acc?.serverUrl === LOCAL_URL;

let db: DatabaseSync | null = null;
function open(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(path.join(app.getPath('userData'), 'local.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS coll (
      url TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS obj (
      url TEXT PRIMARY KEY, coll TEXT NOT NULL, data TEXT NOT NULL, etag TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS obj_coll ON obj (coll);
  `);
  return db;
}

type Kind = 'cal' | 'book';
interface Coll {
  url: string;
  name: string;
  color: string;
}

// Each local account has one collection; it is created on first use
function collections(accountId: string, kind: Kind, name: string): Coll[] {
  const d = open();
  let rows = d.prepare('SELECT url, name, color FROM coll WHERE account_id = ? AND kind = ?').all(accountId, kind) as unknown as Coll[];
  if (!rows.length) {
    const url = `${LOCAL_URL}${kind}/${accountId}/`;
    d.prepare('INSERT INTO coll (url, account_id, kind, name, color) VALUES (?, ?, ?, ?, ?)').run(url, accountId, kind, name, '#2BA89F');
    rows = [{ url, name, color: '#2BA89F' }];
  }
  return rows;
}

const ok = (status = 200) => new Response(null, { status });
const etag = () => crypto.randomUUID();

function objects(coll: string): { url: string; data: string; etag: string }[] {
  return open().prepare('SELECT url, data, etag FROM obj WHERE coll = ?').all(coll) as unknown as { url: string; data: string; etag: string }[];
}

function create(coll: string, filename: string, data: string): Response {
  const url = `${coll}${filename}`;
  const d = open();
  if (d.prepare('SELECT 1 FROM obj WHERE url = ?').get(url)) return ok(412); // like a server: already exists
  d.prepare('INSERT INTO obj (url, coll, data, etag) VALUES (?, ?, ?, ?)').run(url, coll, data, etag());
  return ok(201);
}

// Same etag check as a DAV server: someone else changed it meanwhile → 412
function update(url: string, tag: string | undefined, data: string): Response {
  const d = open();
  const cur = d.prepare('SELECT etag FROM obj WHERE url = ?').get(url) as { etag: string } | undefined;
  if (!cur) return ok(404);
  if (tag && cur.etag !== tag) return ok(412);
  d.prepare('UPDATE obj SET data = ?, etag = ? WHERE url = ?').run(data, etag(), url);
  return ok(204);
}

function remove(url: string): Response {
  open().prepare('DELETE FROM obj WHERE url = ?').run(url);
  return ok(204);
}

// The subset of DAVClient that the app uses
export function localClient(accountId: string, name: string): unknown {
  return {
    login: async () => {},
    fetchCalendars: async () =>
      collections(accountId, 'cal', name).map((c) => ({ url: c.url, displayName: c.name, calendarColor: c.color, components: ['VEVENT', 'VTODO'] })),
    // time range / filters: everything is local, the callers filter themselves (expandObject, UID match)
    fetchCalendarObjects: async ({ calendar }: { calendar: { url: string } }) => objects(calendar.url),
    createCalendarObject: async ({ calendar, filename, iCalString }: { calendar: { url: string }; filename: string; iCalString: string }) => create(calendar.url, filename, iCalString),
    updateCalendarObject: async ({ calendarObject: o }: { calendarObject: { url: string; etag?: string; data: string } }) => update(o.url, o.etag, o.data),
    deleteCalendarObject: async ({ calendarObject: o }: { calendarObject: { url: string } }) => remove(o.url),
    fetchAddressBooks: async () => collections(accountId, 'book', name).map((c) => ({ url: c.url, displayName: c.name })),
    fetchVCards: async ({ addressBook }: { addressBook: { url: string } }) => objects(addressBook.url),
    createVCard: async ({ addressBook, filename, vCardString }: { addressBook: { url: string }; filename: string; vCardString: string }) => create(addressBook.url, filename, vCardString),
    updateVCard: async ({ vCard: o }: { vCard: { url: string; etag?: string; data: string } }) => update(o.url, o.etag, o.data),
    deleteVCard: async ({ vCard: o }: { vCard: { url: string } }) => remove(o.url),
  };
}

// Renaming the account renames its calendar/address book too
export function renameLocal(accountId: string, name: string): void {
  open().prepare('UPDATE coll SET name = ? WHERE account_id = ?').run(name, accountId);
}

// Account removed → its local data goes too
export function forgetLocal(accountId: string): void {
  const d = open();
  d.prepare('DELETE FROM obj WHERE coll IN (SELECT url FROM coll WHERE account_id = ?)').run(accountId);
  d.prepare('DELETE FROM coll WHERE account_id = ?').run(accountId);
}

export function closeLocal(): void {
  db?.close();
  db = null;
}
