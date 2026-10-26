import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listAccounts } from './accounts';
import { t } from './i18n';

// Sender identities: per account the main address plus any aliases (e.g. info@…),
// each with its own signature. Mail is always sent via the account's SMTP login.
export interface Identity {
  id: string;
  accountId: string;
  name: string;
  email: string;
  signature: string; // plain-text signature
  signatureHtml?: string; // HTML signature (takes precedence), images embedded as data: URLs
  primary: boolean;
}

export interface Template {
  id: string;
  name: string;
  subject: string;
  body: string; // plain text
  html?: string; // formatted (saved from the editor)
}

export type Theme = 'dark' | 'light' | 'system';

interface Settings {
  identities: Identity[];
  templates: Template[];
  theme: Theme;
  trustedSenders: string[]; // always load external images (addresses, lower case)
  imageMails: string[]; // single mails where "Load images" was clicked (Message-ID)
  labels: MailLabel[]; // categories
  mailLabels: Record<string, string[]>; // Message-ID → category IDs
  notify: NotifySettings;
  uiScale: UiScale; // font size
  language: string; // 'system' | 'de' | 'en' …
  weekStart: number; // 1 = Monday, 0 = Sunday, 6 = Saturday
  sendDelay: number; // seconds to undo when sending (0–5)
  accountLabel: 'name' | 'email'; // mailboxes in the sidebar/list by name or address
  externalMark: boolean; // mark mails from outside the own domains
  internalDomains: string[]; // additional domains that count as internal
  rules: MailRule[]; // mail rules
}

// ---------- Mail rules ----------
export interface RuleCondition {
  field: 'from' | 'to' | 'subject' | 'any';
  op: 'contains' | 'equals' | 'startsWith' | 'endsWith';
  value: string;
}

export interface MailRule {
  id: string;
  name: string;
  enabled: boolean;
  accountId: string; // '' = all accounts (moving only with an account)
  match: 'all' | 'any';
  conditions: RuleCondition[];
  hasAttachment: boolean;
  actions: { move?: string; read?: boolean; flag?: boolean; label?: string; delete?: boolean; spam?: boolean };
  stop: boolean; // apply no further rules
}

export type UiScale = 'small' | 'medium' | 'large';
export const SCALE_FACTOR: Record<UiScale, number> = { small: 0.9, medium: 1, large: 1.12 };

// Sound for new mail. Value: '' = default (per account only), 'none' = silent, 'builtin' = built-in sound, otherwise sound ID
export interface MailLabel {
  id: string;
  name: string;
  color: string;
}

export interface NotifySettings {
  enabled: boolean;
  sound: string;
  volume: number; // 0–1
  perAccount: Record<string, string>;
  desktop: boolean; // desktop notification for new mail
  desktopOff: string[]; // accounts without desktop notifications
  background: boolean; // X only closes the window, the app keeps running in the tray
  sentSound: string; // sound when a mail was sent ('none' = silent)
}

const DEFAULT_NOTIFY: NotifySettings = { enabled: true, sound: 'builtin', volume: 0.7, perAccount: {}, desktop: true, desktopOff: [], background: true, sentSound: 'app:sentMail_Ding.wav' };

const THEMES: Theme[] = ['dark', 'light', 'system'];

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const file = () => path.join(app.getPath('userData'), 'settings.json');

function read(): Settings {
  try {
    const s = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return {
      identities: s.identities ?? [],
      templates: s.templates ?? [],
      theme: THEMES.includes(s.theme) ? s.theme : 'dark',
      trustedSenders: Array.isArray(s.trustedSenders) ? s.trustedSenders : [],
      imageMails: Array.isArray(s.imageMails) ? s.imageMails : [],
      labels: Array.isArray(s.labels) ? s.labels : [],
      uiScale: ['small', 'medium', 'large'].includes(s.uiScale) ? s.uiScale : 'medium',
      language: typeof s.language === 'string' && /^(system|[a-z]{2})$/.test(s.language) ? s.language : 'system',
      weekStart: [0, 1, 6].includes(s.weekStart) ? s.weekStart : 1,
      sendDelay: Number.isFinite(s.sendDelay) ? Math.min(5, Math.max(0, Math.round(s.sendDelay))) : 2,
      accountLabel: s.accountLabel === 'name' ? 'name' : 'email',
      externalMark: s.externalMark === true,
      internalDomains: Array.isArray(s.internalDomains) ? s.internalDomains.filter((d: unknown) => typeof d === 'string') : [],
      rules: Array.isArray(s.rules) ? s.rules : [],
      mailLabels: s.mailLabels && typeof s.mailLabels === 'object' ? s.mailLabels : {},
      notify: { ...DEFAULT_NOTIFY, ...(s.notify ?? {}), perAccount: { ...(s.notify?.perAccount ?? {}) }, desktopOff: [...(s.notify?.desktopOff ?? [])] },
    };
  } catch {
    return { identities: [], templates: [], theme: 'dark', trustedSenders: [], imageMails: [], labels: [], mailLabels: {}, uiScale: 'medium', language: 'system', weekStart: 1, sendDelay: 2, accountLabel: 'email', externalMark: false, internalDomains: [], rules: [], notify: { ...DEFAULT_NOTIFY, perAccount: {}, desktopOff: [] } };
  }
}

