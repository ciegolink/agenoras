import ICAL from 'ical.js';
import { failedAgain, succeeded } from './netretry';
import crypto from 'node:crypto';
import { listDavAccounts, getDavAccount } from './davaccounts';
import { anyObject, calEntry, davError, getConn, hasTodos, registerTz } from './caldav';
import { getKv, setKv } from './cache';
import { t } from './i18n';
import { log, resolved } from './log';

// Tasks (CalDAV VTODO): lists = calendar collections that support tasks

export interface TaskList {
  id: string; // collection URL
  accountId: string;
  accountName: string;
  name: string;
  color: string;
}

export interface Task {
  id: string; // object URL
  listId: string;
  title: string;
  notes: string;
  start: string; // DTSTART: '' | YYYY-MM-DD | ISO (with time)
  due: string; // '' | YYYY-MM-DD | ISO (with time)
  done: boolean;
  completed: string; // ISO, when completed
  priority: 'high' | 'normal' | 'low';
  percent: number; // 0–100, PERCENT-COMPLETE
  created: string;
}

export interface TaskInput {
  listId: string;
  id?: string; // set = edit
  title: string;
  notes: string;
  start?: string;
  due: string;
  done: boolean;
  priority: 'high' | 'normal' | 'low';
  percent?: number;
}

const PALETTE = ['#2BA89F', '#7FA6CF', '#E0A458', '#B48EAD', '#E0574B', '#C1C8BE'];
const rawTodos = new Map<string, { data: string; etag: string; listId: string }>();
const TODO_FILTER = [{ 'comp-filter': { _attributes: { name: 'VCALENDAR' }, 'comp-filter': { _attributes: { name: 'VTODO' } } } }];

const prioOf = (n: number): Task['priority'] => (n >= 1 && n <= 4 ? 'high' : n >= 6 ? 'low' : 'normal');
const prioNum = (p: Task['priority']) => (p === 'high' ? 1 : p === 'low' ? 9 : 0);

function parseTodos(data: string, url: string, listId: string): Task[] {
  const comp = new ICAL.Component(ICAL.parse(data));
  registerTz(comp);
  return comp.getAllSubcomponents('vtodo').filter((v) => !v.hasProperty('recurrence-id')).map((v) => {
    const due = v.getFirstPropertyValue('due') as ICAL.Time | null;
    const start = v.getFirstPropertyValue('dtstart') as ICAL.Time | null;
    const status = String(v.getFirstPropertyValue('status') ?? '').toUpperCase();
    const completed = v.getFirstPropertyValue('completed') as ICAL.Time | null;
    const created = (v.getFirstPropertyValue('created') ?? v.getFirstPropertyValue('dtstamp')) as ICAL.Time | null;
    const done = status === 'COMPLETED' || !!completed;
    const percent = Math.min(100, Math.max(0, Math.round(Number(v.getFirstPropertyValue('percent-complete') ?? 0)) || 0));
    return {
      id: url,
      listId,
      title: String(v.getFirstPropertyValue('summary') ?? '') || t('tasks.untitled'),
      notes: String(v.getFirstPropertyValue('description') ?? ''),
      start: start ? (start.isDate ? start.toString() : start.toJSDate().toISOString()) : '',
      due: due ? (due.isDate ? due.toString() : due.toJSDate().toISOString()) : '',
      done,
      completed: completed ? completed.toJSDate().toISOString() : '',
      priority: prioOf(Number(v.getFirstPropertyValue('priority') ?? 0)),
      percent: done ? 100 : percent,
      created: created ? created.toJSDate().toISOString() : '',
    };
  });
}

