// Export all settings into one file and import them on another computer (Settings → General).
// Accounts, calendars, address books and feeds come along without passwords, unless the user
// sets an export password: then the passwords travel AES-256-GCM encrypted with a key from that password.
// Not included: mails, the caches, POP3 mailboxes, window positions, private accounts.
import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { decrypt, encrypt } from './accounts';
import { t } from './i18n';
import { writeFileSafe } from './files';

const FORMAT = 'agenoras-settings';
const dir = () => app.getPath('userData');
const readJson = <T>(name: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), name), 'utf8')) as T;
  } catch {
    return fallback;
  }
};
const writeJson = (name: string, value: unknown) => writeFileSafe(path.join(dir(), name), JSON.stringify(value, null, 2));

type Item = Record<string, unknown> & { id: string };
// file, field that holds the password
const STORES = [
  { key: 'accounts', file: 'accounts.json', secret: 'pass' },
  { key: 'calendars', file: 'calendars.json', secret: 'password' },
  { key: 'contacts', file: 'contacts.json', secret: 'password' },
  { key: 'feeds', file: 'rss.json', secret: 'password' },
] as const;
type StoreKey = (typeof STORES)[number]['key'];

interface ExportFile {
  format: typeof FORMAT;
  version: 1;
  exported: string;
  app: string;
  settings: Record<string, unknown>;
  ai: { lang?: string; translateLang?: string };
  lists: Item[];
  accounts: Item[];
  calendars: Item[];
  contacts: Item[];
  feeds: Item[];
  secrets?: { salt: string; iv: string; tag: string; data: string };
}

const keyFrom = (password: string, salt: Buffer) => crypto.scryptSync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

