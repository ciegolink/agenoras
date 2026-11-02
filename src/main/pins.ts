import { getKv, setKv } from './cache';

// Pinned items (tasks, feed articles) for the pin sidebar. A copy for reading, the main window keeps tasks up to date.

export interface PinMeta {
  text: string;
  cls?: string; // e.g. overdue / today
}

export interface PinItem {
  key: string; // task:<id> | feed:<key> | mail:<account>|<folder>|<uid>
  kind: 'task' | 'feed' | 'mail';
  title: string;
  text: string;
  meta: PinMeta[];
  color: string;
  link?: string;
  done?: boolean;
  collapsed?: boolean;
  mail?: { accountId: string; folder: string; uid: number }; // mails: only the subject, opened in their own window
}

const MAX = 50;
const str = (v: unknown, max: number) => String(v ?? '').slice(0, max);

function clean(x: PinItem): PinItem {
  return {
    key: str(x.key, 600),
    kind: x.kind === 'feed' || x.kind === 'mail' ? x.kind : 'task',
    title: str(x.title, 500),
    text: str(x.text, 20_000),
    meta: (Array.isArray(x.meta) ? x.meta : []).slice(0, 6).map((m) => ({ text: str(m?.text, 200), cls: m?.cls ? str(m.cls, 20) : undefined })),
    color: /^#[0-9a-f]{6}$/i.test(String(x.color)) ? x.color : '#969993',
    link: /^https?:\/\//i.test(String(x.link ?? '')) ? str(x.link, 2000) : undefined,
    done: !!x.done,
    mail: x.kind === 'mail' && x.mail ? { accountId: str(x.mail.accountId, 200), folder: str(x.mail.folder, 500), uid: Number(x.mail.uid) || 0 } : undefined,
  };
}

export const listPins = (): PinItem[] => getKv<PinItem[]>('pins') ?? [];

// new or again: on top and unfolded
export function addPin(item: PinItem): void {
  const p = clean(item);
  setKv('pins', [p, ...listPins().filter((x) => x.key !== p.key)].slice(0, MAX));
}

export function removePin(key: string): void {
  setKv('pins', listPins().filter((x) => x.key !== key));
}

export function togglePin(key: string): void {
  setKv('pins', listPins().map((x) => (x.key === key ? { ...x, collapsed: !x.collapsed } : x)));
}

// fresh data for items that are pinned, folding stays; true = something changed
export function updatePins(items: PinItem[]): boolean {
  const fresh = new Map((Array.isArray(items) ? items : []).map((x) => [String(x?.key), x]));
  let changed = false;
  const list = listPins().map((x) => {
    const f = fresh.get(x.key);
    if (!f) return x;
    const next = { ...clean(f), collapsed: x.collapsed };
    if (JSON.stringify(next) !== JSON.stringify(x)) changed = true;
    return next;
  });
  if (changed) setKv('pins', list);
  return changed;
}
