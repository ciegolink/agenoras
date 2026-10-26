import { DAVCalendar, DAVClient } from 'tsdav';
import ICAL from 'ical.js';
import crypto from 'node:crypto';
import { DavAccount, getDavAccount, getDavPassword, listDavAccounts } from './davaccounts';
import { cachedWeek, getKv, setKv, storeWeek } from './cache';
import { t } from './i18n';
import { Person, readPeople } from './invites';

type CalAccount = DavAccount;
const getCalAccount = (id: string) => getDavAccount('caldav', id);
const getCalPassword = (id: string) => getDavPassword('caldav', id);
const listCalAccounts = () => listDavAccounts('caldav');

export interface CalendarInfo {
  id: string; // = calendar URL
  accountId: string;
  accountName: string;
  name: string;
  color: string;
}

export interface CalEvent {
  id: string;
  calendarId: string;
  url: string;
  title: string;
  location: string;
  description: string;
  start: string; // all-day: YYYY-MM-DD, otherwise ISO
  end: string; // all-day: exclusive
  allDay: boolean;
  recurring: boolean;
  occurrence?: string; // Series: original start of this occurrence (RECURRENCE-ID), same format as start
  rrule?: RRuleInfo | null; // Series: rule of the master event
  organizer?: Person | null;
  attendees?: Person[];
  uid?: string;
}

// Recurrence (simplified RRULE). custom = rule is more complex than the dialog can show
export interface RRuleInfo {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  byday: string[]; // MO TU WE TH FR SA SU (weekly only)
  until?: string; // YYYY-MM-DD (inclusive)
  count?: number;
  custom?: boolean;
}

export interface EventInput {
  calendarId: string;
  url?: string; // set = edit
  title: string;
  location: string;
  description: string;
  start: string;
  end: string;
  allDay: boolean;
  rrule?: RRuleInfo | null; // undefined = unchanged, null = no recurrence
  scope?: 'series' | 'occurrence'; // series: only this occurrence or the whole series
  occurrence?: string; // series: which occurrence (CalEvent.occurrence)
  origStart?: string; // series: displayed start before the change (for shifting)
  attendees?: { email: string; name?: string }[]; // undefined = unchanged
  organizer?: { email: string; name?: string }; // required as soon as attendees are set
  moveTo?: string; // other calendar: move the event (whole object incl. series) there
}

export interface SaveResult {
  ics: string; // stored calendar object (for invitations)
  uid: string;
}

const PALETTE = ['#2BA89F', '#7FA6CF', '#E0574B', '#C1C8BE', '#E0A458', '#B48EAD'];

interface Conn {
  client: DAVClient;
  calendars: DAVCalendar[];
}

const conns = new Map<string, Conn>();
const calIndex = new Map<string, { accountId: string; cal: DAVCalendar }>();
const rawObjects = new Map<string, { data: string; etag: string; calendarId: string }>();