export async function listTasks(): Promise<{ lists: TaskList[]; tasks: Task[]; errors: { accountId: string; message: string }[] }> {
  const lists: TaskList[] = [];
  const tasks: Task[] = [];
  const errors: { accountId: string; message: string }[] = [];
  const cached = getKv<{ lists: TaskList[]; tasks: Task[] }>('tasks') ?? { lists: [], tasks: [] };
  // all accounts at the same time: a slow server (or one without tasks) does not hold up the others
  const perAccount = await Promise.all(
    listDavAccounts('caldav').map(async (acc) => {
      const out = { lists: [] as (TaskList & { color: string })[], tasks: [] as Task[], error: '' };
      try {
        const { client, calendars } = await getConn(acc, true);
        for (const cal of calendars.filter((c) => c.components?.includes('VTODO') || (!c.components && hasTodos(c)))) {
          const name = typeof cal.displayName === 'string' && cal.displayName ? cal.displayName : t('tasks.list');
          const color = /^#[0-9a-f]{6}/i.test(cal.calendarColor ?? '') ? cal.calendarColor!.slice(0, 7) : '';
          out.lists.push({ id: cal.url, accountId: acc.id, accountName: acc.name, name, color });
          const objects = await client.fetchCalendarObjects({ calendar: cal, filters: TODO_FILTER as never, urlFilter: anyObject });
          for (const o of objects) {
            if (typeof o.data !== 'string' || !o.data.includes('VTODO')) continue;
            rawTodos.set(o.url, { data: o.data, etag: o.etag ?? '', listId: cal.url });
            try {
              out.tasks.push(...parseTodos(o.data, o.url, cal.url));
            } catch (err) {
              console.error('Unreadable task:', o.url, (err as Error).message);
            }
          }
        }
        succeeded(`tasks:${acc.id}`);
        resolved('CalDAV', acc.name);
      } catch (err) {
        if (failedAgain(`tasks:${acc.id}`)) {
          out.error = davError(err);
          log('error', 'CalDAV', acc.name, out.error);
        }
        out.lists = cached.lists.filter((l) => l.accountId === acc.id); // offline: last state
        const ids = new Set(out.lists.map((l) => l.id));
        out.tasks = cached.tasks.filter((x) => ids.has(x.listId));
      }
      return { acc, ...out };
    }),
  );
  let i = 0;
  for (const r of perAccount) {
    lists.push(...r.lists.map((l) => ({ ...l, color: l.color || PALETTE[i++ % PALETTE.length] })));
    tasks.push(...r.tasks);
    if (r.error) errors.push({ accountId: r.acc.id, message: r.error });
  }
  setKv('tasks', { lists, tasks });
  return { lists, tasks, errors };
}

export function cachedTasks(): { lists: TaskList[]; tasks: Task[] } {
  const accIds = new Set(listDavAccounts('caldav').map((a) => a.id));
  const c = getKv<{ lists: TaskList[]; tasks: Task[] }>('tasks') ?? { lists: [], tasks: [] };
  const lists = c.lists.filter((l) => accIds.has(l.accountId));
  const ids = new Set(lists.map((l) => l.id));
  return { lists, tasks: c.tasks.filter((x) => ids.has(x.listId)) };
}

async function clientFor(listId: string) {
  const entry = calEntry(listId);
  const acc = entry && getDavAccount('caldav', entry.accountId);
  if (!entry || !acc) throw new Error(t('err.calendarNotFound'));
  return { entry, client: (await getConn(acc)).client };
}

async function check(res: Response): Promise<void> {
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
}

function applyInput(v: ICAL.Component, input: TaskInput): void {
  const now = ICAL.Time.now();
  v.updatePropertyWithValue('summary', input.title.trim());
  if (input.notes.trim()) v.updatePropertyWithValue('description', input.notes);
  else v.removeAllProperties('description');
  // date only (all day) or date with time
  const setTime = (name: string, value: string) => {
    v.removeAllProperties(name);
    if (!value) return;
    const p = new ICAL.Property(name);
    if (value.length === 10) {
      p.resetType('date');
      p.setValue(ICAL.Time.fromDateString(value));
    } else p.setValue(ICAL.Time.fromJSDate(new Date(value), true));
    v.addProperty(p);
  };
  setTime('dtstart', input.start ?? '');
  setTime('due', input.due);
  const n = prioNum(input.priority);
  if (n) v.updatePropertyWithValue('priority', n);
  else v.removeAllProperties('priority');
  if (input.done) {
    v.updatePropertyWithValue('status', 'COMPLETED');
    v.updatePropertyWithValue('percent-complete', 100);
    if (!v.hasProperty('completed')) v.updatePropertyWithValue('completed', now);
  } else {
    // started: IN-PROCESS with the percentage, otherwise NEEDS-ACTION
    const pct = Math.min(99, Math.max(0, Math.round(Number(input.percent) || 0)));
    v.updatePropertyWithValue('status', pct ? 'IN-PROCESS' : 'NEEDS-ACTION');
    v.removeAllProperties('completed');
    if (pct) v.updatePropertyWithValue('percent-complete', pct);
    else v.removeAllProperties('percent-complete');
  }
  v.updatePropertyWithValue('dtstamp', now);
  v.updatePropertyWithValue('last-modified', now);
  v.updatePropertyWithValue('sequence', Number(v.getFirstPropertyValue('sequence') ?? 0) + 1);
}