export async function buildExport(password: string): Promise<string> {
  const secrets: Record<string, Record<string, string>> = {};
  const out: Partial<ExportFile> = { format: FORMAT, version: 1, exported: new Date().toISOString(), app: app.getVersion() };
  for (const s of STORES) {
    // private accounts stay on this computer: the file would give them away
    const list = readJson<Item[]>(s.file, []).filter((x) => !x.pin);
    secrets[s.key] = {};
    if (password) for (const x of list) if (x[s.secret]) secrets[s.key][x.id] = await decrypt(String(x[s.secret])).catch(() => '');
    out[s.key] = list.map(({ [s.secret]: _secret, ...rest }) => rest as Item);
  }
  const settings = readJson<Record<string, unknown>>('settings.json', {});
  const privateIds = new Set(readJson<Item[]>('accounts.json', []).filter((x) => x.pin).map((x) => x.id));
  out.settings = privateIds.size ? stripIds(settings, privateIds) : settings;
  const ai = readJson<{ lang?: string; translateLang?: string }>('ai.json', {});
  out.ai = { lang: ai.lang, translateLang: ai.translateLang };
  out.lists = readJson<Item[]>('lists.json', []);
  if (password) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', keyFrom(password, salt), iv);
    const data = Buffer.concat([c.update(JSON.stringify(secrets), 'utf8'), c.final()]);
    out.secrets = { salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  return JSON.stringify(out, null, 2);
}

// Things of private accounts out of the settings (identities, rules, notifications …)
function stripIds(settings: Record<string, unknown>, ids: Set<string>): Record<string, unknown> {
  const s = JSON.parse(JSON.stringify(settings));
  for (const k of ['identities', 'rules']) if (Array.isArray(s[k])) s[k] = s[k].filter((x: { accountId?: string }) => !ids.has(String(x?.accountId)));
  if (s.notify?.perAccount) for (const id of ids) delete s.notify.perAccount[id];
  if (Array.isArray(s.notify?.desktopOff)) s.notify.desktopOff = s.notify.desktopOff.filter((x: string) => !ids.has(x));
  if (s.offline) for (const id of ids) delete s.offline[id];
  return s;
}

export function readExport(file: string): ExportFile {
  let f: ExportFile;
  try {
    f = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(t('transfer.badFile'));
  }
  if (f?.format !== FORMAT || f.version !== 1) throw new Error(t('transfer.badFile'));
  return f;
}

export function summarize(f: ExportFile): { accounts: number; calendars: number; contacts: number; feeds: number; identities: number; rules: number; templates: number; hasSecrets: boolean; exported: string } {
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return { accounts: n(f.accounts), calendars: n(f.calendars), contacts: n(f.contacts), feeds: n(f.feeds), identities: n(f.settings?.identities), rules: n(f.settings?.rules), templates: n(f.settings?.templates), hasSecrets: !!f.secrets, exported: f.exported };
}

function openSecrets(f: ExportFile, password: string): Record<string, Record<string, string>> {
  if (!f.secrets || !password) return {};
  try {
    const s = f.secrets;
    const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(password, Buffer.from(s.salt, 'base64')), Buffer.from(s.iv, 'base64'));
    d.setAuthTag(Buffer.from(s.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8'));
  } catch {
    throw new Error(t('transfer.wrongPassword'));
  }
}

// Replace IDs (values and object keys) – an account that already exists here keeps its own ID
function remap<T>(value: T, ids: Map<string, string>): T {
  if (!ids.size) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return ids.get(v) ?? v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [ids.get(k) ?? k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

const isStr = (v: unknown) => typeof v === 'string' && v.length > 0;
const valid: Record<StoreKey, (x: Item | null | undefined) => x is Item> = {
  accounts: (x): x is Item => !!x && isStr(x.id) && isStr(x.email) && isStr(x.host) && Number.isFinite(Number(x.port)),
  calendars: (x): x is Item => !!x && isStr(x.id) && isStr(x.serverUrl),
  contacts: (x): x is Item => !!x && isStr(x.id) && isStr(x.serverUrl),
  feeds: (x): x is Item => !!x && isStr(x.id) && isStr(x.url),
};

// The same account already here? (same address and server, same calendar login, same feed)
const sameAs: Record<StoreKey, (a: Item, b: Item) => boolean> = {
  accounts: (a, b) => String(a.email).toLowerCase() === String(b.email).toLowerCase() && String(a.host).toLowerCase() === String(b.host).toLowerCase(),
  calendars: (a, b) => a.serverUrl === b.serverUrl && a.username === b.username,
  contacts: (a, b) => a.serverUrl === b.serverUrl && a.username === b.username,
  feeds: (a, b) => a.url === b.url,
};

// Merge: accounts are added (existing ones stay as they are), lists by ID, the preferences of the file win
export async function applyImport(f: ExportFile, password: string): Promise<{ added: number; skipped: number; withoutPassword: number }> {
  const secrets = openSecrets(f, password);
  const ids = new Map<string, string>();
  let added = 0;
  let skipped = 0;
  let withoutPassword = 0;
  const writes: [string, unknown][] = [];
  for (const s of STORES) {
    const here = readJson<Item[]>(s.file, []);
    for (const raw of Array.isArray(f[s.key]) ? f[s.key] : []) {
      // only complete entries: one broken account would make the whole accounts file unreadable
      if (!valid[s.key](raw)) continue;
      const { pin: _pin, ...x } = raw; // never private from a file
      void _pin;
      const twin = here.find((h) => h.id === x.id || sameAs[s.key](h, x));
      if (twin) {
        if (twin.id !== x.id) ids.set(x.id, twin.id);
        skipped++;
        continue;
      }
      const plain = secrets[s.key]?.[x.id] ?? '';
      // feeds without a login keep '' (= no login); everything else needs a password unless it is a local calendar
      const needs = s.key === 'feeds' ? !!x.username : x.serverUrl !== 'local:';
      if (!plain && needs) withoutPassword++;
      here.push({ ...x, [s.secret]: s.key === 'feeds' && !plain ? '' : await encrypt(plain) });
      added++;
    }
    writes.push([s.file, here]);
  }
  // preferences, identities, templates, rules, categories
  const mine = readJson<Record<string, unknown>>('settings.json', {});
  const theirs = remap(f.settings ?? {}, ids);
  const byId = (a: unknown, b: unknown) => {
    const x = Array.isArray(a) ? (a as Item[]) : [];
    const y = Array.isArray(b) ? (b as Item[]) : [];
    return [...y, ...x.filter((m) => !y.some((n) => n.id === m.id))];
  };
  const union = (a: unknown, b: unknown) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
  const notifyMine = (mine.notify ?? {}) as Record<string, unknown>;
  const notifyTheirs = (theirs.notify ?? {}) as Record<string, unknown>;
  writes.push([
    'settings.json',
    {
      ...mine,
      ...theirs,
      identities: byId(mine.identities, theirs.identities),
      templates: byId(mine.templates, theirs.templates),
      rules: byId(mine.rules, theirs.rules),
      labels: byId(mine.labels, theirs.labels),
      mailLabels: { ...(mine.mailLabels as object), ...(theirs.mailLabels as object) },
      trustedSenders: union(mine.trustedSenders, theirs.trustedSenders),
      imageMails: union(mine.imageMails, theirs.imageMails),
      offline: { ...(mine.offline as object), ...(theirs.offline as object) },
      notify: {
        ...notifyMine,
        ...notifyTheirs,
        perAccount: { ...(notifyMine.perAccount as object), ...(notifyTheirs.perAccount as object) },
        desktopOff: union(notifyMine.desktopOff, notifyTheirs.desktopOff),
      },
    },
  ]);
  writes.push(['lists.json', byId(readJson('lists.json', []), f.lists)]);
  const ai = readJson<Record<string, unknown>>('ai.json', {});
  if (f.ai) writes.push(['ai.json', { ...ai, ...(f.ai.lang ? { lang: f.ai.lang } : {}), ...(f.ai.translateLang !== undefined ? { translateLang: f.ai.translateLang } : {}) }]);
  for (const [file, value] of writes) writeJson(file, value);
  return { added, skipped, withoutPassword };
}
