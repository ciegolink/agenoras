// Offline copy of all mails of a period (Settings → General → Offline): headers of every folder first,
// so search by sender and subject works right away, then the texts, newest first. Runs in the background,
// a few mails at a time, so normal work on the same connection is not held up.
import { listAccounts } from './accounts';
import { clearOfflineAccount, folderKey, hasOffline, getKv, offlineStats, offlineUids, offlineWithoutBody, removeOffline, setKv, storeOffline, storeOfflineBody, updateOfflineFlags } from './cache';
import { fetchFlags, fetchOfflineBody, fetchSummaries, friendlyError, listFolders, offlineFolderUids } from './imap';
import { isPop } from './pop3';
import { log, resolved } from './log';
import { getSettings } from './settings';

export interface OfflineProgress {
  state: 'off' | 'idle' | 'running' | 'error';
  phase?: 'headers' | 'bodies';
  account?: string;
  folder?: string;
  done: number;
  total: number;
  mails: number;
  bodies: number;
  bytes: number;
  perAccount: Record<string, { mails: number; bodies: number; bytes: number }>;
  error?: string;
  finished?: string; // last complete run
}

const SKIP = ['\\Trash', '\\Junk', '\\All', '\\Flagged', '\\Important', '\\Drafts'];
const BIG = 512 * 1024; // bigger mails: only the first 512 KB (the text), attachments are loaded when opened
const EVERY = 30 * 60_000;

let gen = 0;
let current: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;
let progress: OfflineProgress = { state: 'idle', done: 0, total: 0, mails: 0, bodies: 0, bytes: 0, perAccount: {} };
let notify: (p: OfflineProgress) => void = () => {};
let lastSent = 0;

// Counting the stored size reads the whole copy (almost a second with 100'000 mails): at most every 30 s
let stats = { at: 0, v: { mails: 0, bodies: 0, bytes: 0, perAccount: {} } as ReturnType<typeof offlineStats> };
function statsNow(fresh = false): ReturnType<typeof offlineStats> {
  if (fresh || Date.now() - stats.at > 30_000) stats = { at: Date.now(), v: offlineStats() };
  return stats.v;
}

export const offlineProgress = (fresh = false): OfflineProgress => ({ ...progress, ...statsNow(fresh), finished: getKv<string>('offline:finished') ?? undefined });

let afterClear: () => void = () => {};
// busy = the outbox is sending: the sync waits meanwhile, both use the same connection
let busy: () => boolean = () => false;
export function setOfflineBusy(fn: () => boolean): void {
  busy = fn;
}
// failed runs in a row per account: one dropout is retried quietly, only a second one is reported
const failRuns = new Map<string, number>();
const RETRY = 2 * 60_000;
// called when the copy of an account was deleted (main.ts frees the disk space then)
export function onOfflineCleared(fn: () => void): void {
  afterClear = fn;
}

export function onOfflineProgress(fn: (p: OfflineProgress) => void): void {
  notify = fn;
}

function report(p: Partial<OfflineProgress>, force = false): void {
  progress = { ...progress, ...p };
  if (!force && Date.now() - lastSent < 400) return;
  lastSent = Date.now();
  notify(offlineProgress(p.state !== undefined && p.state !== 'running'));
}

// Search can skip the server for an account whose whole mailbox is here
const daysOf = (accountId: string) => getSettings().offline[accountId] ?? 0;
export const offlineComplete = (accountId: string): boolean => daysOf(accountId) === -1 && getKv<boolean>(`offline:done:${accountId}`) === true;