// After saving: fetch only this task again (new ETag for the next change) and update the offline cache,
// instead of reloading every list of every account. null = not found, the caller reloads everything.
async function refetchTask(client: Awaited<ReturnType<typeof clientFor>>['client'], cal: NonNullable<ReturnType<typeof calEntry>>['cal'], url: string): Promise<Task[] | null> {
  try {
    const objs = await client.fetchCalendarObjects({ calendar: cal, objectUrls: [url], urlFilter: anyObject });
    const o = objs.find((x) => typeof x.data === 'string' && x.data.includes('VTODO'));
    if (!o) return null;
    rawTodos.set(o.url, { data: o.data, etag: o.etag ?? '', listId: cal.url });
    const tasks = parseTodos(o.data, o.url, cal.url);
    const c = getKv<{ lists: TaskList[]; tasks: Task[] }>('tasks');
    if (c) setKv('tasks', { ...c, tasks: [...c.tasks.filter((x) => x.id !== url && x.id !== o.url), ...tasks] });
    return tasks;
  } catch {
    return null;
  }
}

// Server state of a task: from the last load, otherwise fetched now (e.g. right after the start,
// while the list still comes from the offline cache)
async function rawTodo(id: string, listId?: string): Promise<{ data: string; etag: string; listId: string }> {
  const have = rawTodos.get(id);
  if (have) return have;
  const c = getKv<{ lists: TaskList[]; tasks: Task[] }>('tasks');
  const list = listId ?? c?.tasks.find((x) => x.id === id)?.listId;
  if (list && !calEntry(list)) {
    // not connected yet: connecting fills the calendar index
    const acc = getDavAccount('caldav', c?.lists.find((l) => l.id === list)?.accountId ?? '');
    if (acc) await getConn(acc);
  }
  const entry = list ? calEntry(list) : undefined;
  if (list && entry) await refetchTask((await clientFor(list)).client, entry.cal, id);
  const raw = rawTodos.get(id);
  if (!raw) throw new Error(t('err.eventNotLoaded'));
  return raw;
}

export async function saveTask(input: TaskInput): Promise<{ id: string; tasks: Task[] | null }> {
  if (!input.title?.trim()) throw new Error(t('err.titleRequired'));
  if (input.start && input.due && input.start.slice(0, 10) > input.due.slice(0, 10)) throw new Error(t('err.startAfterDue'));
  if (input.id) {
    const raw = await rawTodo(input.id, input.listId);
    const { client } = await clientFor(raw.listId);
    const comp = new ICAL.Component(ICAL.parse(raw.data));
    const v = comp.getAllSubcomponents('vtodo').find((x) => !x.hasProperty('recurrence-id'));
    if (!v) throw new Error(t('err.eventNotEditable'));
    applyInput(v, input);
    await check(await client.updateCalendarObject({ calendarObject: { url: input.id, etag: raw.etag, data: comp.toString() } }));
    rawTodos.delete(input.id);
    const entry = calEntry(raw.listId);
    return { id: input.id, tasks: entry ? await refetchTask(client, entry.cal, input.id) : null };
  }
  const { entry, client } = await clientFor(input.listId);
  const uid = crypto.randomUUID();
  const cal = new ICAL.Component(['vcalendar', [], []]);
  cal.updatePropertyWithValue('prodid', '-//Agenoras//Agenoras//DE');
  cal.updatePropertyWithValue('version', '2.0');
  const v = new ICAL.Component('vtodo');
  v.updatePropertyWithValue('uid', uid);
  v.updatePropertyWithValue('created', ICAL.Time.now());
  applyInput(v, input);
  cal.addSubcomponent(v);
  await check(await client.createCalendarObject({ calendar: entry.cal, filename: `${uid}.ics`, iCalString: cal.toString() }));
  const url = new URL(`${uid}.ics`, entry.cal.url).href;
  return { id: url, tasks: await refetchTask(client, entry.cal, url) };
}

export async function deleteTask(id: string): Promise<void> {
  const raw = await rawTodo(id);
  const { client } = await clientFor(raw.listId);
  await check(await client.deleteCalendarObject({ calendarObject: { url: id, etag: raw.etag } }));
  rawTodos.delete(id);
  const c = getKv<{ lists: TaskList[]; tasks: Task[] }>('tasks');
  if (c) setKv('tasks', { ...c, tasks: c.tasks.filter((x) => x.id !== id) });
}