function davClient(serverUrl: string, username: string, password: string): DAVClient {
  return new DAVClient({
    serverUrl,
    credentials: { username, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
}

// All calendar collections; events only in those with VEVENT, tasks in those with VTODO
async function loadCalendars(client: DAVClient): Promise<DAVCalendar[]> {
  return client.fetchCalendars();
}

export const hasEvents = (c: DAVCalendar) => !c.components || c.components.includes('VEVENT');
export const hasTodos = (c: DAVCalendar) => !c.components || c.components.includes('VTODO');

export async function testCalDav(serverUrl: string, username: string, password: string): Promise<number> {
  const client = davClient(serverUrl, username, password);
  await client.login();
  const cals = (await loadCalendars(client)).filter((c) => hasEvents(c) || hasTodos(c));
  if (!cals.length) throw new Error(t('err.noCalendars'));
  return cals.length;
}

export async function getConn(acc: CalAccount, refresh = false): Promise<Conn> {
  const existing = conns.get(acc.id);
  if (existing && !refresh) return existing;
  const client = davClient(acc.serverUrl, acc.username, getCalPassword(acc.id));
  await client.login();
  const conn = { client, calendars: await loadCalendars(client) };
  conns.set(acc.id, conn);
  for (const cal of conn.calendars) calIndex.set(cal.url, { accountId: acc.id, cal });
  return conn;
}

export function forgetCalAccount(id: string): void {
  conns.delete(id);
  for (const [url, v] of calIndex) if (v.accountId === id) calIndex.delete(url);
}

export async function listCalendars(): Promise<{ calendars: CalendarInfo[]; errors: { accountId: string; message: string }[] }> {
  const calendars: CalendarInfo[] = [];
  const errors: { accountId: string; message: string }[] = [];
  const cached = getKv<CalendarInfo[]>('calendars') ?? [];
  let i = 0;
  for (const acc of listCalAccounts()) {
    try {
      const conn = await getConn(acc, true);
      for (const cal of conn.calendars.filter(hasEvents)) {
        const name = typeof cal.displayName === 'string' && cal.displayName ? cal.displayName : t('cal.calendar');
        const color = /^#[0-9a-f]{6}/i.test(cal.calendarColor ?? '') ? cal.calendarColor!.slice(0, 7) : PALETTE[i % PALETTE.length];
        calendars.push({ id: cal.url, accountId: acc.id, accountName: acc.name, name, color });
        i++;
      }
    } catch (err) {
      errors.push({ accountId: acc.id, message: davError(err) });
      calendars.push(...cached.filter((c) => c.accountId === acc.id)); // offline: last known calendars
    }
  }
  setKv('calendars', calendars);
  return { calendars, errors };
}

export function cachedCalendarView(calendarIds: string[], startIso: string): { calendars: CalendarInfo[]; events: CalEvent[] } {
  const accIds = new Set(listCalAccounts().map((a) => a.id));
  const calendars = (getKv<CalendarInfo[]>('calendars') ?? []).filter((c) => accIds.has(c.accountId));
  return { calendars, events: cachedWeek<CalEvent>(calendarIds, startIso) };
}

export function davError(err: unknown): string {
  const m = (err as Error)?.message ?? String(err);
  if (/401|unauthori[sz]ed/i.test(m)) return t('err.authFailed');
  if (/412|precondition/i.test(m)) return t('err.eventChanged');
  return m;
}

function registerTimezones(comp: ICAL.Component): void {
  for (const tzComp of comp.getAllSubcomponents('vtimezone')) {
    const tz = new ICAL.Timezone(tzComp);
    if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz);
  }
}

export function registerTz(comp: ICAL.Component): void {
  registerTimezones(comp);
}

function toOut(t: ICAL.Time): string {
  return t.isDate ? t.toString() : t.toJSDate().toISOString();
}

const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

function readRRule(master: ICAL.Component): RRuleInfo | null {
  const r = master.getFirstPropertyValue('rrule') as ICAL.Recur | null;
  if (!r) return null;
  const freq = String(r.freq) as RRuleInfo['freq'];
  const parts = (r.parts ?? {}) as Record<string, unknown[]>;
  const byday = ((parts.BYDAY as string[]) ?? []).map(String);
  const otherParts = Object.keys(parts).filter((k) => k !== 'BYDAY' || freq !== 'WEEKLY' || byday.some((d) => !DAYS.includes(d)));
  return {
    freq: ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq) ? freq : 'DAILY',
    interval: Number(r.interval) || 1,
    byday: freq === 'WEEKLY' ? byday.filter((d) => DAYS.includes(d)) : [],
    until: r.until ? (r.until.isDate ? r.until.toString() : localYmd(r.until.toJSDate())) : undefined,
    count: r.count ? Number(r.count) : undefined,
    custom: otherParts.length > 0 || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq) || master.getAllProperties('rrule').length > 1,
  };
}

