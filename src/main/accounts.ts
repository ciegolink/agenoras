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
  protocol?: 'imap' | 'pop3'; // incoming mail (missing = IMAP)
  leaveOnServer?: boolean; // POP3: keep a copy on the server (default yes)
  deleteAfterDays?: number; // POP3 + copy on the server: delete it there after this many days (0 = never)
  private?: boolean; // protected by a PIN – invisible while locked
  autoLockMin?: number; // private: lock after this many minutes without use
}

export type NewAccount = Omit<Account, 'id' | 'color' | 'private'> & { pass: string; color?: string; pin?: string };

interface StoredAccount extends Account {
  pass: string; // encrypted (Windows: DPAPI, macOS: Keychain, Linux: libsecret)
  pin?: { salt: string; hash: string }; // scrypt hash of the PIN (private accounts)
}

const COLORS = ['#2BA89F', '#7FA6CF', '#C1C8BE', '#E0A458', '#B48EAD'];
const isColor = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

const file = () => path.join(app.getPath('userData'), 'accounts.json');

const POP_DAYS = [0, 7, 14, 30, 90, 365];
// Incoming-mail settings from the dialog, checked
function protocolFields(input: { protocol?: unknown; leaveOnServer?: unknown; deleteAfterDays?: unknown }): Pick<Account, 'protocol' | 'leaveOnServer' | 'deleteAfterDays'> {
  if (input.protocol !== 'pop3') return { protocol: 'imap' };
  return { protocol: 'pop3', leaveOnServer: input.leaveOnServer !== false, deleteAfterDays: POP_DAYS.includes(Number(input.deleteAfterDays)) ? Number(input.deleteAfterDays) : 0 };
}

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

export async function encrypt(plain: string): Promise<string> {
  if (await safeStorage.isAsyncEncryptionAvailable()) {
    return 'enc:' + (await safeStorage.encryptStringAsync(plain)).toString('base64');
  }
  return 'plain:' + Buffer.from(plain, 'utf8').toString('base64');
}

// Also reads values written by the old synchronous encryptString
export async function decrypt(stored: string): Promise<string> {
  if (stored.startsWith('enc:')) {
    try {
      return (await safeStorage.decryptStringAsync(Buffer.from(stored.slice(4), 'base64'))).result;
    } catch {
      // e.g. keychain entry from a previous app name → the password has to be entered again
      throw new Error(t('err.passwordReenter'));
    }
  }
  return Buffer.from(stored.replace(/^plain:/, ''), 'base64').toString('utf8');
}

// ---------- Private accounts (PIN) ----------
// Unlocked state lives only in memory: after a restart every private account is locked again.
// Locked accounts are left out of listAccounts/getAccount, so every IPC handler treats them as non-existent.

const unlocked = new Set<string>();
const isLockedRaw = (a: StoredAccount) => !!a.pin && !unlocked.has(a.id);
export const PIN_RE = /^\d{4,8}$/;
export const AUTOLOCK_DEFAULT = 5;
const AUTOLOCK_CHOICES = [1, 2, 5, 10, 15, 30];

function hashPin(pin: string, salt = crypto.randomBytes(16).toString('base64')): { salt: string; hash: string } {
  return { salt, hash: crypto.scryptSync(pin, salt, 32).toString('base64') };
}

