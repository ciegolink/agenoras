import { DAVAddressBook, DAVClient } from 'tsdav';
import { davError } from './caldav';
import ICAL from 'ical.js';
import crypto from 'node:crypto';
import { DavAccount, getDavAccount, getDavPassword, listDavAccounts } from './davaccounts';
import { getKv, setKv } from './cache';
import { t } from './i18n';
import { log } from './log';
import { isLocalDav, localClient } from './localdav';

export interface AddressBookInfo {
  id: string; // = address book URL
  accountId: string;
  accountName: string;
  name: string;
}

export interface Labeled {
  type: string; // work | home | cell | other …
  value: string;
}

export interface Contact {
  id: string; // = vCard URL
  bookId: string;
  accountId: string;
  name: string;
  firstName: string;
  lastName: string;
  org: string;
  title: string;
  emails: Labeled[];
  phones: Labeled[];
  note: string;
  birthday: string;
  photo?: string; // data: URL if the vCard has an embedded photo
}

export interface ContactInput {
  bookId: string;
  url?: string; // set = edit
  firstName: string;
  lastName: string;
  org: string;
  title: string;
  emails: string[];
  phones: string[];
  note: string;
  photo?: string | null; // undefined = unchanged, null = remove, data:image/...;base64,... = new photo
}

interface Conn {
  client: DAVClient;
  books: DAVAddressBook[];
}

const conns = new Map<string, Conn>();
const bookIndex = new Map<string, { accountId: string; book: DAVAddressBook }>();
const rawCards = new Map<string, { data: string; etag: string; bookId: string; contact: Contact }>();

const getAcc = (id: string) => getDavAccount('carddav', id);

function davClient(serverUrl: string, username: string, password: string): DAVClient {
  return new DAVClient({ serverUrl, credentials: { username, password }, authMethod: 'Basic', defaultAccountType: 'carddav' });
}

export async function testCardDav(serverUrl: string, username: string, password: string): Promise<void> {
  const client = davClient(serverUrl, username, password);
  await client.login();
  const books = await client.fetchAddressBooks();
  if (!books.length) throw new Error(t('err.noBooks'));
}

async function getConn(acc: DavAccount, refresh = false): Promise<Conn> {
  const existing = conns.get(acc.id);
  if (existing && !refresh) return existing;
  const client = isLocalDav(acc) ? (localClient(acc.id, acc.name) as DAVClient) : davClient(acc.serverUrl, acc.username, await getDavPassword('carddav', acc.id));
  await client.login();
  const conn = { client, books: await client.fetchAddressBooks() };
  conns.set(acc.id, conn);
  for (const book of conn.books) bookIndex.set(book.url, { accountId: acc.id, book });
  return conn;
}

export function forgetCardAccount(id: string): void {
  conns.delete(id);
  for (const [url, v] of bookIndex) if (v.accountId === id) bookIndex.delete(url);
}

// Read vCard
function typeOf(p: ICAL.Property): string {
  const raw = p.getParameter('type');
  const types = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((t) => String(t).toLowerCase());
  for (const t of ['cell', 'mobile', 'work', 'home', 'fax']) if (types.includes(t)) return t === 'mobile' ? 'cell' : t;
  return 'other';
}

function text(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.filter(Boolean).join(', ');
  return String(v);
}

// Photo from the vCard (v4: data: URI, v3: ENCODING=b + TYPE). Links to web servers are not loaded.
function photoOf(comp: ICAL.Component): string | undefined {
  const p = comp.getFirstProperty('photo');
  if (!p) return undefined;
  let v = p.getFirstValue() as unknown;
  if (v && typeof v === 'object' && 'value' in (v as object)) v = (v as { value: unknown }).value;
  const s = String(v ?? '').replace(/\s+/g, '');
  if (!s || s.length > 300_000) return undefined;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s)) return s;
  if (/^[a-z]+:/i.test(s)) return undefined; // http: or similar
  const type = String(p.getParameter('type') ?? 'jpeg').toLowerCase().replace(/^image\//, '');
  return `data:image/${/png|gif|webp/.test(type) ? type : 'jpeg'};base64,${s}`;
}

