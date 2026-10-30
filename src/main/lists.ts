import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { t } from './i18n';

// Distribution lists, only stored in this app (lists.json), never on a server

export interface ListMember {
  name: string;
  address: string;
}

export interface MailList {
  id: string;
  name: string;
  members: ListMember[];
}

const file = () => path.join(app.getPath('userData'), 'lists.json');

export function getLists(): MailList[] {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return [];
  }
}

function writeLists(lists: MailList[]): void {
  fs.writeFileSync(file(), JSON.stringify(lists, null, 2), 'utf8');
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function saveList(input: MailList): MailList[] {
  const name = String(input?.name ?? '').trim();
  if (!name) throw new Error(t('lists.nameRequired'));
  const seen = new Set<string>();
  const members = (Array.isArray(input.members) ? input.members : [])
    .map((m) => ({ name: String(m?.name ?? '').trim(), address: String(m?.address ?? '').trim() }))
    .filter((m) => EMAIL.test(m.address) && !seen.has(m.address.toLowerCase()) && seen.add(m.address.toLowerCase()));
  const lists = getLists();
  const i = lists.findIndex((l) => l.id === input.id);
  const list = { id: i >= 0 ? lists[i].id : String(input.id || crypto.randomUUID()), name, members };
  if (i >= 0) lists[i] = list;
  else lists.push(list);
  lists.sort((a, b) => a.name.localeCompare(b.name));
  writeLists(lists);
  return lists;
}

export function removeList(id: string): MailList[] {
  const lists = getLists().filter((l) => l.id !== id);
  writeLists(lists);
  return lists;
}
