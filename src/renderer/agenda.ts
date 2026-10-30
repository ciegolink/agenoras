// Right sidebar in the mail view: calendar on top (month + today's events), open tasks below.
// Toggled from the title bar, the two parts individually via the buttons at the top of the sidebar.

interface AgendaPrefs {
  on: boolean;
  cal: boolean;
  tasks: boolean;
}

let agenda: AgendaPrefs = (() => {
  try {
    return { on: false, cal: true, tasks: true, ...JSON.parse(localStorage.getItem('ciegolink.agenda') || '{}') };
  } catch {
    return { on: false, cal: true, tasks: true };
  }
})();
let agMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let agDay = new Date(new Date().setHours(0, 0, 0, 0));
let agEvents: CalEvent[] = [];
let agLoadedFor = '';

function saveAgenda(): void {
  try {
    localStorage.setItem('ciegolink.agenda', JSON.stringify(agenda));
  } catch {
    /* ignore */
  }
}

function applyAgenda(): void {
  document.body.classList.toggle('agenda-on', agenda.on);
  el('#btn-agenda').classList.toggle('on', agenda.on);
  el('#btn-agenda').setAttribute('aria-pressed', String(agenda.on));
  document.querySelectorAll<HTMLElement>('#ag-toggles [data-ag]').forEach((b) => b.classList.toggle('on', agenda[b.dataset.ag as 'cal' | 'tasks']));
  el('#ag-cal').hidden = !agenda.cal;
  el('#ag-tasks').hidden = !agenda.tasks;
  applyCols();
  if (!agenda.on) return;
  if (agenda.cal) loadAgendaEvents();
  if (agenda.tasks) ensureTasks().then(renderAgendaTasks);
  renderAgendaCal();
  renderAgendaTasks();
}

// Calendar
const agKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function loadAgendaEvents(force = false): Promise<void> {
  await ensureCalendars();
  const from = new Date(agMonth.getFullYear(), agMonth.getMonth(), 1);
  const gridStart = addDays(from, -((from.getDay() - WEEK_START + 7) % 7));
  const gridEnd = addDays(gridStart, 42);
  const key = `${gridStart.toISOString()}|${visibleCalIds().join(',')}`;
  if (key === agLoadedFor && !force) return renderAgendaCal();
  agLoadedFor = key;
  const ids = visibleCalIds();
  if (!ids.length) {
    agEvents = [];
    return renderAgendaCal();
  }
  try {
    const res = await window.api.cal.listEvents(ids, gridStart.toISOString(), gridEnd.toISOString());
    agEvents = res.events;
  } catch {
    /* offline: use what is there */
  }
  renderAgendaCal();
}

const eventsOn = (day: Date) => {
  const k = agKey(day);
  const s = day.getTime();
  const e = addDays(day, 1).getTime();
  return agEvents
    .filter((ev) => (ev.allDay ? ev.start <= k && k < ev.end : new Date(ev.start).getTime() < e && new Date(ev.end).getTime() > s))
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
};

function agEventRow(ev: CalEvent): string {
  const c = calColor(ev.calendarId);
  const time = ev.allDay ? t('agenda.allDay') : `${hm(new Date(ev.start))}–${hm(new Date(ev.end))}`;
  return `<button type="button" class="ag-ev" data-ag-ev="${esc(ev.id)}" style="--ec:${c}">
    <span class="ag-time">${esc(time)}</span><span class="ag-title">${ev.recurring ? '↻ ' : ''}${esc(ev.title)}</span>${ev.location ? `<span class="ag-loc">${esc(ev.location)}</span>` : ''}
  </button>`;
}

function renderAgendaCal(): void {
  const box = el('#ag-cal');
  if (!agenda.on || !agenda.cal) return;
  const today = agKey(new Date());
  const sel = agKey(agDay);
  const dayEvents = eventsOn(agDay);
  const isToday = sel === today;
  const tomorrow = addDays(agDay, 1);
  const tomorrowEvents = isToday ? eventsOn(tomorrow) : [];
  const dayTitle = isToday ? t('agenda.today') : agDay.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
  box.innerHTML = `
    <div class="ag-month">
      <button type="button" class="icon-btn sm" data-ag-nav="-1" aria-label="${esc(t('agenda.prevMonth'))}">‹</button>
      <b>${esc(agMonth.toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' }))}</b>
      <button type="button" class="icon-btn sm" data-ag-nav="1" aria-label="${esc(t('agenda.nextMonth'))}">›</button>
    </div>
    ${miniMonthHtml(agMonth, { selected: sel, dots: (d) => eventsOn(d).length > 0, attr: 'data-ag-day' })}
    <div class="ag-list">
      <div class="ag-sub"><span>${esc(dayTitle.toUpperCase())}</span><button type="button" class="link" data-ag-new>${esc(t('agenda.newEvent'))}</button></div>
      ${dayEvents.map(agEventRow).join('') || `<p class="hint ag-empty">${esc(t(calendars.length ? 'agenda.noEvents' : 'cal.addAccountFirst'))}</p>`}
      ${tomorrowEvents.length ? `<div class="ag-sub"><span>${esc(t('agenda.tomorrow').toUpperCase())}</span></div>${tomorrowEvents.map(agEventRow).join('')}` : ''}
    </div>`;
}

