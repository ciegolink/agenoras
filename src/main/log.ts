// Problem log (IMAP, SMTP, CalDAV/CardDAV): shown behind the warning sign in the title bar.
// Kept in a small JSON file so problems from before a restart are still visible; the user can clear it.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'error' | 'warn'; // only problems – nothing that worked

export interface LogEntry {
  id: number;
  time: string; // ISO, last occurrence
  level: LogLevel;
  source: string; // 'IMAP' | 'SMTP' | 'CalDAV' | 'CardDAV' …
  account: string; // e-mail / account name ('' = general)
  message: string;
  count: number; // the same message repeated (e.g. reconnect attempts)
}

export interface LogState {
  total: number;
  unseen: number; // different errors/warnings (re)occurring since the log was last opened
}

const MAX = 500;
const REPEAT_MS = 10 * 60_000; // same message within 10 min → counter instead of a new line
const file = () => path.join(app.getPath('userData'), 'problems.json');

let entries: LogEntry[] | null = null;
let seenAt = ''; // ISO time the log was last opened
let nextId = 1;
let saveTimer: NodeJS.Timeout | undefined;
let onChange: (state: LogState) => void = () => {};

function load(): LogEntry[] {
  if (entries) return entries;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    entries = (Array.isArray(raw.entries) ? raw.entries : []).filter((e: LogEntry) => e.level === 'error' || e.level === 'warn'); // older versions also logged successes
    seenAt = typeof raw.seenAt === 'string' ? raw.seenAt : '';
  } catch {
    entries = [];
  }
  nextId = Math.max(0, ...entries!.map((e) => e.id)) + 1;
  return entries!;
}

function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(file(), JSON.stringify({ seenAt, entries }), 'utf8');
    } catch (err) {
      console.error('log:', err);
    }
  }, 500);
}

export const logState = (): LogState => ({ total: load().length, unseen: load().filter((e) => e.time > seenAt).length });

export function setOnLogChange(fn: (state: LogState) => void): void {
  onChange = fn;
}

export function log(level: LogLevel, source: string, account: string, message: string): void {
  const list = load();
  const now = new Date();
  (level === 'error' ? console.error : console.warn)(`[${source}${account ? ` ${account}` : ''}]`, message);
  const same = list.find((e) => e.level === level && e.source === source && e.account === account && e.message === message && now.getTime() - Date.parse(e.time) < REPEAT_MS);
  if (same) {
    same.count++;
    same.time = now.toISOString();
    list.splice(list.indexOf(same), 1);
    list.push(same); // newest at the end
  } else {
    list.push({ id: nextId++, time: now.toISOString(), level, source, account, message, count: 1 });
    if (list.length > MAX) list.splice(0, list.length - MAX);
  }
  save();
  onChange(logState());
}

export function getLog(): LogEntry[] {
  return load();
}

export function markLogSeen(): LogState {
  load();
  seenAt = new Date().toISOString();
  save();
  onChange(logState());
  return logState();
}

export function clearLog(): LogState {
  entries = [];
  seenAt = new Date().toISOString();
  save();
  onChange(logState());
  return logState();
}

// Before quitting: write right away (the timer may not fire anymore)
export function flushLog(): void {
  if (!saveTimer || !entries) return;
  clearTimeout(saveTimer);
  try {
    fs.writeFileSync(file(), JSON.stringify({ seenAt, entries }), 'utf8');
  } catch {
    /* ignore */
  }
}
