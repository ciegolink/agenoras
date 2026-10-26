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

// choice: "de", "en" … or empty/"system" = system language
export function initI18n(choice?: string): I18nData {
  const sysLocale = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  const picked = choice && choice !== 'system' ? choice : '';
  const system = process.env.AGENORAS_LANG || picked || sysLocale;
  const code = system.toLowerCase().split(/[-_]/)[0];
  const lang = code !== 'en' && fs.existsSync(path.join(LANG_DIR, `${code}.json`)) ? code : 'en';
  const english = readLang('en');
  const strings = lang === 'en' ? english : { ...english, ...readLang(lang) };
  // Keep the regional variant (de-CH, de-DE, en-US …), otherwise a sensible default
  // Chosen manually: keep the region of the system setting if it matches (de → de-CH)
  const base = picked && sysLocale.toLowerCase().startsWith(lang) ? sysLocale : system;
  const locale = base.toLowerCase().startsWith(lang) && base.includes('-') ? base : lang === 'de' ? 'de-CH' : 'en-GB';
  data = { lang, locale, strings };
  return data;
}

export const i18nData = (): I18nData => data;

export function t(key: string, vars?: Record<string, string | number>): string {
  const s = data.strings[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}
