import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { decrypt, encrypt } from './accounts';
import { t } from './i18n';

// Shared storage for CalDAV (calendars.json) and CardDAV accounts (contacts.json)
export type DavKind = 'caldav' | 'carddav';

export interface DavAccount {
  id: string;
  name: string;
  serverUrl: string;
  username: string;
}

export type NewDavAccount = Omit<DavAccount, 'id'> & { password: string };

interface StoredDavAccount extends DavAccount {
  password: string; // encrypted
}

const file = (kind: DavKind) => path.join(app.getPath('userData'), kind === 'caldav' ? 'calendars.json' : 'contacts.json');

function readAll(kind: DavKind): StoredDavAccount[] {
  try {
    return JSON.parse(fs.readFileSync(file(kind), 'utf8'));
  } catch {
    return [];
  }
}

function writeAll(kind: DavKind, list: StoredDavAccount[]): void {
  fs.writeFileSync(file(kind), JSON.stringify(list, null, 2), 'utf8');
}

export function listDavAccounts(kind: DavKind): DavAccount[] {
  return readAll(kind).map(({ password, ...a }) => a);
}

export function getDavAccount(kind: DavKind, id: string): DavAccount | undefined {
  return listDavAccounts(kind).find((a) => a.id === id);
}

export async function getDavPassword(kind: DavKind, id: string): Promise<string> {
  const a = readAll(kind).find((x) => x.id === id);
  if (!a) throw new Error(t('err.accountNotFound'));
  return decrypt(a.password);
}

export async function addDavAccount(kind: DavKind, input: NewDavAccount): Promise<DavAccount> {
  const pass = await encrypt(input.password); // before reading: no await between read and write
  const all = readAll(kind);
  const acc: StoredDavAccount = {
    id: crypto.randomUUID(),
    name: input.name || new URL(input.serverUrl).hostname,
    serverUrl: input.serverUrl,
    username: input.username,
    password: pass,
  };
  all.push(acc);
  writeAll(kind, all);
  const { password, ...pub } = acc;
  return pub;
}

// Local account (no server): calendar or address book only on this computer, see localdav.ts
export async function addLocalDavAccount(kind: DavKind, name: string): Promise<DavAccount> {
  const pass = await encrypt('');
  const all = readAll(kind);
  const acc: StoredDavAccount = { id: crypto.randomUUID(), name: name.trim() || t('dav.localDefault'), serverUrl: 'local:', username: '', password: pass };
  all.push(acc);
  writeAll(kind, all);
  const { password, ...pub } = acc;
  return pub;
}

export function renameDavAccount(kind: DavKind, id: string, name: string): DavAccount {
  const all = readAll(kind);
  const acc = all.find((a) => a.id === id);
  if (!acc) throw new Error(t('err.accountNotFound'));
  acc.name = name.trim() || acc.name;
  writeAll(kind, all);
  const { password, ...pub } = acc;
  return pub;
}

export function removeDavAccount(kind: DavKind, id: string): void {
  writeAll(kind, readAll(kind).filter((a) => a.id !== id));
}

// Edit account: empty password = keep the current one
export async function updateDavAccount(kind: DavKind, id: string, input: Omit<NewDavAccount, 'password'> & { password?: string }): Promise<DavAccount> {
  const newPass = input.password ? await encrypt(input.password) : null;
  const all = readAll(kind);
  const i = all.findIndex((a) => a.id === id);
  if (i === -1) throw new Error(t('err.accountNotFound'));
  all[i] = {
    ...all[i],
    name: input.name || new URL(input.serverUrl).hostname,
    serverUrl: input.serverUrl,
    username: input.username,
    password: newPass ?? all[i].password,
  };
  writeAll(kind, all);
  const { password, ...pub } = all[i];
  return pub;
}