const localYmd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function expandObject(data: string, url: string, calendarId: string, from: Date, to: Date): CalEvent[] {
  const comp = new ICAL.Component(ICAL.parse(data));
  registerTimezones(comp);
  const vevents = comp.getAllSubcomponents('vevent');
  const master = vevents.find((v) => !v.hasProperty('recurrence-id'));
  const out: CalEvent[] = [];

  const rule = master ? readRRule(master) : null;
  const push = (ev: ICAL.Event, start: ICAL.Time, end: ICAL.Time, recurring: boolean, rid?: ICAL.Time) => {
    const s = start.toJSDate();
    const e = end.toJSDate();
    if (e <= from || s >= to) return;
    out.push({
      id: `${url}#${start.toString()}`,
      calendarId,
      url,
      title: ev.summary || t('cal.untitled'),
      location: ev.location || '',
      description: ev.description || '',
      start: toOut(start),
      end: toOut(end),
      allDay: start.isDate,
      recurring,
      ...(recurring && rid ? { occurrence: toOut(rid), rrule: rule } : {}),
      ...readPeople(ev.component),
      uid: ev.uid,
    });
  };

  if (!master) {
    for (const v of vevents) {
      const ev = new ICAL.Event(v);
      push(ev, ev.startDate, ev.endDate ?? ev.startDate, false);
    }
    return out;
  }

  const ev = new ICAL.Event(master);
  for (const ex of vevents) if (ex !== master) ev.relateException(ex);

  if (!ev.isRecurring()) {
    push(ev, ev.startDate, ev.endDate ?? ev.startDate, false);
    return out;
  }

  const it = ev.iterator();
  let next: ICAL.Time | undefined;
  let guard = 0;
  while ((next = it.next()) && guard++ < 20_000) {
    if (next.toJSDate() >= to) break;
    const d = ev.getOccurrenceDetails(next);
    push(d.item, d.startDate, d.endDate, true, d.recurrenceId);
  }
  return out;
}

export async function fetchEvents(
  calendarIds: string[],
  startIso: string,
  endIso: string,
): Promise<{ events: CalEvent[]; errors: { calendarId: string; message: string }[] }> {
  const from = new Date(startIso);
  const to = new Date(endIso);
  const events: CalEvent[] = [];
  const errors: { calendarId: string; message: string }[] = [];

  await Promise.all(
    calendarIds.map(async (id) => {
      const entry = calIndex.get(id);
      const acc = entry && getCalAccount(entry.accountId);
      if (!entry || !acc) {
        events.push(...cachedWeek<CalEvent>([id], startIso)); // account offline → cache
        return;
      }
      try {
        const { client } = await getConn(acc);
        const objects = await client.fetchCalendarObjects({ calendar: entry.cal, timeRange: { start: startIso, end: endIso } });
        const local: CalEvent[] = [];
        for (const obj of objects) {
          if (typeof obj.data !== 'string' || !obj.data) continue;
          rawObjects.set(obj.url, { data: obj.data, etag: obj.etag ?? '', calendarId: id });
          try {
            local.push(...expandObject(obj.data, obj.url, id, from, to));
          } catch (err) {
            console.error('Unreadable event:', obj.url, (err as Error).message);
          }
        }
        storeWeek(id, startIso, local);
        events.push(...local);
      } catch (err) {
        errors.push({ calendarId: id, message: davError(err) });
        events.push(...cachedWeek<CalEvent>([id], startIso));
      }
    }),
  );

  events.sort((a, b) => a.start.localeCompare(b.start));
  return { events, errors };
}

function toIcalTime(value: string, allDay: boolean): ICAL.Time {
  return allDay ? ICAL.Time.fromDateString(value) : ICAL.Time.fromJSDate(new Date(value), true);
}

function setText(comp: ICAL.Component, name: string, value: string): void {
  if (value) comp.updatePropertyWithValue(name, value);
  else comp.removeAllProperties(name);
}

async function check(res: Response): Promise<void> {
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
}

// ---------- Save ----------

const DAY_MS = 86_400_000;

// New times: wall-clock shift of an existing time (keeps the series' time zone/TZID)
function shifted(base: ICAL.Time, deltaMs: number): ICAL.Time {
  const t2 = base.clone();
  if (t2.isDate) t2.addDuration(ICAL.Duration.fromSeconds(Math.round(deltaMs / DAY_MS) * 86400));
  else t2.addDuration(ICAL.Duration.fromSeconds(Math.round(deltaMs / 1000)));
  return t2;
}

