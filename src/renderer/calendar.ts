// Calendar view (CalDAV). Uses el, esc and errMsg from renderer.ts.

const HOUR_PX = 48;

let calAccounts: CalAccount[] = [];
let calendars: CalendarInfo[] = [];
let calEvents: CalEvent[] = [];
let weekStart = weekStartOf(new Date());
let calLoaded = false;
let hiddenCals = new Set<string>(readHidden());
let editingEvent: CalEvent | null = null;

// ---------- Date helpers ----------

// Start of the week according to the setting (Monday, Sunday or Saturday)
function weekStartOf(d: Date): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() - WEEK_START + 7) % 7));
  return m;
}

// Weekday abbreviations in week order (4 Jan 2026 = Sunday)
const weekdayNames = (style: 'narrow' | 'short') => Array.from({ length: 7 }, (_, i) => new Date(2026, 0, 4 + ((WEEK_START + i) % 7)).toLocaleDateString(LOCALE, { weekday: style }).replace('.', ''));

// Small month calendar (calendar sidebar and "My day")
function miniMonthHtml(month: Date, opts: { selected?: string; weekOf?: Date; dots?: (d: Date) => boolean; attr: string }): string {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = addDays(first, -((first.getDay() - WEEK_START + 7) % 7));
  const today = ymd(new Date());
  const wkFrom = opts.weekOf ? ymd(opts.weekOf) : '';
  const wkTo = opts.weekOf ? ymd(addDays(opts.weekOf, 6)) : '';
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = addDays(gridStart, i);
    const k = ymd(d);
    const cls = [d.getMonth() !== month.getMonth() ? 'out' : '', k === today ? 'today' : '', k === opts.selected ? 'sel' : '', wkFrom && k >= wkFrom && k <= wkTo ? 'wk' : ''].join(' ');
    return `<button type="button" class="ag-d ${cls}" ${opts.attr}="${k}">${d.getDate()}${opts.dots?.(d) ? '<i></i>' : ''}</button>`;
  }).join('');
  return `<div class="ag-grid">${weekdayNames('narrow').map((w) => `<span class="ag-wd">${esc(w)}</span>`).join('')}${cells}</div>`;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localDT = (d: Date) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parseYmd = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function readHidden(): string[] {
  try {
    return JSON.parse(localStorage.getItem('hiddenCalendars') || '[]');
  } catch {
    return [];
  }
}

function saveHidden(): void {
  try {
    localStorage.setItem('hiddenCalendars', JSON.stringify([...hiddenCals]));
  } catch {
    /* ignore */
  }
}

const calOf = (id: string) => calendars.find((c) => c.id === id);
const calColor = (id: string) => calOf(id)?.color ?? '#969993';

function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function setCalStatus(text: string): void {
  el('#cal-status').textContent = text;
}

// ---------- View ----------

// Load once (also for "New event" from the title bar)
let calLoading: Promise<void> | null = null;
function ensureCalendars(): Promise<void> {
  if (!calLoading) {
    calLoaded = true;
    calLoading = loadCalendars();
  }
  return calLoading;
}

document.addEventListener('viewchange', (e) => {
  if ((e as CustomEvent<string>).detail !== 'cal') return;
  ensureCalendars();
  scrollToMorning();
});

// ---------- Load calendars ----------

async function loadCalendars(): Promise<void> {
  // 1. straight from the cache
  try {
    calAccounts = await window.api.cal.listAccounts();
    const cached = await window.api.cal.cached([], weekStart.toISOString());
    if (cached.calendars.length) {
      calendars = cached.calendars;
      renderCalList();
      await showCachedWeek();
    }
  } catch {
    /* cache empty */
  }
  // 2. fresh from the server
  setCalStatus(t('status.updating'));
  try {
    const res = await window.api.cal.listCalendars();
    calendars = res.calendars;
    const errs = res.errors.map((e) => `${calAccounts.find((a) => a.id === e.accountId)?.name ?? t('account.generic')}: ${e.message}`);
    setCalStatus(errs.join(' · ') || (calAccounts.length ? '' : t('cal.noAccount')));
  } catch (e) {
    setCalStatus(errMsg(e));
  }
  renderCalList();
  await loadEvents();
}

const visibleCalIds = () => calendars.filter((c) => !hiddenCals.has(c.id)).map((c) => c.id);

async function showCachedWeek(): Promise<void> {
  const start = weekStart;
  try {
    const res = await window.api.cal.cached(visibleCalIds(), start.toISOString());
    if (start !== weekStart) return;
    calEvents = res.events;
    renderWeek();
  } catch {
    /* ignore */
  }
}

function renderCalList(): void {
  el('#cal-list').innerHTML = calAccounts
    .map((acc) => {
      const items = calendars
        .filter((c) => c.accountId === acc.id)
        .map(
          (c) => `<label class="cal-item">
            <input type="checkbox" data-cal="${esc(c.id)}" ${hiddenCals.has(c.id) ? '' : 'checked'} style="accent-color:${c.color}">
            <span class="name">${esc(c.name)}</span>
          </label>`,
        )
        .join('');
      return `<div class="cal-group"><span>${esc(acc.name.toUpperCase())}</span></div>${items}`;
    })
    .join('');
}

async function loadEvents(): Promise<void> {
  const visible = visibleCalIds();
  calEvents = [];
  await showCachedWeek(); // cache first, then server
  if (!visible.length) {
    renderWeek();
    return;
  }
  const start = weekStart;
  try {
    const res = await window.api.cal.listEvents(visible, start.toISOString(), addDays(start, 7).toISOString());
    if (start !== weekStart) return; // user has paged on in the meantime
    calEvents = res.events;
    const errs = res.errors.map((e) => `${calOf(e.calendarId)?.name ?? t('cal.calendar')}: ${e.message}`);
    if (errs.length) setCalStatus(errs.join(' · '));
  } catch (e) {
    setCalStatus(errMsg(e));
  }
  renderWeek();
}