function pinMatches(a: StoredAccount, pin: string): boolean {
  if (!a.pin) return false;
  const want = Buffer.from(a.pin.hash, 'base64');
  const got = Buffer.from(hashPin(pin, a.pin.salt).hash, 'base64');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const lockMinutes = (n: unknown) => (AUTOLOCK_CHOICES.includes(Number(n)) ? Number(n) : AUTOLOCK_DEFAULT);

function toPublic({ pass, pin, ...acc }: StoredAccount): Account {
  return pin ? { ...acc, private: true, autoLockMin: lockMinutes(acc.autoLockMin) } : { ...acc, private: false };
}

// Every account incl. locked ones – only for housekeeping, never hand it to the UI
export function listAllAccounts(): Account[] {
  return readAll().map(toPublic);
}

export function listAccounts(): Account[] {
  return readAll()
    .filter((a) => !isLockedRaw(a))
    .map(toPublic);
}

export function getAccount(id: string): Account | undefined {
  return listAccounts().find((a) => a.id === id);
}

export async function getPassword(id: string): Promise<string> {
  const acc = readAll().find((a) => a.id === id);
  if (!acc || isLockedRaw(acc)) throw new Error(t('err.accountNotFound'));
  return decrypt(acc.pass);
}

// How many private accounts are locked / unlocked (no names – they stay hidden)
export function privacyState(): { locked: number; unlocked: number } {
  const priv = readAll().filter((a) => a.pin);
  const locked = priv.filter(isLockedRaw).length;
  return { locked, unlocked: priv.length - locked };
}

// Brute-force brake: from the 5th wrong PIN on, waiting time doubles (30 s … 15 min)
let pinFails = 0;
let pinBlockedUntil = 0;

export function unlockWithPin(pin: string): Account[] {
  const wait = Math.ceil((pinBlockedUntil - Date.now()) / 1000);
  if (wait > 0) throw new Error(t('err.pinWait', { s: wait }));
  const hits = readAll().filter((a) => isLockedRaw(a) && pinMatches(a, String(pin ?? '')));
  if (!hits.length) {
    pinFails++;
    if (pinFails >= 5) pinBlockedUntil = Date.now() + Math.min(30_000 * 2 ** (pinFails - 5), 15 * 60_000);
    throw new Error(t('err.pinWrong'));
  }
  pinFails = 0;
  for (const a of hits) unlocked.add(a.id);
  return hits.map(toPublic);
}

// Lock the given (or all) private accounts; returns the IDs that were open
export function lockAccounts(ids?: string[]): string[] {
  const closed = [...unlocked].filter((id) => !ids || ids.includes(id));
  for (const id of closed) unlocked.delete(id);
  return closed;
}

export const unlockedPrivate = () => readAll().filter((a) => a.pin && unlocked.has(a.id)).map(toPublic);

// Make an (unlocked) account private, change the PIN/auto-lock or remove the protection.
// pin: new PIN · '' = keep the current one · null = no longer private
export function setPrivacy(id: string, pin: string | null, autoLockMin?: number): Account {
  const all = readAll();
  const acc = all.find((a) => a.id === id);
  if (!acc || isLockedRaw(acc)) throw new Error(t('err.accountNotFound'));
  if (pin === null) {
    delete acc.pin;
    delete acc.autoLockMin;
    unlocked.delete(id);
  } else {
    if (pin) {
      if (!PIN_RE.test(pin)) throw new Error(t('err.pinFormat'));
      acc.pin = hashPin(pin);
    } else if (!acc.pin) {
      throw new Error(t('err.pinFormat'));
    }
    acc.autoLockMin = lockMinutes(autoLockMin);
    unlocked.add(id); // you just set it up – stays open until the next lock
  }
  writeAll(all);
  return toPublic(acc);
}

export async function addAccount(input: NewAccount): Promise<Account> {
  const pass = await encrypt(input.pass); // before reading: no await between read and write
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
    color: isColor(input.color) ? input.color : COLORS[all.length % COLORS.length],
    ...protocolFields(input),
    pass,
  };
  if (input.pin) {
    if (!PIN_RE.test(input.pin)) throw new Error(t('err.pinFormat'));
    acc.pin = hashPin(input.pin);
    acc.autoLockMin = lockMinutes(input.autoLockMin);
    unlocked.add(acc.id);
  }
  all.push(acc);
  writeAll(all);
  return toPublic(acc);
}

export function removeAccount(id: string): void {
  writeAll(readAll().filter((a) => a.id !== id));
  unlocked.delete(id);
}

// Edit account: empty password = keep the current one
export type AccountUpdate = Omit<Account, 'id' | 'color' | 'private' | 'autoLockMin'> & { pass?: string; color?: string };

export async function updateAccount(id: string, input: AccountUpdate): Promise<Account> {
  const newPass = input.pass ? await encrypt(input.pass) : null;
  const all = readAll();
  const i = all.findIndex((a) => a.id === id);
  if (i === -1) throw new Error(t('err.accountNotFound'));
  const old = all[i];
  if (isLockedRaw(old)) throw new Error(t('err.accountNotFound'));
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
    color: isColor(input.color) ? input.color : old.color,
    ...protocolFields(input),
    pass: newPass ?? old.pass,
  };
  writeAll(all);
  return toPublic(all[i]);
}

// Only the colour (no reconnect needed)
export function setAccountColor(id: string, color: string): Account {
  if (!isColor(color)) throw new Error('Invalid colour');
  const all = readAll();
  const acc = all.find((a) => a.id === id);
  if (!acc || isLockedRaw(acc)) throw new Error(t('err.accountNotFound'));
  acc.color = color;
  writeAll(all);
  return toPublic(acc);
}