el('#ag-cal').addEventListener('click', (e) => {
  const tgt = e.target as HTMLElement;
  const nav = tgt.closest<HTMLElement>('[data-ag-nav]')?.dataset.agNav;
  if (nav) {
    agMonth = new Date(agMonth.getFullYear(), agMonth.getMonth() + Number(nav), 1);
    return void loadAgendaEvents();
  }
  const day = tgt.closest<HTMLElement>('[data-ag-day]')?.dataset.agDay;
  if (day) {
    agDay = parseYmd(day);
    if (agDay.getMonth() !== agMonth.getMonth()) {
      agMonth = new Date(agDay.getFullYear(), agDay.getMonth(), 1);
      return void loadAgendaEvents();
    }
    return renderAgendaCal();
  }
  if (tgt.closest('[data-ag-new]')) {
    const start = new Date(agDay);
    start.setHours(agKey(agDay) === agKey(new Date()) ? new Date().getHours() + 1 : 9, 0, 0, 0);
    return openEventDialog(null, start);
  }
  const evId = tgt.closest<HTMLElement>('[data-ag-ev]')?.dataset.agEv;
  const ev = evId && agEvents.find((x) => x.id === evId);
  if (ev) openEventDialog(ev);
});

// Reload after saving/deleting in the event dialog
el('#dlg-event').addEventListener('close', () => {
  if (agenda.on && agenda.cal) setTimeout(() => loadAgendaEvents(true), 300);
});

// Tasks
function renderAgendaTasks(): void {
  if (!agenda.on || !agenda.tasks) return;
  const box = el('#ag-tasks');
  const today = agKey(new Date());
  const soon = agKey(addDays(new Date(), 7));
  const open = taskItems
    .filter((x) => !x.done && (!x.due || dueDay(x) <= soon))
    .sort((a, b) => (a.due ? dueDay(a) : '9999').localeCompare(b.due ? dueDay(b) : '9999') || (a.priority === 'high' ? -1 : 0) - (b.priority === 'high' ? -1 : 0))
    .slice(0, 12);
  box.innerHTML = `
    <div class="ag-sub"><span>${esc(t('agenda.tasks').toUpperCase())}</span><button type="button" class="link" data-ag-alltasks>${esc(t('agenda.allTasks'))}</button></div>
    <form class="ag-quick" id="ag-quick"><input id="ag-quick-input" autocomplete="off" placeholder="${esc(t('agenda.quickTask'))}" aria-label="${esc(t('agenda.quickTask'))}"></form>
    ${
      open
        .map((task) => {
          const d = dueLabel(task);
          return `<div class="ag-task${dueDay(task) && dueDay(task) < today ? ' overdue' : ''}" data-ag-task="${esc(task.id)}">
            <button type="button" class="tick" data-ag-tick="${esc(task.id)}" aria-label="${esc(t('tasks.markDone'))}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg></button>
            <span class="ag-tt">${task.priority === 'high' ? '<b class="prio-hi">!</b> ' : ''}${esc(task.title)}</span>
            ${d.text ? `<span class="due ${d.cls}">${esc(d.text)}</span>` : ''}
          </div>`;
        })
        .join('') || `<p class="hint ag-empty">${esc(taskLists.length ? t('tasks.allDone') : t('tasks.noLists'))}</p>`
    }`;
}

el('#ag-tasks').addEventListener('click', async (e) => {
  const tgt = e.target as HTMLElement;
  if (tgt.closest('[data-ag-alltasks]')) return setView('tasks');
  const tick = tgt.closest<HTMLElement>('[data-ag-tick]');
  if (tick) {
    const task = taskItems.find((x) => x.id === tick.dataset.agTick);
    if (!task) return;
    const row = tick.closest<HTMLElement>('.ag-task')!;
    row.classList.add('completing');
    task.done = true;
    task.completed = new Date().toISOString();
    setTimeout(() => renderTasks(), reduceMotion() ? 0 : 420); // show briefly, then disappear
    try {
      await saveTaskInput(toInput(task));
    } catch (err) {
      setStatus(errMsg(err));
      loadTasks();
    }
    return;
  }
  const id = tgt.closest<HTMLElement>('[data-ag-task]')?.dataset.agTask;
  const task = id && taskItems.find((x) => x.id === id);
  if (task) openTaskDialog(task);
});

el('#ag-tasks').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = el<HTMLInputElement>('#ag-quick-input');
  const title = input.value.trim();
  const listId = taskLists[0]?.id;
  if (!title || !listId) return;
  input.value = '';
  try {
    await saveTaskInput({ listId, title, notes: '', due: agKey(new Date()), done: false, priority: 'normal' });
    el<HTMLInputElement>('#ag-quick-input').focus();
  } catch (err) {
    input.value = title;
    setStatus(errMsg(err));
  }
});

// Toggles
el('#btn-agenda').addEventListener('click', () => {
  agenda.on = !agenda.on;
  if (agenda.on && !agenda.cal && !agenda.tasks) agenda.cal = agenda.tasks = true;
  saveAgenda();
  setView('mail');
  applyAgenda();
});

el('#ag-toggles').addEventListener('click', (e) => {
  const k = (e.target as HTMLElement).closest<HTMLElement>('[data-ag]')?.dataset.ag as 'cal' | 'tasks' | undefined;
  if (!k) return;
  agenda[k] = !agenda[k];
  if (!agenda.cal && !agenda.tasks) agenda.on = false; // both off = sidebar closed
  saveAgenda();
  applyAgenda();
});

setInterval(() => {
  if (agenda.on && el('.app').dataset.view === 'mail') {
    if (agenda.cal) loadAgendaEvents(true);
    if (agenda.tasks) loadTasks();
  }
}, 5 * 60_000);

applyAgenda();