export function parseVCard(data: string, url: string, bookId: string, accountId: string): Contact | null {
  const jcal = ICAL.parse(data);
  const first = typeof jcal[0] === 'string' ? jcal : jcal[0];
  const comp = new ICAL.Component(first);
  if (comp.name !== 'vcard') return null;

  const n = comp.getFirstPropertyValue('n') as unknown;
  const parts = Array.isArray(n) ? n.map(text) : String(n ?? '').split(';');
  const lastName = parts[0] ?? '';
  const firstName = parts[1] ?? '';
  const fn = text(comp.getFirstPropertyValue('fn'));

  const emails = comp.getAllProperties('email').map((p) => ({ type: typeOf(p), value: text(p.getFirstValue()) })).filter((e) => e.value);
  const phones = comp
    .getAllProperties('tel')
    .map((p) => ({ type: typeOf(p), value: text(p.getFirstValue()).replace(/^tel:/i, '') }))
    .filter((t) => t.value);
  const org = comp.getFirstPropertyValue('org') as unknown;

  return {
    id: url,
    bookId,
    accountId,
    name: fn || [firstName, lastName].filter(Boolean).join(' ') || emails[0]?.value || t('contacts.unnamed'),
    firstName,
    lastName,
    org: Array.isArray(org) ? org.filter(Boolean).join(' · ') : text(org),
    title: text(comp.getFirstPropertyValue('title')),
    emails,
    phones,
    note: text(comp.getFirstPropertyValue('note')),
    birthday: text(comp.getFirstPropertyValue('bday')).slice(0, 10),
    photo: photoOf(comp),
  };
}

// Write vCard (line based so photo, address etc. are preserved)
const MANAGED = new Set(['FN', 'N', 'EMAIL', 'TEL', 'ORG', 'TITLE', 'NOTE', 'REV', 'PRODID', 'END']);

const escVal = (v: string) => v.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

function fold(line: string): string {
  if (line.length <= 74) return line;
  const out = [line.slice(0, 74)];
  for (let i = 74; i < line.length; i += 73) out.push(' ' + line.slice(i, i + 73));
  return out.join('\r\n');
}

function contactLines(input: ContactInput, prev?: Contact, v4 = false): string[] {
  const first = input.firstName.trim();
  const last = input.lastName.trim();
  const emails = input.emails.map((e) => e.trim()).filter(Boolean);
  const phones = input.phones.map((p) => p.trim()).filter(Boolean);
  const fn = [first, last].filter(Boolean).join(' ') || input.org.trim() || emails[0] || t('contacts.unnamed');
  const typeParam = (t?: string) => (t && t !== 'other' ? `;TYPE=${t.toUpperCase()}` : '');

  const lines = [`FN:${escVal(fn)}`, `N:${escVal(last)};${escVal(first)};;;`];
  if (input.org.trim()) lines.push(`ORG:${escVal(input.org.trim())}`);
  if (input.title.trim()) lines.push(`TITLE:${escVal(input.title.trim())}`);
  emails.forEach((e, i) => lines.push(`EMAIL${typeParam(prev?.emails[i]?.type)}:${escVal(e)}`));
  phones.forEach((p, i) => lines.push(`TEL${typeParam(prev?.phones[i]?.type)}:${escVal(p)}`));
  if (input.note.trim()) lines.push(`NOTE:${escVal(input.note.trim())}`);
  if (input.photo) {
    const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i.exec(input.photo);
    if (m) {
      const type = m[1].toLowerCase().replace('jpg', 'jpeg');
      lines.push(v4 ? `PHOTO:data:image/${type};base64,${m[2]}` : `PHOTO;ENCODING=b;TYPE=${type.toUpperCase()}:${m[2]}`);
    }
  }
  lines.push(`REV:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`);
  lines.push('PRODID:-//Agenoras//Agenoras//DE');
  return lines;
}

export function buildVCard(input: ContactInput, existing?: { data: string; contact: Contact }): string {
  let lines: string[];
  if (existing) {
    const kept = existing.data
      .replace(/\r?\n[ \t]/g, '') // unfold
      .split(/\r?\n/)
      .filter((l) => {
        if (!l) return false;
        const name = l.split(/[;:]/)[0].split('.').pop()!.toUpperCase();
        if (name === 'PHOTO' && input.photo !== undefined) return false; // photo replaced or removed
        return !MANAGED.has(name);
      });
    const v4 = /^VERSION:4/im.test(existing.data);
    lines = [...kept, ...contactLines(input, existing.contact, v4), 'END:VCARD'];
  } else {
    lines = ['BEGIN:VCARD', 'VERSION:3.0', `UID:${crypto.randomUUID()}`, ...contactLines(input), 'END:VCARD'];
  }
  return lines.map(fold).join('\r\n') + '\r\n';
}