function write(s: Settings): void {
  fs.writeFileSync(file(), JSON.stringify(s, null, 2), 'utf8');
}

// Every account's main address always exists; identities of removed accounts are dropped
export function getSettings(): Settings {
  const s = read();
  const accounts = listAccounts();
  const ids = new Set(accounts.map((a) => a.id));
  let identities = s.identities.filter((i) => ids.has(i.accountId));
  for (const acc of accounts) {
    const primary = identities.find((i) => i.accountId === acc.id && i.primary);
    if (!primary) {
      identities.push({ id: `${acc.id}:main`, accountId: acc.id, name: acc.name, email: acc.email, signature: '', primary: true });
    } else {
      primary.email = acc.email; // main address always follows the account
    }
  }
  // Order: by account, main address first
  const order = new Map(accounts.map((a, i) => [a.id, i]));
  identities = identities.sort((a, b) => (order.get(a.accountId)! - order.get(b.accountId)!) || Number(b.primary) - Number(a.primary));
  return { ...s, identities };
}

export function getIdentity(id: string): Identity | undefined {
  return getSettings().identities.find((i) => i.id === id);
}

export function saveIdentities(list: Identity[]): Identity[] {
  const accounts = new Set(listAccounts().map((a) => a.id));
  const seen = new Set<string>();
  const clean: Identity[] = [];
  for (const i of list ?? []) {
    if (!accounts.has(i.accountId)) continue;
    const email = String(i.email ?? '').trim();
    if (!EMAIL_RE.test(email)) throw new Error(t('err.invalidSender', { email: email || '–' }));
    const key = `${i.accountId}|${email.toLowerCase()}`;
    if (seen.has(key)) throw new Error(t('err.duplicateAddress', { email }));
    seen.add(key);
    clean.push({
      id: i.id || crypto.randomUUID(),
      accountId: i.accountId,
      name: String(i.name ?? '').trim(),
      email,
      signature: String(i.signature ?? ''),
      ...(i.signatureHtml && String(i.signatureHtml).trim() ? { signatureHtml: String(i.signatureHtml) } : {}),
      primary: !!i.primary,
    });
  }
  const s = read();
  write({ ...s, identities: clean });
  return getSettings().identities;
}

export function saveTemplates(list: Template[]): Template[] {
  const clean = (list ?? [])
    .map((t) => ({
      id: t.id || crypto.randomUUID(),
      name: String(t.name ?? '').trim(),
      subject: String(t.subject ?? ''),
      body: String(t.body ?? ''),
      ...(t.html ? { html: String(t.html) } : {}),
    }))
    .filter((t) => t.name);
  const s = read();
  write({ ...s, templates: clean });
  return clean;
}

export function saveTheme(theme: Theme): Theme {
  const value = THEMES.includes(theme) ? theme : 'dark';
  write({ ...read(), theme: value });
  return value;
}

export function isTrustedSender(email: string): boolean {
  return !!email && read().trustedSenders.includes(email.toLowerCase());
}