// ---------- Draw the week ----------

interface Placed {
  ev: CalEvent;
  top: number;
  height: number;
  col: number;
  cols: number;
  start: Date;
  end: Date;
}

function layoutDay(dayStart: Date, events: CalEvent[]): Placed[] {
  const dayEnd = addDays(dayStart, 1);
  const items = events
    .map((ev) => {
      const s = new Date(Math.max(new Date(ev.start).getTime(), dayStart.getTime()));
      const e = new Date(Math.min(new Date(ev.end).getTime(), dayEnd.getTime()));
      return { ev, s, e };
    })
    .filter((x) => x.e > x.s)
    .sort((a, b) => a.s.getTime() - b.s.getTime() || b.e.getTime() - a.e.getTime());

  const placed: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = 0;
  let colEnds: number[] = [];

  const flush = () => {
    cluster.forEach((p) => (p.cols = colEnds.length));
    cluster = [];
    colEnds = [];
  };

  for (const x of items) {
    if (cluster.length && x.s.getTime() >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= x.s.getTime());
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(0);
    }
    colEnds[col] = x.e.getTime();
    clusterEnd = Math.max(clusterEnd, x.e.getTime());
    const minutes = (x.s.getTime() - dayStart.getTime()) / 60000;
    const dur = (x.e.getTime() - x.s.getTime()) / 60000;
    const p: Placed = { ev: x.ev, top: (minutes / 60) * HOUR_PX, height: Math.max(20, (dur / 60) * HOUR_PX - 2), col, cols: 1, start: x.s, end: x.e };
    cluster.push(p);
    placed.push(p);
  }
  flush();
  return placed;
}

function renderWeek(): void {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = ymd(new Date());
  const last = days[6];

  el('#cal-week').textContent = `${t('cal.week', { n: isoWeek(addDays(weekStart, (8 - WEEK_START) % 7)) })} · ${weekStart.getFullYear()}`.toUpperCase();
  renderCalMini();
  // "19.–25. Oktober" or "19–25 October" – the format comes from the language
  const range = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long' }).formatRange(weekStart, last);
  el('#cal-range').innerHTML = `${esc(range)} <em>${last.getFullYear()}.</em>`;

  const timed = calEvents.filter((e) => !e.allDay);
  const allDay = calEvents.filter((e) => e.allDay);

  const head = days
    .map((d, i) => `<div class="day-head${ymd(d) === today ? ' today' : ''}"><span class="wd">${esc(d.toLocaleDateString(LOCALE, { weekday: 'short' }).replace('.', '').toUpperCase())}</span><span class="dn">${d.getDate()}</span></div>`)
    .join('');

  const allDayCells = days
    .map((d) => {
      const key = ymd(d);
      const chips = allDay
        .filter((e) => e.start <= key && key < e.end)
        .map((e) => {
          const c = calColor(e.calendarId);
          return `<button class="chip" data-ev="${esc(e.id)}" style="background:${tint(c, 0.2)};border-color:${tint(c, 0.7)}">${e.recurring ? '↻ ' : ''}${esc(e.title)}</button>`;
        })
        .join('');
      return `<div class="allday-cell" data-day="${key}">${chips}</div>`;
    })
    .join('');

  const hours = Array.from({ length: 24 }, (_, h) => `<div class="h">${h ? pad(h) + ':00' : ''}</div>`).join('');

  const cols = days
    .map((d) => {
      const isToday = ymd(d) === today;
      const evs = layoutDay(d, timed)
        .map((p) => {
          const c = calColor(p.ev.calendarId);
          const w = 100 / p.cols;
          return `<button class="ev" data-ev="${esc(p.ev.id)}" style="top:${p.top}px;height:${p.height}px;left:calc(${p.col * w}% + 3px);width:calc(${w}% - 6px);background:${tint(c, 0.22)};border-color:${tint(c, 0.75)}">
            <span class="t">${hm(p.start)}–${hm(p.end)}${p.ev.recurring ? ` <span class="rep" title="${esc(t('rec.seriesTip'))}">↻</span>` : ''}</span>
            <span class="n">${esc(p.ev.title)}</span>
            ${p.ev.location && p.height > 56 ? `<span class="l">${esc(p.ev.location)}</span>` : ''}
            <span class="ev-resize" data-resize="1"></span>
          </button>`;
        })
        .join('');
      const now = new Date();
      const nowLine = isToday ? `<div class="now-line" style="top:${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX}px"></div>` : '';
      return `<div class="day-col${isToday ? ' today' : ''}" data-day="${ymd(d)}">${evs}${nowLine}</div>`;
    })
    .join('');

  const body = el('#week');
  const scroll = body.querySelector<HTMLElement>('.week-body')?.scrollTop;
  body.innerHTML = `
    <div class="week-row week-head"><div></div>${head}</div>
    <div class="week-row allday-row"><div class="allday-label">${esc(t('cal.allDayShort'))}</div>${allDayCells}</div>
    <div class="week-body"><div class="week-row"><div class="hours">${hours}</div>${cols}</div></div>`;
  if (scroll !== undefined) el('.week-body').scrollTop = scroll;
  else scrollToMorning();
}

function scrollToMorning(): void {
  const b = document.querySelector<HTMLElement>('.week-body');
  if (b && b.scrollTop === 0) b.scrollTop = 7 * HOUR_PX;
}

