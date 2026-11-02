import fs from 'node:fs';
import path from 'node:path';

// Language files live in lang/<code>.json (e.g. de.json, en.json).
// The system language is used; if there is no file for it, English applies.
// Missing keys in a language fall back to English.
// Can be overridden for testing with the environment variable AGENORAS_LANG (e.g. "en").

const LANG_DIR = path.join(__dirname, '../../lang');

export interface I18nData {
  lang: string; // "de", "en", …
  locale: string; // for date/number formats, e.g. "de-CH"
  strings: Record<string, string>;
}

let data: I18nData = { lang: 'en', locale: 'en-GB', strings: {} };

function readLang(code: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(path.join(LANG_DIR, `${code}.json`), 'utf8'));
  } catch {
    return {};
  }
}

// Available languages (lang/*.json)
export function availableLanguages(): string[] {
  try {
    return fs.readdirSync(LANG_DIR).filter((f) => /^[a-z]{2}\.json$/.test(f)).map((f) => f.slice(0, 2)).sort();
  } catch {
    return ['de', 'en'];
  }
}

// System language and region formats can differ (e.g. English UI, Swiss dates and numbers).
// Linux keeps the formats in LC_TIME & co. (GNOME "Formats"), the language in LC_MESSAGES / LANG;
// Windows and macOS report the region format as the default locale.
const fromEnv = (v?: string) => (v && !/^(C|POSIX)\b/.test(v) ? v.split(/[.@]/)[0].replace('_', '-') : '');
function systemLanguage(): string {
  const env = process.platform === 'linux' ? fromEnv(process.env.LC_ALL) || fromEnv(process.env.LC_MESSAGES) || fromEnv(process.env.LANG) : '';
  return env || Intl.DateTimeFormat().resolvedOptions().locale || 'en';
}
function formatLocale(): string {
  const env = process.platform === 'linux' ? fromEnv(process.env.LC_ALL) || fromEnv(process.env.LC_TIME) || fromEnv(process.env.LANG) : '';
  return env || Intl.DateTimeFormat().resolvedOptions().locale || 'en';
}

// choice: "de", "en" … or empty/"system" = system language
export function initI18n(choice?: string): I18nData {
  const picked = choice && choice !== 'system' ? choice : '';
  const system = process.env.AGENORAS_LANG || picked || systemLanguage();
  const code = system.toLowerCase().split(/[-_]/)[0];
  const lang = code !== 'en' && fs.existsSync(path.join(LANG_DIR, `${code}.json`)) ? code : 'en';
  const english = readLang('en');
  const strings = lang === 'en' ? english : { ...english, ...readLang(lang) };
  // Formats: the app language with the region of the format setting (en + CH → en-CH: English
  // month names, Swiss date and number format); without a region a sensible default
  const region = formatLocale().split('-')[1]?.toUpperCase() ?? '';
  const wanted = region ? `${lang}-${region}` : '';
  const locale = wanted && Intl.DateTimeFormat.supportedLocalesOf(wanted).length ? wanted : lang === 'de' ? 'de-CH' : 'en-GB';
  data = { lang, locale, strings };
  return data;
}

export const i18nData = (): I18nData => data;

// Locale for Chromium itself: it formats date and time fields (dd.mm.yyyy …) by its own language,
// so it gets the system's region format (de-CH), not the app language with the region (en-CH)
export function chromiumLocale(): string {
  const f = process.env.AGENORAS_LANG ? '' : formatLocale();
  return f.includes('-') && Intl.DateTimeFormat.supportedLocalesOf(f).length ? f : data.locale;
}

// Region of the format setting ("CH", "DE", "US" …), '' if unknown
export const region = () => data.locale.split('-')[1]?.toUpperCase() ?? '';

// German spelling of the region: Switzerland and Liechtenstein write "ss", everyone else "ß"
export const germanVariant = () => (['CH', 'LI'].includes(region()) ? 'de-CH' : region() ? 'de-DE' : 'de-CH');

// First day of the week in the region (1 = Monday, 0 = Sunday, 6 = Saturday)
export function regionWeekStart(): number {
  try {
    const loc = new Intl.Locale(data.locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const first = (loc.getWeekInfo?.() ?? loc.weekInfo)?.firstDay ?? 1;
    return first === 7 ? 0 : first === 6 ? 6 : 1;
  } catch {
    return 1;
  }
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const s = data.strings[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}