// Local time without time zone ("floating") – series stay at 09:00 across DST changes
function floating(iso: string, allDay: boolean): ICAL.Time {
  if (allDay) return ICAL.Time.fromDateString(iso);
  const d = new Date(iso);
  return ICAL.Time.fromData({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: 0, isDate: false });
}

// Set a time property, incl. TZID parameter for named time zones
function setTimeProp(comp: ICAL.Component, name: string, time: ICAL.Time, add = false): ICAL.Property {
  const prop = add ? new ICAL.Property(name) : (comp.getFirstProperty(name) ?? new ICAL.Property(name));
  if (add || !comp.getFirstProperty(name)) comp.addProperty(prop);
  prop.removeParameter('tzid');
  prop.resetType(time.isDate ? 'date' : 'date-time');
  prop.setValue(time);
  const tzid = (time.zone as ICAL.Timezone | undefined)?.tzid;
  if (!time.isDate && tzid && tzid !== 'UTC' && tzid !== 'floating') prop.setParameter('tzid', tzid);
  return prop;
}

function buildRecur(r: RRuleInfo, allDay: boolean): ICAL.Recur {
  const data: Record<string, unknown> = { freq: r.freq, interval: Math.max(1, Math.round(r.interval || 1)) };
  if (r.freq === 'WEEKLY' && r.byday?.length) data.byday = r.byday.filter((d) => DAYS.includes(d));
  if (r.count && r.count > 0) data.count = Math.round(r.count);
  else if (r.until) {
    // UNTIL: date for all-day events, otherwise end of day in UTC
    data.until = allDay ? ICAL.Time.fromDateString(r.until) : ICAL.Time.fromJSDate(new Date(`${r.until}T23:59:59`), true);
  }
  return new ICAL.Recur(data);
}

function touch(comp: ICAL.Component): void {
  const now = ICAL.Time.now();
  comp.updatePropertyWithValue('dtstamp', now);
  comp.updatePropertyWithValue('last-modified', now);
  comp.updatePropertyWithValue('sequence', Number(comp.getFirstPropertyValue('sequence') ?? 0) + 1);
}

function setTexts(comp: ICAL.Component, input: EventInput): void {
  setText(comp, 'summary', input.title.trim());
  setText(comp, 'location', input.location.trim());
  setText(comp, 'description', input.description);
  if (input.attendees !== undefined) setPeople(comp, input);
}

// Set attendees: known attendees keep their status; SCHEDULE-AGENT=CLIENT → the server
// sends no invitations of its own (the app does that by mail)
function setPeople(comp: ICAL.Component, input: EventInput): void {
  const old = new Map(readPeople(comp).attendees.map((a) => [a.email.toLowerCase(), a]));
  comp.removeAllProperties('attendee');
  comp.removeAllProperties('organizer');
  const list = (input.attendees ?? []).filter((a) => /@/.test(a.email));
  if (!list.length || !input.organizer?.email) return;
  const org = new ICAL.Property('organizer');
  org.setValue(`mailto:${input.organizer.email}`);
  if (input.organizer.name) org.setParameter('cn', input.organizer.name);
  comp.addProperty(org);
  const me = new ICAL.Property('attendee');
  me.setValue(`mailto:${input.organizer.email}`);
  if (input.organizer.name) me.setParameter('cn', input.organizer.name);
  me.setParameter('role', 'CHAIR');
  me.setParameter('partstat', 'ACCEPTED');
  me.setParameter('schedule-agent', 'CLIENT');
  comp.addProperty(me);
  for (const a of list) {
    if (a.email.toLowerCase() === input.organizer.email.toLowerCase()) continue;
    const p = new ICAL.Property('attendee');
    p.setValue(`mailto:${a.email}`);
    const name = a.name || old.get(a.email.toLowerCase())?.name;
    if (name) p.setParameter('cn', name);
    p.setParameter('role', 'REQ-PARTICIPANT');
    p.setParameter('partstat', old.get(a.email.toLowerCase())?.partstat ?? 'NEEDS-ACTION');
    p.setParameter('rsvp', 'TRUE');
    p.setParameter('schedule-agent', 'CLIENT');
    comp.addProperty(p);
  }
}

