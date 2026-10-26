import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { t } from './i18n';

export interface Account {
  id: string;
  name: string;
  email: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean; // true = SSL/TLS (465), false = STARTTLS (587)
  color: string;
}

export type NewAccount = Omit<Account, 'id' | 'color'> & { pass: string };

interface StoredAccount extends Account {
  pass: string; // encrypted (Windows: DPAPI, macOS: Keychain, Linux: libsecret)
}

const COLORS = ['#2BA89F', '#7FA6CF', '#C1C8BE', '#E0A458', '#B48EAD'];

const file = () => path.join(app.getPath('userData'), 'accounts.json');

function withDefaults(a: StoredAccount): StoredAccount {
  // Accounts from step 1 have no SMTP settings yet
  return {
    ...a,
    smtpHost: a.smtpHost || a.host.replace(/^imap\./i, 'smtp.'),
    smtpPort: a.smtpPort || 465,
    smtpSecure: a.smtpSecure ?? true,
  };
}

function readAll(): StoredAccount[] {
  try {
    return (JSON.parse(fs.readFileSync(file(), 'utf8')) as StoredAccount[]).map(withDefaults);
  } catch {
    return [];
  }
}

function writeAll(list: StoredAccount[]): void {
  fs.writeFileSync(file(), JSON.stringify(list, null, 2), 'utf8');
}

export function encrypt(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(plain).toString('base64');
  }
  return 'plain:' + Buffer.from(plain, 'utf8').toString('base64');
}

export function decrypt(stored: string): string {
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    } catch {
      // e.g. keychain entry from a previous app name → the password has to be entered again
      throw new Error(t('err.passwordReenter'));
    }
  }
  return Buffer.from(stored.replace(/^plain:/, ''), 'base64').toString('utf8');
}

export function listAccounts(): Account[] {
  return readAll().map(({ pass, ...acc }) => acc);
}

export function getAccount(id: string): Account | undefined {
  return listAccounts().find((a) => a.id === id);
}

export function getPassword(id: string): string {
  const acc = readAll().find((a) => a.id === id);
  if (!acc) throw new Error(t('err.accountNotFound'));
  return decrypt(acc.pass);
}

export function addAccount(input: NewAccount): Account {
  const all = readAll();
  const acc: StoredAccount = {
    id: crypto.randomUUID(),
    name: input.name || input.email,
    email: input.email,
    host: input.host,
    port: input.port,
    secure: input.secure,
    user: input.user,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    color: COLORS[all.length % COLORS.length],
    pass: encrypt(input.pass),
  };
  all.push(acc);
  writeAll(all);
  const { pass, ...pub } = acc;
  return pub;
}

export function removeAccount(id: string): void {
  writeAll(readAll().filter((a) => a.id !== id));
}

// Edit account: empty password = keep the current one
export type AccountUpdate = Omit<Account, 'id' | 'color'> & { pass?: string; color?: string };

export function updateAccount(id: string, input: AccountUpdate): Account {
  const all = readAll();
  const i = all.findIndex((a) => a.id === id);
  if (i === -1) throw new Error(t('err.accountNotFound'));
  const old = all[i];
  all[i] = {
    ...old,
    name: input.name || input.email,
    email: input.email,
    host: input.host,
    port: input.port,
    secure: input.secure,
    user: input.user,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    color: input.color || old.color,
    pass: input.pass ? encrypt(input.pass) : old.pass,
  };
  writeAll(all);
  const { pass, ...pub } = all[i];
  return pub;
}