// Fetch, save, delete
export async function listContacts(): Promise<{
  books: AddressBookInfo[];
  contacts: Contact[];
  errors: { accountId: string; message: string }[];
}> {
  const books: AddressBookInfo[] = [];
  const contacts: Contact[] = [];
  const errors: { accountId: string; message: string }[] = [];
  const cached = getKv<{ books: AddressBookInfo[]; contacts: Contact[] }>('contacts') ?? { books: [], contacts: [] };

  for (const acc of listDavAccounts('carddav')) {
    try {
      const { client, books: davBooks } = await getConn(acc, true);
      for (const book of davBooks) {
        const name = typeof book.displayName === 'string' && book.displayName ? book.displayName : t('view.contacts');
        books.push({ id: book.url, accountId: acc.id, accountName: acc.name, name });
        for (const card of await client.fetchVCards({ addressBook: book })) {
          if (typeof card.data !== 'string' || !card.data) continue;
          try {
            const c = parseVCard(card.data, card.url, book.url, acc.id);
            if (!c) continue;
            rawCards.set(card.url, { data: card.data, etag: card.etag ?? '', bookId: book.url, contact: c });
            contacts.push(c);
          } catch (err) {
            console.error('Unreadable vCard:', card.url, (err as Error).message);
          }
        }
      }
    } catch (err) {
      errors.push({ accountId: acc.id, message: davError(err) });
      log('error', 'CardDAV', acc.name, errors[errors.length - 1].message);
      books.push(...cached.books.filter((b) => b.accountId === acc.id)); // offline: cache
      contacts.push(...cached.contacts.filter((c) => c.accountId === acc.id));
    }
  }

  contacts.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  setKv('contacts', { books, contacts });
  return { books, contacts, errors };
}

export function cachedContacts(): { books: AddressBookInfo[]; contacts: Contact[] } {
  const accIds = new Set(listDavAccounts('carddav').map((a) => a.id));
  const c = getKv<{ books: AddressBookInfo[]; contacts: Contact[] }>('contacts') ?? { books: [], contacts: [] };
  return { books: c.books.filter((b) => accIds.has(b.accountId)), contacts: c.contacts.filter((x) => accIds.has(x.accountId)) };
}

async function check(res: Response): Promise<void> {
  if (!res.ok) throw new Error(res.status === 412 ? t('err.contactChanged') : `HTTP ${res.status} ${res.statusText}`);
}

async function connFor(bookId: string): Promise<{ client: DAVClient; book: DAVAddressBook }> {
  const entry = bookIndex.get(bookId);
  const acc = entry && getAcc(entry.accountId);
  if (!entry || !acc) throw new Error(t('err.bookUnreachable'));
  const { client } = await getConn(acc);
  return { client, book: entry.book };
}

export async function saveContact(input: ContactInput): Promise<void> {
  if (!input.firstName.trim() && !input.lastName.trim() && !input.org.trim()) throw new Error(t('err.nameRequired'));
  if (input.url) {
    const raw = rawCards.get(input.url);
    if (!raw) throw new Error(t('err.contactNotLoaded'));
    const { client } = await connFor(raw.bookId);
    await check(await client.updateVCard({ vCard: { url: input.url, etag: raw.etag, data: buildVCard(input, raw) } }));
    return;
  }
  const { client, book } = await connFor(input.bookId);
  const uid = crypto.randomUUID();
  await check(await client.createVCard({ addressBook: book, filename: `${uid}.vcf`, vCardString: buildVCard(input) }));
}

export async function deleteContact(url: string): Promise<void> {
  const raw = rawCards.get(url);
  if (!raw) throw new Error(t('err.contactNotLoaded'));
  const { client } = await connFor(raw.bookId);
  await check(await client.deleteVCard({ vCard: { url, etag: raw.etag } }));
  rawCards.delete(url);
}