const sameTime = (a: ICAL.Time, b: ICAL.Time) => (a.isDate || b.isDate ? a.toString().slice(0, 10) === b.toString().slice(0, 10) : a.toUnixTime() === b.toUnixTime());

// Find the series time (RECURRENCE-ID) of an occurrence
function findOccurrence(master: ICAL.Component, occurrence: string): ICAL.Time {
  const ev = new ICAL.Event(master);
  const it = ev.iterator();
  const want = occurrence.length === 10 ? occurrence : new Date(occurrence).getTime();
  let next: ICAL.Time | undefined;
  let guard = 0;
  while ((next = it.next()) && guard++ < 50_000) {
    if (typeof want === 'string' ? next.toString().slice(0, 10) === want : next.toJSDate().getTime() === want) return next;
    if (typeof want === 'number' && next.toJSDate().getTime() > want) break;
  }
  throw new Error(t('err.eventNotLoaded'));
}

async function connFor(calendarId: string) {
  const entry = calIndex.get(calendarId);
  if (!entry) throw new Error(t('err.calendarNotFound'));
  const acc = getCalAccount(entry.accountId);
  if (!acc) throw new Error(t('err.accountNotFound'));
  return { entry, client: (await getConn(acc)).client };
}

export async function saveEvent(input: EventInput): Promise<SaveResult> {
  if (!input.title.trim()) throw new Error(t('err.titleRequired'));
  if (input.end <= input.start) throw new Error(t('err.endBeforeStart'));
  const { entry, client } = await connFor(input.calendarId);
  const durMs = (input.allDay ? parseDay(input.end) - parseDay(input.start) : new Date(input.end).getTime() - new Date(input.start).getTime());

  if (input.url) {
    const raw = rawObjects.get(input.url);
    if (!raw) throw new Error(t('err.eventNotLoaded'));
    const comp = new ICAL.Component(ICAL.parse(raw.data));
    registerTimezones(comp);
    const vevents = comp.getAllSubcomponents('vevent');
    const master = vevents.find((v) => !v.hasProperty('recurrence-id'));
    if (!master) throw new Error(t('err.eventNotEditable'));
    const ev = new ICAL.Event(master);
    const allDayChanged = ev.startDate.isDate !== input.allDay;

    if (ev.isRecurring() && input.scope === 'occurrence' && input.occurrence) {
      // This occurrence only: create or update an exception (VEVENT with RECURRENCE-ID)
      const rid = findOccurrence(master, input.occurrence);
      let ex = vevents.find((v) => v !== master && sameTime(v.getFirstPropertyValue('recurrence-id') as ICAL.Time, rid));
      if (!ex) {
        ex = new ICAL.Component('vevent');
        ex.updatePropertyWithValue('uid', master.getFirstPropertyValue('uid') as string);
        setTimeProp(ex, 'recurrence-id', rid);
        comp.addSubcomponent(ex);
      }
      const exEv = new ICAL.Event(ex);
      const base = ex.hasProperty('dtstart') ? exEv.startDate : rid;
      const delta = (input.allDay ? parseDay(input.start) : new Date(input.start).getTime()) - origMs(input, base);
      const start = allDayChanged ? floating(input.start, input.allDay) : shifted(base, delta);
      setTimeProp(ex, 'dtstart', start);
      ex.removeAllProperties('duration');
      setTimeProp(ex, 'dtend', shifted(start, durMs));
      setTexts(ex, input);
      touch(ex);
    } else {
      // Whole event or whole series
      setTexts(master, input);
      master.removeAllProperties('duration');
      const oldRule = readRRule(master);
      const ruleSame = input.rrule === undefined || JSON.stringify(plainRule(input.rrule)) === JSON.stringify(plainRule(oldRule));
      let start: ICAL.Time;
      if (ev.isRecurring() && !allDayChanged) {
        const delta = (input.allDay ? parseDay(input.start) : new Date(input.start).getTime()) - origMs(input, null);
        start = shifted(ev.startDate, delta);
        if (delta) {
          // Shift exceptions and deleted occurrences along so they still match the series
          for (const p of master.getAllProperties('exdate')) {
            const v = p.getFirstValue() as ICAL.Time;
            if (v) p.setValue(shifted(v, delta));
          }
          for (const v of vevents) {
            if (v === master) continue;
            const p = v.getFirstProperty('recurrence-id');
            const rv = p?.getFirstValue() as ICAL.Time | undefined;
            if (p && rv) p.setValue(shifted(rv, delta));
          }
          // Weekly on fixed days: shifted by whole days → rotate the weekdays too (Mon/Wed → Tue/Thu)
          const dayShift = Math.round((localDayMs(start) - localDayMs(ev.startDate)) / DAY_MS);
          const recur = master.getFirstPropertyValue('rrule') as ICAL.Recur | null;
          const byday = recur?.parts?.BYDAY as string[] | undefined;
          if (ruleSame && dayShift && recur && String(recur.freq) === 'WEEKLY' && byday?.length && byday.every((d) => DAYS.includes(d))) {
            recur.parts.BYDAY = byday.map((d) => DAYS[(((DAYS.indexOf(d) + dayShift) % 7) + 7) % 7]);
            master.updatePropertyWithValue('rrule', recur);
          }
        }
      } else if (ev.isRecurring() || input.rrule) {
        start = !['UTC', 'floating', undefined].includes((ev.startDate.zone as ICAL.Timezone | undefined)?.tzid) && !allDayChanged ? shifted(ev.startDate, new Date(input.start).getTime() - ev.startDate.toJSDate().getTime()) : floating(input.start, input.allDay);
      } else {
        start = toIcalTime(input.start, input.allDay);
      }
      setTimeProp(master, 'dtstart', start);
      setTimeProp(master, 'dtend', shifted(start, durMs));
      if (input.rrule !== undefined && !(ruleSame && ev.isRecurring())) {
        master.removeAllProperties('rrule');
        if (input.rrule) master.addPropertyWithValue('rrule', buildRecur(input.rrule, input.allDay));
        // new rule or no longer a series → exceptions and deleted occurrences no longer apply
        master.removeAllProperties('exdate');
        for (const v of vevents) if (v !== master) comp.removeSubcomponent(v);
      }
      touch(master);
    }
    const data = comp.toString();
    const uidv = String(master.getFirstPropertyValue('uid') ?? '');
    if (input.moveTo && input.moveTo !== input.calendarId) {
      // Move to another calendar: create it there (same UID), then delete it here
      const target = await connFor(input.moveTo);
      const safe = (uidv || crypto.randomUUID()).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
      await check(await target.client.createCalendarObject({ calendar: target.entry.cal, filename: `${safe}.ics`, iCalString: data }));
      await check(await client.deleteCalendarObject({ calendarObject: { url: input.url, etag: raw.etag } }));
      rawObjects.delete(input.url);
      return { ics: data, uid: uidv };
    }
    await check(await client.updateCalendarObject({ calendarObject: { url: input.url, etag: raw.etag, data } }));
    rawObjects.delete(input.url);
    return { ics: data, uid: uidv };
  }

  const uid = crypto.randomUUID();
  const cal = new ICAL.Component(['vcalendar', [], []]);
  cal.updatePropertyWithValue('prodid', '-//Agenoras//Agenoras//DE');
  cal.updatePropertyWithValue('version', '2.0');
  const vevent = new ICAL.Component('vevent');
  vevent.updatePropertyWithValue('uid', uid);
  vevent.updatePropertyWithValue('dtstamp', ICAL.Time.now());
  setTexts(vevent, input);
  // Series in local time (stay at the same time of day after DST changes), otherwise UTC
  const start = input.rrule ? floating(input.start, input.allDay) : toIcalTime(input.start, input.allDay);
  setTimeProp(vevent, 'dtstart', start);
  setTimeProp(vevent, 'dtend', input.rrule ? shifted(start, durMs) : toIcalTime(input.end, input.allDay));
  if (input.rrule) vevent.addPropertyWithValue('rrule', buildRecur(input.rrule, input.allDay));
  cal.addSubcomponent(vevent);

  const data = cal.toString();
  await check(await client.createCalendarObject({ calendar: entry.cal, filename: `${uid}.ics`, iCalString: data }));
  return { ics: data, uid };
}