// ---------- Navigation ----------

el('#cal-prev').addEventListener('click', () => {
  weekStart = addDays(weekStart, -7);
  loadEvents();
});
el('#cal-next').addEventListener('click', () => {
  weekStart = addDays(weekStart, 7);
  loadEvents();
});
el('#cal-today').addEventListener('click', () => {
  weekStart = weekStartOf(new Date());
  loadEvents();
});

setInterval(() => {
  if (el('.app').dataset.view === 'cal') renderWeek();
}, 60_000);

// ---------- Calendar list: show/hide, remove account ----------

el('#cal-list').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const id = input.dataset.cal;
  if (!id) return;
  if (input.checked) hiddenCals.delete(id);
  else hiddenCals.add(id);
  saveHidden();
  loadEvents();
});

// ---------- Add CalDAV account ----------

const calAddDlg = el<HTMLDialogElement>('#dlg-cal-add');
const calAddForm = el<HTMLFormElement>('#form-cal-add');
const calAddField = (n: string) => calAddForm.elements.namedItem(n) as HTMLInputElement;

// Opened from Settings → Accounts
let editingCalAcc: string | null = null; // set = edit login

function setCalDialogMode(edit: boolean): void {
  calAddDlg.querySelector('h2')!.innerHTML = t(edit ? 'dav.editTitle' : 'cal.connectTitle');
  calAddField('password').required = !edit;
  calAddField('password').placeholder = edit ? t('account.passKeep') : '';
  el('#btn-cal-add-save').textContent = t(edit ? 'btn.saveConnect' : 'btn.connect');
}

function openAddCalAccount(): void {
  editingCalAcc = null;
  calAddForm.reset();
  setCalDialogMode(false);
  el('#cal-add-error').textContent = '';
  calAddDlg.showModal();
}

function openEditCalAccount(acc: CalAccount): void {
  editingCalAcc = acc.id;
  calAddForm.reset();
  setCalDialogMode(true);
  calAddField('name').value = acc.name;
  calAddField('serverUrl').value = acc.serverUrl;
  calAddField('username').value = acc.username;
  el('#cal-add-error').textContent = '';
  calAddDlg.showModal();
}
el('#btn-cal-add-cancel').addEventListener('click', () => calAddDlg.close());

calAddForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = el<HTMLButtonElement>('#btn-cal-add-save');
  btn.disabled = true;
  btn.textContent = t('btn.connecting');
  el('#cal-add-error').textContent = '';
  try {
    const input = {
      name: calAddField('name').value.trim(),
      serverUrl: calAddField('serverUrl').value.trim(),
      username: calAddField('username').value.trim(),
      password: calAddField('password').value,
    };
    if (editingCalAcc) await window.api.cal.updateAccount(editingCalAcc, input);
    else await window.api.cal.addAccount(input);
    calAddDlg.close();
    await loadCalendars();
  } catch (err) {
    el('#cal-add-error').textContent = errMsg(err);
  } finally {
    btn.disabled = false;
    btn.textContent = t(editingCalAcc ? 'btn.saveConnect' : 'btn.connect');
  }
});

// ---------- Event dialog ----------

const evDlg = el<HTMLDialogElement>('#dlg-event');
const evForm = el<HTMLFormElement>('#form-event');
const evField = (n: string) => evForm.elements.namedItem(n) as HTMLInputElement;
const evCalSelect = () => evForm.elements.namedItem('calendar') as HTMLSelectElement;

function applyAllDay(allDay: boolean): void {
  const s = evField('start');
  const en = evField('end');
  const sv = s.value;
  const ev = en.value;
  s.type = en.type = allDay ? 'date' : 'datetime-local';
  if (allDay) {
    s.value = sv.slice(0, 10);
    en.value = ev.slice(0, 10);
  } else {
    s.value = sv.length === 10 ? `${sv}T09:00` : sv;
    en.value = ev.length === 10 ? `${ev}T10:00` : ev;
  }
}

