import ICAL from 'ical.js';
import crypto from 'node:crypto';
import { listDavAccounts, getDavAccount } from './davaccounts';
import { calEntry, davError, getConn, hasTodos, registerTz } from './caldav';
import { getKv, setKv } from './cache';
import { t } from './i18n';
import { log } from './log';

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
  due: string; // '' | YYYY-MM-DD | ISO (with time)
  done: boolean;
  completed: string; // ISO, when completed
  priority: 'high' | 'normal' | 'low';
  created: string;
}

export interface TaskInput {
  listId: string;
  id?: string; // set = edit
  title: string;
  notes: string;
  due: string;
  done: boolean;
  priority: 'high' | 'normal' | 'low';
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
    const status = String(v.getFirstPropertyValue('status') ?? '').toUpperCase();
    const completed = v.getFirstPropertyValue('completed') as ICAL.Time | null;
    const created = (v.getFirstPropertyValue('created') ?? v.getFirstPropertyValue('dtstamp')) as ICAL.Time | null;
    return {
      id: url,
      listId,
      title: String(v.getFirstPropertyValue('summary') ?? '') || t('tasks.untitled'),
      notes: String(v.getFirstPropertyValue('description') ?? ''),
      due: due ? (due.isDate ? due.toString() : due.toJSDate().toISOString()) : '',
      done: status === 'COMPLETED' || !!completed,
      completed: completed ? completed.toJSDate().toISOString() : '',
      priority: prioOf(Number(v.getFirstPropertyValue('priority') ?? 0)),
      created: created ? created.toJSDate().toISOString() : '',
    };
  });
}

export async function listTasks(): Promise<{ lists: TaskList[]; tasks: Task[]; errors: { accountId: string; message: string }[] }> {
  const lists: TaskList[] = [];
  const tasks: Task[] = [];
  const errors: { accountId: string; message: string }[] = [];
  const cached = getKv<{ lists: TaskList[]; tasks: Task[] }>('tasks') ?? { lists: [], tasks: [] };
  let i = 0;
  for (const acc of listDavAccounts('caldav')) {
    try {
      const { client, calendars } = await getConn(acc, true);
      for (const cal of calendars.filter((c) => c.components?.includes('VTODO') || (!c.components && hasTodos(c)))) {
        const name = typeof cal.displayName === 'string' && cal.displayName ? cal.displayName : t('tasks.list');
        const color = /^#[0-9a-f]{6}/i.test(cal.calendarColor ?? '') ? cal.calendarColor!.slice(0, 7) : PALETTE[i++ % PALETTE.length];
        lists.push({ id: cal.url, accountId: acc.id, accountName: acc.name, name, color });
        const objects = await client.fetchCalendarObjects({ calendar: cal, filters: TODO_FILTER as never });
        for (const o of objects) {
          if (typeof o.data !== 'string' || !o.data.includes('VTODO')) continue;
          rawTodos.set(o.url, { data: o.data, etag: o.etag ?? '', listId: cal.url });
          try {
            tasks.push(...parseTodos(o.data, o.url, cal.url));
          } catch (err) {
            console.error('Unreadable task:', o.url, (err as Error).message);
          }
        }
      }
    } catch (err) {
      errors.push({ accountId: acc.id, message: davError(err) });
      log('error', 'CalDAV', acc.name, errors[errors.length - 1].message);
      lists.push(...cached.lists.filter((l) => l.accountId === acc.id)); // offline: last state
      const ids = new Set(cached.lists.filter((l) => l.accountId === acc.id).map((l) => l.id));
      tasks.push(...cached.tasks.filter((x) => ids.has(x.listId)));
    }
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
  v.removeAllProperties('due');
  if (input.due) {
    const p = new ICAL.Property('due');
    if (input.due.length === 10) {
      p.resetType('date');
      p.setValue(ICAL.Time.fromDateString(input.due));
    } else p.setValue(ICAL.Time.fromJSDate(new Date(input.due), true));
    v.addProperty(p);
  }
  const n = prioNum(input.priority);
  if (n) v.updatePropertyWithValue('priority', n);
  else v.removeAllProperties('priority');
  if (input.done) {
    v.updatePropertyWithValue('status', 'COMPLETED');
    v.updatePropertyWithValue('percent-complete', 100);
    if (!v.hasProperty('completed')) v.updatePropertyWithValue('completed', now);
  } else {
    v.updatePropertyWithValue('status', 'NEEDS-ACTION');
    v.removeAllProperties('completed');
    v.removeAllProperties('percent-complete');
  }
  v.updatePropertyWithValue('dtstamp', now);
  v.updatePropertyWithValue('last-modified', now);
  v.updatePropertyWithValue('sequence', Number(v.getFirstPropertyValue('sequence') ?? 0) + 1);
}

export async function saveTask(input: TaskInput): Promise<void> {
  if (!input.title?.trim()) throw new Error(t('err.titleRequired'));
  if (input.id) {
    const raw = rawTodos.get(input.id);
    if (!raw) throw new Error(t('err.eventNotLoaded'));
    const { client } = await clientFor(raw.listId);
    const comp = new ICAL.Component(ICAL.parse(raw.data));
    const v = comp.getAllSubcomponents('vtodo').find((x) => !x.hasProperty('recurrence-id'));
    if (!v) throw new Error(t('err.eventNotEditable'));
    applyInput(v, input);
    await check(await client.updateCalendarObject({ calendarObject: { url: input.id, etag: raw.etag, data: comp.toString() } }));
    rawTodos.delete(input.id);
    return;
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
}

export async function deleteTask(id: string): Promise<void> {
  const raw = rawTodos.get(id);
  if (!raw) throw new Error(t('err.eventNotLoaded'));
  const { client } = await clientFor(raw.listId);
  await check(await client.deleteCalendarObject({ calendarObject: { url: id, etag: raw.etag } }));
  rawTodos.delete(id);
}