// Comparable form of a rule (without "custom")
function plainRule(r?: RRuleInfo | null) {
  if (!r) return null;
  return { freq: r.freq, interval: r.interval || 1, byday: [...(r.byday ?? [])].sort(), count: r.count || 0, until: r.count ? '' : r.until || '' };
}

const localDayMs = (tm: ICAL.Time) => {
  const d = tm.isDate ? new Date(tm.year, tm.month - 1, tm.day) : tm.toJSDate();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
};

const parseDay = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));

// Originally displayed start (before moving) in ms; all-day as UTC day
function origMs(input: EventInput, base: ICAL.Time | null): number {
  const o = input.origStart ?? (base ? toOut(base) : input.start);
  return o.length === 10 ? parseDay(o) : new Date(o).getTime();
}

// occurrence set = delete only this occurrence of a series (EXDATE), otherwise whole event/series
export async function deleteEvent(url: string, occurrence?: string): Promise<void> {
  const raw = rawObjects.get(url);
  if (!raw) throw new Error(t('err.eventNotLoaded'));
  const { client } = await connFor(raw.calendarId);
  if (occurrence) {
    const comp = new ICAL.Component(ICAL.parse(raw.data));
    registerTimezones(comp);
    const vevents = comp.getAllSubcomponents('vevent');
    const master = vevents.find((v) => !v.hasProperty('recurrence-id'));
    if (master && new ICAL.Event(master).isRecurring()) {
      const rid = findOccurrence(master, occurrence);
      for (const v of vevents) if (v !== master && sameTime(v.getFirstPropertyValue('recurrence-id') as ICAL.Time, rid)) comp.removeSubcomponent(v);
      setTimeProp(master, 'exdate', rid, true);
      touch(master);
      await check(await client.updateCalendarObject({ calendarObject: { url, etag: raw.etag, data: comp.toString() } }));
      rawObjects.delete(url);
      return;
    }
  }
  await check(await client.deleteCalendarObject({ calendarObject: { url, etag: raw.etag } }));
  rawObjects.delete(url);
}