export function trustSender(email: string): void {
  const e = String(email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return;
  const s = read();
  if (!s.trustedSenders.includes(e)) write({ ...s, trustedSenders: [...s.trustedSenders, e] });
}

// Remember "Load images" for a single mail (the last 2000)
export function imagesAllowed(key: string): boolean {
  return !!key && read().imageMails.includes(key);
}

export function allowImages(key: string): void {
  if (!key) return;
  const s = read();
  if (s.imageMails.includes(key)) return;
  write({ ...s, imageMails: [...s.imageMails, key].slice(-2000) });
}

export function saveNotify(n: NotifySettings): NotifySettings {
  const clean: NotifySettings = {
    enabled: !!n?.enabled,
    sound: String(n?.sound ?? 'builtin'),
    volume: Math.min(1, Math.max(0, Number(n?.volume ?? 0.7))),
    perAccount: Object.fromEntries(Object.entries(n?.perAccount ?? {}).filter(([, v]) => typeof v === 'string' && v).map(([k, v]) => [k, String(v)])),
    desktop: n?.desktop !== false,
    desktopOff: Array.isArray(n?.desktopOff) ? n.desktopOff.map(String) : [],
    background: n?.background !== false,
    sentSound: typeof n?.sentSound === 'string' && n.sentSound ? n.sentSound : DEFAULT_NOTIFY.sentSound,
  };
  write({ ...read(), notify: clean });
  return clean;
}

// ---------- Categories (stored locally, per mail via Message-ID) ----------

export function saveLabels(list: MailLabel[]): MailLabel[] {
  const clean = (list ?? [])
    .map((l) => ({ id: String(l.id || crypto.randomUUID()), name: String(l.name ?? '').trim().slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(l.color) ? l.color : '#2BA89F' }))
    .filter((l) => l.name);
  const s = read();
  const ids = new Set(clean.map((l) => l.id));
  // remove deleted categories from the mails too
  const mailLabels: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(s.mailLabels)) {
    const keep = v.filter((id) => ids.has(id));
    if (keep.length) mailLabels[k] = keep;
  }
  write({ ...s, labels: clean, mailLabels });
  return clean;
}

export function setMailLabel(keys: string[], labelId: string, on: boolean): Record<string, string[]> {
  const s = read();
  if (!s.labels.some((l) => l.id === labelId)) return s.mailLabels;
  const map = { ...s.mailLabels };
  for (const k of keys ?? []) {
    if (!k) continue;
    const cur = new Set(map[k] ?? []);
    if (on) cur.add(labelId);
    else cur.delete(labelId);
    if (cur.size) map[k] = [...cur];
    else delete map[k];
  }
  write({ ...s, mailLabels: map });
  return map;
}

// Appearance / language / week start (saved individually)
export function savePrefs(p: { uiScale?: UiScale; language?: string; weekStart?: number; sendDelay?: number; externalMark?: boolean; internalDomains?: string[]; accountLabel?: 'name' | 'email' }): void {
  const s = read();
  write({
    ...s,
    ...(p.uiScale && ['small', 'medium', 'large'].includes(p.uiScale) ? { uiScale: p.uiScale } : {}),
    ...(typeof p.language === 'string' && /^(system|[a-z]{2})$/.test(p.language) ? { language: p.language } : {}),
    ...([0, 1, 6].includes(Number(p.weekStart)) && p.weekStart !== undefined ? { weekStart: Number(p.weekStart) } : {}),
    ...(p.sendDelay !== undefined && Number.isFinite(Number(p.sendDelay)) ? { sendDelay: Math.min(5, Math.max(0, Math.round(Number(p.sendDelay)))) } : {}),
    ...(typeof p.externalMark === 'boolean' ? { externalMark: p.externalMark } : {}),
    ...(p.accountLabel === 'name' || p.accountLabel === 'email' ? { accountLabel: p.accountLabel } : {}),
    ...(Array.isArray(p.internalDomains)
      ? { internalDomains: [...new Set(p.internalDomains.map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))].slice(0, 50) }
      : {}),
  });
}

// For startup (before the language is loaded): read only the language choice
export function savedLanguage(): string {
  return read().language;
}

export function saveRules(list: MailRule[]): MailRule[] {
  const clean: MailRule[] = (list ?? []).map((r) => ({
    id: String(r.id || crypto.randomUUID()),
    name: String(r.name ?? '').trim().slice(0, 80),
    enabled: r.enabled !== false,
    accountId: String(r.accountId ?? ''),
    match: r.match === 'any' ? 'any' : 'all',
    conditions: (r.conditions ?? [])
      .map((c) => ({
        field: (['from', 'to', 'subject', 'any'].includes(c.field) ? c.field : 'from') as RuleCondition['field'],
        op: (['contains', 'equals', 'startsWith', 'endsWith'].includes(c.op) ? c.op : 'contains') as RuleCondition['op'],
        value: String(c.value ?? '').trim(),
      }))
      .filter((c) => c.value),
    hasAttachment: !!r.hasAttachment,
    actions: {
      ...(r.actions?.move && r.accountId ? { move: String(r.actions.move) } : {}),
      ...(r.actions?.read ? { read: true } : {}),
      ...(r.actions?.flag ? { flag: true } : {}),
      ...(r.actions?.label ? { label: String(r.actions.label) } : {}),
      ...(r.actions?.delete ? { delete: true } : {}),
      ...(r.actions?.spam ? { spam: true } : {}),
    },
    stop: !!r.stop,
  }));
  write({ ...read(), rules: clean });
  return clean;
}