// Start (at launch, after a settings change, every 30 min); a running pass stops at the next mail
export function restartOffline(): void {
  const g = ++gen;
  if (timer) clearTimeout(timer);
  timer = setTimeout(restartOffline, EVERY);
  const prev = current ?? Promise.resolve();
  current = prev.then(() => (g === gen ? run(g) : undefined)).catch(() => {});
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function whileBusy(stale: () => boolean): Promise<void> {
  while (busy() && !stale()) await pause(2000);
}

async function run(g: number): Promise<void> {
  const stale = () => g !== gen;
  const errors: string[] = [];
  let cleared = false;
  let retrySoon = false;
  for (const acc of listAccounts()) {
    if (stale()) return;
    const days = isPop(acc) || acc.private ? 0 : daysOf(acc.id); // POP3 keeps its mails locally anyway; private accounts leave no copies
    if (getKv<number>(`offline:days:${acc.id}`) !== days) {
      // period changed: "complete" has to be earned again
      setKv(`offline:done:${acc.id}`, false);
      setKv(`offline:days:${acc.id}`, days);
    }
    if (!days) {
      if (hasOffline(acc.id)) {
        clearOfflineAccount(acc.id);
        cleared = true;
      }
      continue;
    }
    const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : null;
    try {
      const folders = (await listFolders(acc)).filter((f) => f.selectable && !SKIP.includes(f.specialUse));
      // 1. headers of every folder
      for (const f of folders) {
        if (stale()) return;
        const key = folderKey(acc.id, f.path);
        await whileBusy(stale);
        report({ state: 'running', phase: 'headers', account: acc.email, folder: f.name, done: 0, total: 0, error: undefined }, true);
        const { uidValidity, uids } = await offlineFolderUids(acc, f.path, since);
        if (getKv<string>(`offline:uv:${key}`) !== uidValidity) {
          removeOffline(key, offlineUids(key)); // folder recreated on the server: UIDs mean something else now
          setKv(`offline:uv:${key}`, uidValidity);
        }
        const server = new Set(uids);
        const local = offlineUids(key);
        removeOffline(
          key,
          local.filter((u) => !server.has(u)),
        ); // deleted, moved or older than the period
        const have = new Set(local);
        const missing = uids.filter((u) => !have.has(u)).sort((a, b) => b - a);
        report({ total: missing.length }, true);
        for (let i = 0; i < missing.length; i += 200) {
          if (stale()) return;
          storeOffline(key, await fetchSummaries(acc, f.path, missing.slice(i, i + 200)));
          report({ done: Math.min(missing.length, i + 200) });
        }
        // read, star and answered may have changed elsewhere
        const known = local.filter((u) => server.has(u));
        for (let i = 0; i < known.length; i += 1000) {
          if (stale()) return;
          updateOfflineFlags(key, await fetchFlags(acc, f.path, known.slice(i, i + 1000)));
        }
      }
      // 2. texts, newest first
      const todo = folders.map((f) => ({ f, key: folderKey(acc.id, f.path) }));
      const total = todo.reduce((n, x) => n + offlineWithoutBody(x.key, 1_000_000).length, 0);
      let done = 0;
      let fails = 0;
      for (const { f, key } of todo) {
        report({ state: 'running', phase: 'bodies', account: acc.email, folder: f.name, done, total }, true);
        for (;;) {
          const batch = offlineWithoutBody(key, 20);
          if (!batch.length) break;
          await whileBusy(stale);
          for (const uid of batch) {
            if (stale()) return;
            try {
              const detail = await fetchOfflineBody(acc, f.path, uid, BIG);
              if (detail) storeOfflineBody(key, uid, detail);
              else removeOffline(key, [uid]); // gone on the server
              fails = 0;
            } catch (err) {
              // one unreadable mail is skipped, several in a row mean the connection is gone
              if (++fails >= 3) throw err;
              storeOfflineBody(key, uid, { failed: true } as never);
            }
            done++;
            report({ done, folder: f.name });
            await pause(25); // leave room for what the user is doing
          }
        }
      }
      setKv(`offline:done:${acc.id}`, true);
      resolved('Offline', acc.email); // went through: earlier complaints are over
      failRuns.delete(acc.id);
    } catch (err) {
      const msg = friendlyError(err);
      const runs = (failRuns.get(acc.id) ?? 0) + 1;
      failRuns.set(acc.id, runs);
      if (runs === 1) retrySoon = true; // a dropout (server busy, connection reset): quietly once more
      else {
        errors.push(`${acc.email}: ${msg}`);
        log('warn', 'Offline', acc.email, msg);
      }
    }
  }
  if (stale()) return;
  if (cleared) {
    afterClear();
    statsNow(true);
  }
  const any = listAccounts().some((a) => daysOf(a.id));
  if (!any) return report({ state: 'off', phase: undefined, account: undefined, folder: undefined, done: 0, total: 0, error: undefined }, true);
  if (retrySoon && timer) {
    clearTimeout(timer);
    timer = setTimeout(restartOffline, RETRY);
  }
  if (!errors.length && !retrySoon) setKv('offline:finished', new Date().toISOString());
  report({ state: errors.length ? 'error' : 'idle', phase: undefined, account: undefined, folder: undefined, done: 0, total: 0, error: errors.join(' · ') || undefined }, true);
}