// For tasks (tasks.ts): calendar collection by URL
export function calEntry(url: string): { accountId: string; cal: DAVCalendar } | undefined {
  return calIndex.get(url);
}

// ---------- Accept invitations, apply replies, search ----------

export function eventIcs(url: string): string | null {
  return rawObjects.get(url)?.data ?? null;
}

const uidFilter = (uid: string) => [
  {
    'comp-filter': {
      _attributes: { name: 'VCALENDAR' },
      'comp-filter': { _attributes: { name: 'VEVENT' }, 'prop-filter': { _attributes: { name: 'UID' }, 'text-match': { _attributes: { collation: 'i;octet' }, _text: uid } } },
    },
  },
];

// Look up an event with this UID in the own calendars
export async function findByUid(uid: string): Promise<{ url: string; data: string; etag: string; calendarId: string } | null> {
  for (const [url, raw] of rawObjects) if (raw.data.includes(`UID:${uid}`)) return { url, ...raw };
  for (const acc of listCalAccounts()) {
    let conn: Conn;
    try {
      conn = await getConn(acc);
    } catch {
      continue;
    }
    for (const cal of conn.calendars.filter(hasEvents)) {
      try {
        const objs = await conn.client.fetchCalendarObjects({ calendar: cal, filters: uidFilter(uid) as never });
        const hit = objs.find((o) => typeof o.data === 'string' && o.data.includes(uid));
        if (hit) {
          rawObjects.set(hit.url, { data: hit.data, etag: hit.etag ?? '', calendarId: cal.url });
          return { url: hit.url, data: hit.data, etag: hit.etag ?? '', calendarId: cal.url };
        }
      } catch {
        /* server cannot search by UID */
      }
    }
  }
  return null;
}