function openEventDialog(ev: CalEvent | null, start?: Date, end?: Date): void {
  const writable = calendars.filter((c) => !hiddenCals.has(c.id));
  if (!ev && !writable.length) {
    setCalStatus(t(calendars.length ? 'cal.showOne' : 'cal.addAccountFirst'));
    return;
  }
  editingEvent = ev;
  evForm.reset();
  el('#event-error').textContent = '';

  // Existing event: the calendar can be changed (the event is moved)
  const options = ev ? calendars.filter((c) => c.id === ev.calendarId || !hiddenCals.has(c.id)) : writable;
  evCalSelect().innerHTML = options.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} · ${esc(c.accountName)}</option>`).join('');
  if (ev) evCalSelect().value = ev.calendarId;
  evCalSelect().disabled = false;

  if (ev) {
    el('#event-title').innerHTML = t('cal.editTitle');
    evField('title').value = ev.title;
    evField('location').value = ev.location;
    (evForm.elements.namedItem('description') as HTMLTextAreaElement).value = ev.description;
    evField('allDay').checked = ev.allDay;
    evField('start').type = evField('end').type = ev.allDay ? 'date' : 'datetime-local';
    if (ev.allDay) {
      evField('start').value = ev.start;
      evField('end').value = ymd(addDays(parseYmd(ev.end), -1)); // displayed inclusive
    } else {
      evField('start').value = localDT(new Date(ev.start));
      evField('end').value = localDT(new Date(ev.end));
    }
  } else {
    el('#event-title').innerHTML = t('cal.newTitle');
    const s = start ?? new Date(new Date().setMinutes(0, 0, 0) + 3600000);
    evField('allDay').checked = false;
    evField('start').type = evField('end').type = 'datetime-local';
    evField('start').value = localDT(s);
    evField('end').value = localDT(end && end > s ? end : new Date(s.getTime() + 3600000));
  }

  fillRecurrence(ev?.rrule ?? null, ev ? new Date(ev.allDay ? parseYmd(ev.start) : ev.start) : new Date(evField('start').value));
  el('#event-hint').textContent = ev?.recurring ? t('cal.seriesHint') : '';
  el<HTMLButtonElement>('#btn-event-delete').hidden = !ev;
  el<HTMLButtonElement>('#btn-event-mail').hidden = !ev;
  fillAttendees(ev);
  evDlg.showModal();
  evField('title').focus();
}

evField('allDay').addEventListener('change', () => applyAllDay(evField('allDay').checked));

evField('start').addEventListener('change', () => {
  // Move the end along if it would otherwise be before the start
  const s = evField('start').value;
  const e = evField('end').value;
  if (!s || (e && e > s)) return;
  if (evField('allDay').checked) evField('end').value = s;
  else evField('end').value = localDT(new Date(new Date(s).getTime() + 3600000));
});

el('#btn-event-cancel').addEventListener('click', () => evDlg.close());

evForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const allDay = evField('allDay').checked;
  const sv = evField('start').value;
  const envv = evField('end').value;
  const ev = editingEvent;
  const input: EventInput = {
    calendarId: ev?.calendarId ?? evCalSelect().value,
    moveTo: ev && evCalSelect().value !== ev.calendarId ? evCalSelect().value : undefined,
    url: ev?.url,
    title: evField('title').value,
    location: evField('location').value,
    description: (evForm.elements.namedItem('description') as HTMLTextAreaElement).value,
    allDay,
    start: allDay ? sv : new Date(sv).toISOString(),
    end: allDay ? ymd(addDays(parseYmd(envv), 1)) : new Date(envv).toISOString(),
    rrule: readRecurrence(),
  };
  if (ev?.recurring) {
    // Rule changed → applies to the series; otherwise ask: only this one or all
    const ruleChanged = input.rrule !== undefined && JSON.stringify(input.rrule) !== JSON.stringify(stripRule(ev.rrule));
    const scope = ruleChanged ? 'series' : await askScope(t('scope.editText', { title: ev.title }));
    if (!scope) return;
    input.scope = scope;
    input.occurrence = ev.occurrence;
    input.origStart = ev.start;
    if (scope === 'occurrence') delete input.rrule;
  } else if (!ev && !input.rrule) delete input.rrule;
  // Attendees (only if I am the organizer, or for new events)
  const people = readAttendees();
  let invite: { identityId: string } | undefined;
  if (people && !organizedByOther(ev)) {
    const idn = inviteIdentities.find((i) => i.id === (evForm.elements.namedItem('inviteAs') as HTMLSelectElement).value) ?? inviteIdentities[0];
    input.attendees = people;
    if (idn) input.organizer = { email: idn.email, name: idn.name };
    if (people.length && idn && evField('sendInvites').checked) invite = { identityId: idn.id };
  }
  const btn = el<HTMLButtonElement>('#btn-event-save');
  btn.disabled = true;
  el('#event-error').textContent = '';
  try {
    const res = await window.api.cal.saveEvent(input, invite);
    evDlg.close();
    if (res && res.invited) setCalStatus(t('invite.sent', { n: res.invited }));
    await loadEvents();
  } catch (err) {
    el('#event-error').textContent = errMsg(err);
  } finally {
    btn.disabled = false;
  }
});

el('#btn-event-delete').addEventListener('click', async () => {
  const ev = editingEvent;
  if (!ev) return;
  let occurrence: string | undefined;
  if (ev.recurring) {
    const scope = await askScope(t('scope.deleteText', { title: ev.title }));
    if (!scope) return;
    if (scope === 'occurrence') occurrence = ev.occurrence;
    else if (!confirm(t('cal.confirmDeleteSeries', { title: ev.title }))) return;
  } else if (!confirm(t('cal.confirmDelete', { title: ev.title }))) return;
  // Inform attendees (cancellation) if I organized the event
  let cancel: { identityId: string } | undefined;
  const orgIdn = !occurrence && ev.attendees?.length && !organizedByOther(ev) ? inviteIdentities.find((i) => i.email.toLowerCase() === ev.organizer?.email.toLowerCase()) : undefined;
  if (orgIdn && confirm(t('invite.confirmCancel', { n: ev.attendees!.length - 1 }))) cancel = { identityId: orgIdn.id };
  try {
    await window.api.cal.deleteEvent(ev.url, occurrence, cancel);
    evDlg.close();
    await loadEvents();
  } catch (err) {
    el('#event-error').textContent = errMsg(err);
  }
});

// ---------- Recurrence in the event dialog ----------

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const recSel = (n: string) => evForm.elements.namedItem(n) as HTMLSelectElement;
let customRule: RRuleInfo | null = null; // complex rule from the server: kept as long as "Custom" is selected

function stripRule(r?: RRuleInfo | null): RRuleInfo | null {
  if (!r) return null;
  return { freq: r.freq, interval: r.interval || 1, byday: [...(r.byday ?? [])], ...(r.count ? { count: r.count } : r.until ? { until: r.until } : {}) };
}

function renderRecDays(selected: string[]): void {
  // Weekday names from the language (Monday = 5 Jan 2026)
  el('#rec-days').innerHTML = WEEKDAYS.map((d, i) => {
    const name = new Date(2026, 0, 5 + i).toLocaleDateString(LOCALE, { weekday: 'short' }).replace('.', '');
    return `<label class="rec-day"><input type="checkbox" value="${d}"${selected.includes(d) ? ' checked' : ''}><span>${esc(name)}</span></label>`;
  }).join('');
}

function syncRecUi(): void {
  const rep = recSel('repeat').value;
  const on = !!rep && rep !== 'CUSTOM' && rep !== 'WEEKDAYS';
  evForm.querySelectorAll<HTMLElement>('.rec-more').forEach((x) => (x.hidden = !rep || rep === 'CUSTOM'));
  (evForm.querySelector('label.port.rec-more') as HTMLElement).hidden = !on;
  el('#rec-days').hidden = rep !== 'WEEKLY';
  const end = recSel('repeatEnd').value;
  el('#rec-until').hidden = !rep || rep === 'CUSTOM' || end !== 'until';
  el('#rec-count').hidden = !rep || rep === 'CUSTOM' || end !== 'count';
  el('#event-hint').textContent = rep === 'CUSTOM' ? t('rec.customHint') : editingEvent?.recurring ? t('cal.seriesHint') : '';
}

function fillRecurrence(r: RRuleInfo | null, start: Date): void {
  customRule = r?.custom ? r : null;
  const customOpt = recSel('repeat').querySelector<HTMLOptionElement>('option[value="CUSTOM"]')!;
  customOpt.hidden = !customRule;
  const isWeekdays = r && r.freq === 'WEEKLY' && r.interval === 1 && r.byday.join() === 'MO,TU,WE,TH,FR';
  recSel('repeat').value = !r ? '' : customRule ? 'CUSTOM' : isWeekdays ? 'WEEKDAYS' : r.freq;
  evField('interval').value = String(r?.interval ?? 1);
  recSel('repeatEnd').value = r?.count ? 'count' : r?.until ? 'until' : 'never';
  evField('until').value = r?.until ?? ymd(addDays(start, 90));
  evField('count').value = String(r?.count ?? 10);
  renderRecDays(r?.byday?.length ? r.byday : [WEEKDAYS[(start.getDay() + 6) % 7]]);
  syncRecUi();
}

// undefined = unchanged (custom rule), null = no recurrence
function readRecurrence(): RRuleInfo | null | undefined {
  const rep = recSel('repeat').value;
  if (!rep) return null;
  if (rep === 'CUSTOM') return undefined;
  const r: RRuleInfo =
    rep === 'WEEKDAYS'
      ? { freq: 'WEEKLY', interval: 1, byday: ['MO', 'TU', 'WE', 'TH', 'FR'] }
      : { freq: rep as RRuleInfo['freq'], interval: Math.max(1, Number(evField('interval').value) || 1), byday: [] };
  if (rep === 'WEEKLY') r.byday = [...el('#rec-days').querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value);
  const end = recSel('repeatEnd').value;
  if (end === 'count') r.count = Math.max(1, Number(evField('count').value) || 1);
  else if (end === 'until' && evField('until').value) r.until = evField('until').value;
  return r;
}

recSel('repeat').addEventListener('change', syncRecUi);
recSel('repeatEnd').addEventListener('change', syncRecUi);

// ---------- Series: only this occurrence or all? ----------

function askScope(text: string): Promise<'series' | 'occurrence' | null> {
  const dlg = el<HTMLDialogElement>('#dlg-scope');
  el('#scope-text').textContent = text;
  return new Promise((resolve) => {
    const done = (v: 'series' | 'occurrence' | null) => {
      dlg.removeEventListener('click', onClick);
      dlg.removeEventListener('cancel', onCancel);
      dlg.close();
      resolve(v);
    };
    const onClick = (e: Event) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-scope-pick]');
      if (b) done((b.dataset.scopePick || null) as 'series' | 'occurrence' | null);
    };
    const onCancel = (e: Event) => {
      e.preventDefault();
      done(null);
    };
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
    dlg.querySelector<HTMLElement>('[data-scope-pick="occurrence"]')?.focus();
  });
}

// ---------- Dragging: move events (also to other days) and change duration ----------

const SNAP_MIN = 15;
let dragJustEnded = false;

async function moveEvent(ev: CalEvent, deltaStartMs: number, deltaEndMs: number): Promise<void> {
  const input: EventInput = {
    calendarId: ev.calendarId,
    url: ev.url,
    title: ev.title,
    location: ev.location,
    description: ev.description,
    allDay: ev.allDay,
    start: ev.allDay ? ymd(addDays(parseYmd(ev.start), Math.round(deltaStartMs / 86400000))) : new Date(new Date(ev.start).getTime() + deltaStartMs).toISOString(),
    end: ev.allDay ? ymd(addDays(parseYmd(ev.end), Math.round(deltaEndMs / 86400000))) : new Date(new Date(ev.end).getTime() + deltaEndMs).toISOString(),
  };
  if (ev.recurring) {
    const scope = await askScope(t('scope.moveText', { title: ev.title }));
    if (!scope) return void renderWeek();
    Object.assign(input, { scope, occurrence: ev.occurrence, origStart: ev.start });
  }
  setCalStatus(t('status.saving'));
  try {
    // Own event with attendees → inform them about the new time if wanted
  let invite: { identityId: string } | undefined;
  const orgIdn = ev.attendees?.length && !organizedByOther(ev) ? inviteIdentities.find((x) => x.email.toLowerCase() === ev.organizer?.email.toLowerCase()) : undefined;
  if (orgIdn && confirm(t('invite.notifyMove'))) {
    input.attendees = ev.attendees!.filter((a) => a.email.toLowerCase() !== orgIdn.email.toLowerCase()).map((a) => ({ email: a.email, name: a.name }));
    input.organizer = { email: orgIdn.email, name: orgIdn.name };
    invite = { identityId: orgIdn.id };
  }
  await window.api.cal.saveEvent(input, invite);
    setCalStatus('');
  } catch (err) {
    setCalStatus(errMsg(err));
  }
  await loadEvents();
}

el('#week').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  const box = target.closest<HTMLElement>('.ev, .chip');
  if (!box?.dataset.ev) {
    const col = target.closest<HTMLElement>('.day-col');
    if (col?.dataset.day) startCreateDrag(col, e);
    return;
  }
  const ev = calEvents.find((x) => x.id === box.dataset.ev);
  if (!ev) return;
  const resize = !!target.closest('[data-resize]');
  const allDayChip = box.classList.contains('chip');
  const startX = e.clientX;
  const startY = e.clientY;
  const startCol = box.closest<HTMLElement>('.day-col, .allday-cell')!;
  const origTop = box.offsetTop;
  const origHeight = box.offsetHeight;
  let active = false;
  let dayDelta = 0;
  let minDelta = 0;

  const move = (m: PointerEvent) => {
    if (!active) {
      if (Math.abs(m.clientX - startX) + Math.abs(m.clientY - startY) < 5) return;
      active = true;
      box.classList.add('dragging');
      document.body.classList.add('cal-dragging');
    }
    // Target day under the mouse pointer (not when resizing)
    if (!resize) {
      box.style.pointerEvents = 'none';
      const under = document.elementFromPoint(m.clientX, m.clientY)?.closest<HTMLElement>(allDayChip ? '.allday-cell' : '.day-col');
      box.style.pointerEvents = '';
      if (under?.dataset.day && under !== box.parentElement) {
        under.appendChild(box);
        if (!allDayChip) {
          box.style.left = '3px';
          box.style.width = 'calc(100% - 6px)';
        }
      }
      const curDay = (box.parentElement as HTMLElement).dataset.day!;
      dayDelta = Math.round((parseYmd(curDay).getTime() - parseYmd(startCol.dataset.day!).getTime()) / 86400000);
    }
    if (allDayChip) return;
    const dyMin = Math.round(((m.clientY - startY) / HOUR_PX) * 60 / SNAP_MIN) * SNAP_MIN;
    if (resize) {
      minDelta = Math.max(dyMin, -Math.floor(((origHeight - HOUR_PX / 4) / HOUR_PX) * 60 / SNAP_MIN) * SNAP_MIN);
      box.style.height = `${origHeight + (minDelta / 60) * HOUR_PX}px`;
    } else {
      minDelta = dyMin;
      box.style.top = `${Math.max(0, origTop + (minDelta / 60) * HOUR_PX)}px`;
    }
    const tLabel = box.querySelector('.t');
    if (tLabel) {
      const s = new Date(new Date(ev.start).getTime() + (resize ? 0 : minDelta * 60000 + dayDelta * 86400000));
      const en = new Date(new Date(ev.end).getTime() + minDelta * 60000 + (resize ? 0 : dayDelta * 86400000));
      tLabel.textContent = `${hm(s)}–${hm(en)}`;
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!active) return;
    box.classList.remove('dragging');
    document.body.classList.remove('cal-dragging');
    dragJustEnded = true;
    setTimeout(() => (dragJustEnded = false), 0);
    const dayMs = dayDelta * 86400000;
    const minMs = minDelta * 60000;
    if (!dayMs && !minMs) return void renderWeek();
    if (resize) moveEvent(ev, 0, minMs);
    else moveEvent(ev, dayMs + minMs, dayMs + minMs);
  };
  // listen on the window: the event changes its day column while dragging (new parent element)
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
});

el('#btn-new-event').addEventListener('click', () => openEventDialog(null));

// ---------- Empty area: hover shows the time, dragging creates a new event ----------

const minutesAt = (col: HTMLElement, clientY: number, step: number, round = Math.floor) =>
  Math.max(0, Math.min(24 * 60, round((((clientY - col.getBoundingClientRect().top) / HOUR_PX) * 60) / step) * step));
const fmtMin = (m: number) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;

function hoverBox(col: HTMLElement): HTMLElement {
  let h = col.querySelector<HTMLElement>('.slot-hover');
  if (!h) {
    document.querySelectorAll('.slot-hover').forEach((x) => x.remove());
    h = document.createElement('div');
    h.className = 'slot-hover';
    col.appendChild(h);
  }
  return h;
}

function clearHover(): void {
  document.querySelectorAll('.slot-hover').forEach((x) => x.remove());
  document.querySelectorAll('.week-head .day-head.hover, .hours .h.hover').forEach((x) => x.classList.remove('hover'));
}

el('#week').addEventListener('pointermove', (e) => {
  if (document.body.classList.contains('cal-dragging')) return;
  const target = e.target as HTMLElement;
  const col = target.closest<HTMLElement>('.day-col');
  if (!col?.dataset.day || target.closest('.ev')) return clearHover();
  const m = Math.min(minutesAt(col, e.clientY, 30), 23.5 * 60);
  const h = hoverBox(col);
  h.style.top = `${(m / 60) * HOUR_PX}px`;
  h.style.height = `${HOUR_PX / 2}px`;
  h.textContent = `${fmtMin(m)}–${fmtMin(m + 30)}`;
  // highlight weekday and hour
  const idx = [...col.parentElement!.querySelectorAll('.day-col')].indexOf(col);
  document.querySelectorAll('.week-head .day-head').forEach((d, i) => d.classList.toggle('hover', i === idx));
  document.querySelectorAll('.hours .h').forEach((d, i) => d.classList.toggle('hover', i === Math.floor(m / 60)));
});
el('#week').addEventListener('pointerleave', clearHover);

function startCreateDrag(col: HTMLElement, e: PointerEvent): void {
  const startY = e.clientY;
  const anchor = Math.min(minutesAt(col, startY, SNAP_MIN), 24 * 60 - SNAP_MIN);
  let active = false;
  let from = anchor;
  let to = anchor + SNAP_MIN;
  const move = (m: PointerEvent) => {
    if (!active) {
      if (Math.abs(m.clientY - startY) < 6) return;
      active = true;
      clearHover();
      document.body.classList.add('cal-dragging');
      const h = hoverBox(col);
      h.classList.add('creating');
    }
    const cur = minutesAt(col, m.clientY, SNAP_MIN, Math.round);
    from = Math.min(anchor, cur);
    to = Math.max(anchor + SNAP_MIN, cur);
    if (to - from < SNAP_MIN) to = from + SNAP_MIN;
    const h = hoverBox(col);
    h.style.top = `${(from / 60) * HOUR_PX}px`;
    h.style.height = `${((to - from) / 60) * HOUR_PX}px`;
    h.textContent = `${fmtMin(from)}–${fmtMin(to)}`;
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!active) return; // normal click → the click handler creates a 30-minute event
    document.body.classList.remove('cal-dragging');
    dragJustEnded = true;
    setTimeout(() => (dragJustEnded = false), 0);
    const day = parseYmd(col.dataset.day!);
    const s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, from);
    const en = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, to);
    openEventDialog(null, s, en);
    clearHover();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// Click on an event → edit, click on an empty area → new event at the clicked time
el('#week').addEventListener('click', (e) => {
  if (dragJustEnded) return; // was a drag, not a click
  const target = e.target as HTMLElement;
  const evId = target.closest<HTMLElement>('[data-ev]')?.dataset.ev;
  if (evId) {
    const ev = calEvents.find((x) => x.id === evId);
    if (ev) openEventDialog(ev);
    return;
  }
  const col = target.closest<HTMLElement>('.day-col');
  if (!col?.dataset.day) return;
  const y = (e as MouseEvent).clientY - col.getBoundingClientRect().top;
  const minutes = Math.max(0, Math.min(23.5 * 60, Math.floor(((y / HOUR_PX) * 60) / 30) * 30));
  const start = parseYmd(col.dataset.day);
  start.setMinutes(minutes);
  openEventDialog(null, start);
});



// ---------- Month calendar at the bottom of the sidebar ----------

let calMiniMonth = new Date(weekStart.getFullYear(), weekStart.getMonth(), 1);

function renderCalMini(): void {
  const box = document.querySelector<HTMLElement>('#cal-mini');
  if (!box) return;
  box.innerHTML = `
    <div class="ag-month">
      <button type="button" class="icon-btn sm" data-mini-nav="-1" aria-label="${esc(t('agenda.prevMonth'))}">‹</button>
      <b>${esc(calMiniMonth.toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' }))}</b>
      <button type="button" class="icon-btn sm" data-mini-nav="1" aria-label="${esc(t('agenda.nextMonth'))}">›</button>
    </div>
    ${miniMonthHtml(calMiniMonth, { weekOf: weekStart, attr: 'data-mini-day' })}`;
}

el('#cal-mini').addEventListener('click', (e) => {
  const tgt = e.target as HTMLElement;
  const nav = tgt.closest<HTMLElement>('[data-mini-nav]')?.dataset.miniNav;
  if (nav) {
    calMiniMonth = new Date(calMiniMonth.getFullYear(), calMiniMonth.getMonth() + Number(nav), 1);
    return renderCalMini();
  }
  const day = tgt.closest<HTMLElement>('[data-mini-day]')?.dataset.miniDay;
  if (!day) return;
  const d = parseYmd(day);
  weekStart = weekStartOf(d);
  calMiniMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  loadEvents();
});

// Week start changed (Settings → Appearance)
function applyWeekStart(): void {
  weekStart = weekStartOf(weekStart);
  if (calLoaded) loadEvents();
  else renderCalMini();
  if (typeof renderAgendaCal === 'function') {
    agLoadedFor = '';
    if (agenda.on && agenda.cal) loadAgendaEvents();
  }
}
renderCalMini();


// ---------- Attendees / invitations ----------

let inviteIdentities: Identity[] = [];
let attendeesBefore = '';
window.api.settings
  .get()
  .then((st) => (inviteIdentities = st.identities))
  .catch(() => {});

const PARTSTAT_ICON: Record<string, string> = { ACCEPTED: '✓', DECLINED: '✗', TENTATIVE: '?', 'NEEDS-ACTION': '…' };

// Event organized by someone else (I am only invited)?
function organizedByOther(ev: CalEvent | null): boolean {
  if (!ev?.organizer?.email) return false;
  return !inviteIdentities.some((i) => i.email.toLowerCase() === ev.organizer!.email.toLowerCase());
}

function fillAttendees(ev: CalEvent | null): void {
  const list = (ev?.attendees ?? []).filter((a) => a.email.toLowerCase() !== ev?.organizer?.email.toLowerCase());
  const input = evField('attendees');
  input.value = list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');
  attendeesBefore = input.value;
  const other = organizedByOther(ev);
  input.readOnly = other;
  el('#att-status').innerHTML = ev?.attendees?.length
    ? (other ? `<span class="att-org">${esc(t('invite.organizer'))}: ${esc(ev.organizer?.name || ev.organizer?.email || '')}</span>` : '') +
      list.map((a) => `<span class="att-chip ps-${(a.partstat ?? 'NEEDS-ACTION').toLowerCase()}" title="${esc(t(`invite.ps.${a.partstat ?? 'NEEDS-ACTION'}`))}">${PARTSTAT_ICON[a.partstat ?? 'NEEDS-ACTION'] ?? '…'} ${esc(a.name || a.email)}</span>`).join('')
    : '';
  const sel = evForm.elements.namedItem('inviteAs') as HTMLSelectElement;
  sel.innerHTML = inviteIdentities.map((i) => `<option value="${esc(i.id)}">${esc(i.name ? `${i.name} <${i.email}>` : i.email)}</option>`).join('');
  const org = inviteIdentities.find((i) => i.email.toLowerCase() === ev?.organizer?.email.toLowerCase());
  const calAcc = calendars.find((c) => c.id === (ev?.calendarId ?? evCalSelect().value));
  sel.value = (org ?? inviteIdentities.find((i) => i.primary && i.email.toLowerCase().includes((calAcc?.accountName ?? '').toLowerCase())) ?? inviteIdentities[0])?.id ?? '';
  evField('sendInvites').checked = false;
  syncInviteRow();
}

function syncInviteRow(): void {
  const has = !!evField('attendees').value.trim() && !evField('attendees').readOnly;
  el('#invite-row').hidden = !has;
}

evField('attendees').addEventListener('input', () => {
  syncInviteRow();
  // Attendees changed → suggest sending invitations
  if (evField('attendees').value.trim() !== attendeesBefore.trim()) evField('sendInvites').checked = true;
});

// "Name <a@b.ch>, c@d.ch; …" → list
function readAttendees(): { email: string; name?: string }[] | undefined {
  const raw = evField('attendees').value.trim();
  if (evField('attendees').readOnly) return undefined;
  if (!raw && !attendeesBefore) return undefined; // never had attendees → change nothing
  return raw
    .split(/[,;\n]+/)
    .map((p) => {
      const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(p);
      return m ? { name: m[1].trim(), email: m[2].trim() } : { email: p.trim() };
    })
    .filter((a) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a.email));
}

// Send event by mail (.ics as attachment)
el('#btn-event-mail').addEventListener('click', async () => {
  const ev = editingEvent;
  if (!ev) return;
  const ics = await window.api.cal.ics(ev.url).catch(() => null);
  if (!ics) return void (el('#event-error').textContent = t('err.eventNotLoaded'));
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(ics)));
  const when = ev.allDay
    ? parseYmd(ev.start).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : `${new Date(ev.start).toLocaleString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}–${hm(new Date(ev.end))}`;
  const lines = [ev.title, when, ev.location ? `${t('cal.location')}: ${ev.location}` : '', ev.description].filter(Boolean).map(esc).join('<br>');
  window.api.compose.open({ subject: ev.title, quoteHtml: `<p>${lines}</p>`, attachData: [{ filename: `${ev.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'termin'}.ics`, content: b64, contentType: 'text/calendar' }] });
});

// ---------- Search events ----------

let calSearchTimer: number | undefined;
let calSearchSeq = 0;

async function runCalSearch(): Promise<void> {
  const q = el<HTMLInputElement>('#cal-search').value.trim();
  const box = el('#cal-results');
  const seq = ++calSearchSeq;
  if (q.length < 2) return void (box.hidden = true);
  box.hidden = false;
  box.innerHTML = `<p class="hint">${esc(t('search.running'))}</p>`;
  await ensureCalendars();
  const res = await window.api.cal.search(q, visibleCalIds()).catch(() => [] as CalEvent[]);
  if (seq !== calSearchSeq) return;
  calSearchResults = res;
  box.innerHTML = res.length
    ? res
        .map((ev, i) => {
          const d = ev.allDay ? parseYmd(ev.start) : new Date(ev.start);
          const past = new Date(ev.end).getTime() < Date.now();
          return `<button type="button" class="cal-hit${past ? ' past' : ''}" data-hit="${i}" style="--ec:${calColor(ev.calendarId)}">
            <span class="ch-date">${esc(d.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}<small>${ev.allDay ? esc(t('agenda.allDay')) : hm(d)}</small></span>
            <span class="ch-title">${ev.recurring ? '↻ ' : ''}${esc(ev.title)}${ev.location ? `<small>${esc(ev.location)}</small>` : ''}</span>
          </button>`;
        })
        .join('')
    : `<p class="hint">${esc(t('mail.noHits'))}</p>`;
}

let calSearchResults: CalEvent[] = [];

el('#cal-search').addEventListener('input', () => {
  clearTimeout(calSearchTimer);
  calSearchTimer = window.setTimeout(runCalSearch, 400);
});
el('#cal-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(calSearchTimer);
    runCalSearch();
  } else if (e.key === 'Escape') {
    el<HTMLInputElement>('#cal-search').value = '';
    el('#cal-results').hidden = true;
  }
});
el('#cal-results').addEventListener('click', async (e) => {
  const i = (e.target as HTMLElement).closest<HTMLElement>('[data-hit]')?.dataset.hit;
  const ev = i !== undefined ? calSearchResults[Number(i)] : undefined;
  if (!ev) return;
  el('#cal-results').hidden = true;
  weekStart = weekStartOf(ev.allDay ? parseYmd(ev.start) : new Date(ev.start));
  await loadEvents();
  openEventDialog(calEvents.find((x) => x.id === ev.id) ?? ev);
});
document.addEventListener('mousedown', (e) => {
  if (!(e.target as HTMLElement).closest('.cal-search')) el('#cal-results').hidden = true;
});
