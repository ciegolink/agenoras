// Search for a date: "12.3.2024", "12.3.24", "12.3." or "12.3" (this year), "2024-03-12", "12/3/2024"
// (US region: month first), "März 2024", "march 2024", "mar 24". Returns the local day or month.
import { i18nData, region } from './i18n';

export interface DateRange {
  since: Date; // first day (local)
  before: Date; // first day after
}

const year = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

function day(y: number, m: number, d: number): DateRange | null {
  const since = new Date(y, m - 1, d);
  if (since.getFullYear() !== y || since.getMonth() !== m - 1 || since.getDate() !== d || y < 1990 || y > 2100) return null;
  return { since, before: new Date(y, m - 1, d + 1) };
}

// month names in the app language and in English, full and short ("märz", "mär", "march", "mar")
function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, '');
  for (const loc of [i18nData()?.locale || 'en', 'en', 'de']) {
    for (let m = 0; m < 12; m++) {
      const d = new Date(2024, m, 15);
      for (const style of ['long', 'short'] as const) {
        const name = d.toLocaleDateString(loc, { month: style }).toLowerCase().replace(/\.$/, '');
        if (name === w || (w.length >= 3 && name.startsWith(w))) return m;
      }
    }
  }
  return -1;
}

export function parseDateQuery(raw: string): DateRange | null {
  const q = raw.trim();
  let m = q.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return day(Number(m[1]), Number(m[2]), Number(m[3]));
  m = q.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4})?)?$/); // 30.10 / 30.10. / 30.10.26 / 30.10.2026
  if (m) return day(m[3] ? year(m[3]) : new Date().getFullYear(), Number(m[2]), Number(m[1]));
  m = q.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) return region() === 'US' ? day(year(m[3]), Number(m[1]), Number(m[2])) : day(year(m[3]), Number(m[2]), Number(m[1]));
  // a month: "März 2024", "mar 24"
  m = q.match(/^([\p{L}.]{3,})\s+(\d{2}|\d{4})$/u);
  if (m) {
    const mi = monthIndex(m[1]);
    if (mi < 0) return null;
    const y = year(m[2]);
    return { since: new Date(y, mi, 1), before: new Date(y, mi + 1, 1) };
  }
  // "12. März 2024", "12 march 2024"
  m = q.match(/^(\d{1,2})\.?\s+([\p{L}.]{3,})\s+(\d{2}|\d{4})$/u);
  if (m) {
    const mi = monthIndex(m[2]);
    return mi < 0 ? null : day(year(m[3]), mi + 1, Number(m[1]));
  }
  return null;
}