// Import an invitation into a calendar (own participation status set); an existing UID is updated
export async function importInvite(calendarId: string, ics: string, myEmail: string, partstat: string): Promise<void> {
  const comp = new ICAL.Component(ICAL.parse(ics));
  comp.removeAllProperties('method');
  comp.updatePropertyWithValue('prodid', '-//Agenoras//Agenoras//DE');
  let uid = '';
  for (const v of comp.getAllSubcomponents('vevent')) {
    uid ||= String(v.getFirstPropertyValue('uid') ?? '');
    for (const p of v.getAllProperties('attendee')) {
      if (String(p.getFirstValue()).replace(/^mailto:/i, '').toLowerCase() === myEmail.toLowerCase()) {
        p.setParameter('partstat', partstat);
        p.removeParameter('rsvp');
      }
    }
  }
  if (!uid) throw new Error(t('err.eventNotLoaded'));
  const data = comp.toString();
  const existing = await findByUid(uid);
  if (existing) {
    const { client } = await connFor(existing.calendarId);
    await check(await client.updateCalendarObject({ calendarObject: { url: existing.url, etag: existing.etag, data } }));
    rawObjects.delete(existing.url);
    return;
  }
  const { entry, client } = await connFor(calendarId);
  const safe = uid.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  await check(await client.createCalendarObject({ calendar: entry.cal, filename: `${safe}.ics`, iCalString: data }));
}

// Apply an attendee's reply to the own event (organizer side)
export async function applyReply(uid: string, email: string, partstat: string): Promise<boolean> {
  const hit = await findByUid(uid);
  if (!hit) return false;
  const comp = new ICAL.Component(ICAL.parse(hit.data));
  let changed = false;
  for (const v of comp.getAllSubcomponents('vevent')) {
    for (const p of v.getAllProperties('attendee')) {
      if (String(p.getFirstValue()).replace(/^mailto:/i, '').toLowerCase() === email.toLowerCase()) {
        p.setParameter('partstat', partstat);
        changed = true;
      }
    }
  }
  if (!changed) return false;
  const { client } = await connFor(hit.calendarId);
  await check(await client.updateCalendarObject({ calendarObject: { url: hit.url, etag: hit.etag, data: comp.toString() } }));
  rawObjects.delete(hit.url);
  return true;
}

export async function deleteByUid(uid: string): Promise<boolean> {
  const hit = await findByUid(uid);
  if (!hit) return false;
  const { client } = await connFor(hit.calendarId);
  await check(await client.deleteCalendarObject({ calendarObject: { url: hit.url, etag: hit.etag } }));
  rawObjects.delete(hit.url);
  return true;
}

// Search events (title, location, notes, attendees) – one year back to one year ahead
export async function searchEvents(query: string, calendarIds: string[]): Promise<CalEvent[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const from = new Date(Date.now() - 365 * 86400000);
  const to = new Date(Date.now() + 365 * 86400000);
  const outList: CalEvent[] = [];
  await Promise.all(
    calendarIds.map(async (id) => {
      const entry = calIndex.get(id);
      const acc = entry && getCalAccount(entry.accountId);
      if (!entry || !acc) return;
      try {
        const { client } = await getConn(acc);
        const objs = await client.fetchCalendarObjects({ calendar: entry.cal, timeRange: { start: from.toISOString(), end: to.toISOString() } });
        for (const o of objs) {
          if (typeof o.data !== 'string' || !o.data.toLowerCase().includes(q)) continue;
          rawObjects.set(o.url, { data: o.data, etag: o.etag ?? '', calendarId: id });
          try {
            for (const ev of expandObject(o.data, o.url, id, from, to)) {
              const hay = `${ev.title} ${ev.location} ${ev.description} ${(ev.attendees ?? []).map((a) => `${a.name} ${a.email}`).join(' ')}`.toLowerCase();
              if (hay.includes(q)) outList.push(ev);
            }
          } catch {
            /* unreadable */
          }
        }
      } catch {
        /* calendar unreachable */
      }
    }),
  );
  // Upcoming first, then past ones (newest first); at most 150
  const now = Date.now();
  const fut = outList.filter((e) => new Date(e.end).getTime() >= now).sort((a, b) => a.start.localeCompare(b.start));
  const past = outList.filter((e) => new Date(e.end).getTime() < now).sort((a, b) => b.start.localeCompare(a.start));
  return [...fut, ...past].slice(0, 150);
}
