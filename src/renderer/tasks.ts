// Tasks (CalDAV VTODO). Uses el, esc, errMsg, t, LOCALE from common.ts.

let taskLists: TaskList[] = [];
let taskItems: Task[] = [];
let currentTaskList: string | null = null;
let tasksLoading: Promise<void> | null = null;
let editingTask: Task | null = null;
let selectedTask = ''; // shown on the right
let showDoneTasks = (() => {
  try {
    return localStorage.getItem('tasks.showDone') === '1';
  } catch {
    return false;
  }
})();

const setTasksStatus = (s: string) => (el('#tasks-status').textContent = s);
const tlistOf = (id: string) => taskLists.find((l) => l.id === id);
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayOf = (v: string) => (v.length === 10 ? v : dayKey(new Date(v)));
const dueDay = (task: Task) => (task.due ? dayOf(task.due) : '');

// Start / due in the list like a mail's date: the time if it is today, otherwise day.month
function shortDay(v: string): string {
  if (!v) return '';
  if (v.length === 10) return new Date(`${v}T12:00`).toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' });
  return fmtShort(v);
}

// In the detail like a mail's date: weekday, date, time (without time for all-day dates)
function longDay(v: string): string {
  if (v.length > 10) return fmtLong(v);
  return new Date(`${v}T12:00`).toLocaleDateString(LOCALE, { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
}

// counts saves: a reload that started before a save would bring back the old state
let taskSaves = 0;

async function loadTasks(): Promise<void> {
  const saves = taskSaves;
  try {
    const c = await window.api.tasks.cached();
    if (c.lists.length && !taskItems.length) {
      taskLists = c.lists;
      taskItems = c.tasks;
      renderTasks();
    }
  } catch {
    /* cache empty */
  }
  setTasksStatus(t('status.updating'));
  try {
    const res = await window.api.tasks.list();
    if (saves !== taskSaves) return void setTasksStatus(''); // outdated, the save already updated the list
    taskLists = res.lists;
    taskItems = res.tasks;
    const accs = await window.api.cal.listAccounts().catch(() => [] as CalAccount[]);
    const errs = res.errors.map((e) => `${accs.find((a) => a.id === e.accountId)?.name ?? t('account.generic')}: ${e.message}`);
    setTasksStatus(errs.join(' · ') || (accs.length ? (taskLists.length ? '' : t('tasks.noLists')) : t('cal.noAccount')));
  } catch (e) {
    setTasksStatus(errMsg(e));
  }
  renderTasks();
}

function ensureTasks(): Promise<void> {
  tasksLoading ??= loadTasks();
  return tasksLoading;
}

document.addEventListener('viewchange', (e) => {
  if ((e as CustomEvent<string>).detail === 'tasks') {
    navBadge('tasks', taskItems.filter((x) => !x.done).map((x) => x.id));
    ensureTasks();
  }
});

// Startup from the cache, then the server; refresh every 5 min so new tasks show up at the bottom of the sidebar
// and pinned tasks follow changes made on the server
setTimeout(() => void ensureTasks().catch(() => {}), 4000);
setInterval(() => {
  if (taskLists.length) tasksLoading = loadTasks();
}, 5 * 60_000);

function dueLabel(task: Task): { text: string; cls: string } {
  if (!task.due) return { text: '', cls: '' };
  const today = dayKey(new Date());
  const tomorrow = dayKey(new Date(Date.now() + 86400000));
  const day = dueDay(task);
  const time = task.due.length > 10 ? ` ${new Date(task.due).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}` : '';
  const text =
    day === today ? t('tasks.today') : day === tomorrow ? t('tasks.tomorrow') : new Date(`${day}T12:00`).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
  return { text: text + time, cls: task.done ? '' : day < today ? 'overdue' : day === today ? 'today' : '' };
}


// Progress ring on the right of each task (PERCENT-COMPLETE)
function pctRing(pct: number): string {
  const c = 2 * Math.PI * 14;
  return `<span class="pct-ring${pct ? '' : ' zero'}" title="${esc(t('tasks.progressN', { n: pct }))}"><svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><circle class="bg" cx="17" cy="17" r="14" fill="none" stroke-width="3"/><circle class="fg" cx="17" cy="17" r="14" fill="none" stroke-width="3" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct / 100)).toFixed(1)}"${pct ? '' : ' opacity="0"'}/></svg><b>${pct}%</b></span>`;
}

// One row, like a mail or feed row: tick, title with due date, list, first line of the note, progress
function taskRow(task: Task): string {
  const due = dueLabel(task);
  const list = tlistOf(task.listId);
  const prio = task.priority === 'high' ? `<span class="prio high" title="${esc(t('prio.high'))}">!</span>` : task.priority === 'low' ? `<span class="prio low" title="${esc(t('prio.low'))}">↓</span>` : '';
  const note = task.notes.trim().split('\n')[0];
  // start – due like the date of a mail; only one of them: just that one
  const start = shortDay(task.start ?? '');
  const datesHtml =
    start || task.due
      ? `<span class="time">${start ? esc(start) : ''}${start && task.due ? ' – ' : ''}${task.due ? `<span class="due ${due.cls}">${esc(shortDay(task.due))}</span>` : ''}</span>`
      : '';
  return `<div class="mail task-item${task.done ? ' done' : ''}${task.id === selectedTask ? ' selected' : ''}" role="button" tabindex="0" data-task="${esc(task.id)}">
    <button type="button" class="tick" data-tick="${esc(task.id)}" aria-label="${esc(t(task.done ? 'tasks.markOpen' : 'tasks.markDone'))}" title="${esc(t(task.done ? 'tasks.markOpen' : 'tasks.markDone'))}">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>
    </button>
    <span class="m-body">
      <span class="row"><span class="from">${esc(task.title)}</span>${prio}${datesHtml}</span>
      ${!currentTaskList && list ? `<span class="acc" style="color:${readable(list.color)}">${esc(list.name.toUpperCase())}</span>` : ''}
      ${note ? `<span class="snip">${esc(note)}</span>` : ''}
    </span>
    ${pctRing(task.percent ?? 0)}
  </div>`;
}

function taskPin(task: Task): PinItem {
  const list = tlistOf(task.listId);
  const due = dueLabel(task);
  const meta = [task.start ? { text: `${t('tasks.start')} ${shortDay(task.start)}` } : null, due.text ? { text: due.text, cls: due.cls } : null, task.priority !== 'normal' ? { text: t(`prio.${task.priority}`) } : null, list ? { text: `${list.name} · ${list.accountName}` } : null];
  const pct = task.percent ? { text: t('tasks.progressN', { n: task.percent }) } : null;
  return { key: `task:${task.id}`, kind: 'task', title: task.title, text: task.notes, meta: [...meta, pct].filter((m) => !!m), color: list?.color ?? '#969993', done: task.done };
}

const pinTask = (task: Task) => void window.api.pins.add(taskPin(task));

// after a reload: pinned tasks show the current state
async function syncPins(): Promise<void> {
  const keys = new Set((await window.api.pins.list().catch(() => [] as PinItem[])).map((p) => p.key));
  const tasks = taskItems.filter((x) => keys.has(`task:${x.id}`));
  if (tasks.length) await window.api.pins.update(tasks.map(taskPin)).catch(() => {});
}

function renderTasks(): void {
  // Sidebar: lists per account with the number of open tasks
  const open = taskItems.filter((x) => !x.done);
  el('#tasks-count').textContent = open.length ? String(open.length) : '';
  navBadge('tasks', open.map((x) => x.id));
  const accIds = [...new Set(taskLists.map((l) => l.accountId))];
  el('#tlist-list').innerHTML = accIds
    .map((id) => {
      const lists = taskLists.filter((l) => l.accountId === id);
      return `<div class="cal-group"><span>${esc(lists[0].accountName.toUpperCase())}</span></div>${lists
        .map((l) => {
          const n = open.filter((x) => x.listId === l.id).length;
          return `<button class="box${currentTaskList === l.id ? ' active' : ''}" data-tlist="${esc(l.id)}"><span class="dot" style="background:${l.color}"></span><span class="name">${esc(l.name)}</span><span class="count">${n || ''}</span></button>`;
        })
        .join('')}`;
    })
    .join('');
  document.querySelector<HTMLElement>('#side-tasks .box[data-tlist=""]')?.classList.toggle('active', !currentTaskList);
  document.querySelectorAll<HTMLElement>('#task-filter [data-tfilter]').forEach((b) => b.classList.toggle('on', (b.dataset.tfilter === 'all') === showDoneTasks));

  const list = currentTaskList ? tlistOf(currentTaskList) : null;
  el('#tasks-heading').textContent = list ? list.name : t('view.tasks');
  el('#tasks-title').textContent = t(showDoneTasks ? 'tasks.allShort' : 'tasks.open');

  const q = el<HTMLInputElement>('#task-search').value.trim().toLowerCase();
  const mine = taskItems.filter((x) => (!currentTaskList || x.listId === currentTaskList) && (!q || `${x.title} ${x.notes}`.toLowerCase().includes(q)));
  const today = dayKey(new Date());
  const byDue = (a: Task, b: Task) => (a.due || '9999').localeCompare(b.due || '9999') || (a.priority === 'high' ? -1 : 0) - (b.priority === 'high' ? -1 : 0);
  const pending = mine.filter((x) => !x.done);
  const groups: [string, string, Task[]][] = [
    ['overdue', t('tasks.groupOverdue'), pending.filter((x) => x.due && dueDay(x) < today).sort(byDue)],
    ['today', t('tasks.groupToday'), pending.filter((x) => dueDay(x) === today).sort(byDue)],
    ['later', t('tasks.groupLater'), pending.filter((x) => x.due && dueDay(x) > today).sort(byDue)],
    ['nodate', t('tasks.groupNoDate'), pending.filter((x) => !x.due).sort((a, b) => (b.priority === 'high' ? 1 : 0) - (a.priority === 'high' ? 1 : 0) || a.created.localeCompare(b.created))],
  ];
  if (showDoneTasks) groups.push(['done', t('tasks.groupDone'), mine.filter((x) => x.done).sort((a, b) => b.completed.localeCompare(a.completed))]);
  const html = groups
    .filter(([, , items]) => items.length)
    .map(([key, title, items]) => `<section class="task-group"><h3 class="${key}">${esc(title.toUpperCase())} <span class="n">${items.length}</span></h3>${items.map(taskRow).join('')}</section>`)
    .join('');
  const elsewhere = q && taskLists.length ? searchElsewhereHtml(el<HTMLInputElement>('#task-search').value, !!html) : '';
  el('#task-groups').innerHTML = html + elsewhere || `<div class="tasks-empty">${esc(!taskLists.length ? t('tasks.noLists') : t('tasks.allDone'))}</div>`;
  if (typeof renderAgendaTasks === 'function') renderAgendaTasks();
  renderTaskDetail();
  void syncPins();
}

// Check off as done, quick add
const toInput = (task: Task): TaskInput => ({ listId: task.listId, id: task.id, title: task.title, notes: task.notes, start: task.start, due: task.due, done: task.done, priority: task.priority, percent: task.percent });

// Done / open again; done = 100 %, open again keeps the earlier progress below 100
async function setTaskDone(task: Task, done: boolean): Promise<void> {
  task.done = done; // show right away
  task.completed = done ? new Date().toISOString() : '';
  if (done) task.percent = 100;
  else if (task.percent >= 100) task.percent = 0;
  renderTasks();
  try {
    await saveTaskInput(toInput(task));
  } catch (err) {
    setTasksStatus(errMsg(err));
    loadTasks();
  }
}

async function setTaskPercent(task: Task, pct: number): Promise<void> {
  if (pct >= 100) return setTaskDone(task, true);
  task.percent = pct;
  if (task.done) {
    task.done = false;
    task.completed = '';
  }
  renderTasks();
  try {
    await saveTaskInput(toInput(task));
  } catch (err) {
    setTasksStatus(errMsg(err));
    loadTasks();
  }
}

// onSaved: runs once the server has the task, before the list is reloaded (closes the dialog)
async function saveTaskInput(input: TaskInput, onSaved?: () => void): Promise<void> {
  taskSaves++;
  const saved = await window.api.tasks.save(input);
  onSaved?.();
  if (saved?.tasks) {
    // only this task changed: no reload of all lists
    taskItems = [...taskItems.filter((x) => x.id !== saved.id && !saved.tasks!.some((n) => n.id === x.id)), ...saved.tasks];
    if (!input.id) markNavSeen('tasks', saved.tasks.map((x) => x.id));
    renderTasks();
    return;
  }
  const before = new Set(taskItems.map((x) => x.id));
  const res = await window.api.tasks.list();
  taskLists = res.lists;
  taskItems = res.tasks;
  markNavSeen('tasks', taskItems.filter((x) => !before.has(x.id)).map((x) => x.id));
  renderTasks();
}

el('#task-groups').addEventListener('click', (e) => {
  const tgt = e.target as HTMLElement;
  const tickId = tgt.closest<HTMLElement>('[data-tick]')?.dataset.tick;
  if (tickId) {
    const task = taskItems.find((x) => x.id === tickId);
    if (task) void setTaskDone(task, !task.done);
    return;
  }
  const id = tgt.closest<HTMLElement>('[data-task]')?.dataset.task;
  if (id) showTask(id);
});
el('#task-groups').addEventListener('dblclick', (e) => {
  if ((e.target as HTMLElement).closest('[data-tick]')) return;
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-task]')?.dataset.task;
  const task = id && taskItems.find((x) => x.id === id);
  if (task) openTaskDialog(task);
});

// Task on the right: read it, done, progress, edit, pin, delete
function showTask(id: string): void {
  selectedTask = id;
  document.querySelectorAll('#task-groups .task-item.selected').forEach((r) => r.classList.remove('selected'));
  document.querySelector(`#task-groups [data-task="${CSS.escape(id)}"]`)?.classList.add('selected');
  renderTaskDetail();
}

function renderTaskDetail(): void {
  const box = el('#task-detail');
  const task = taskItems.find((x) => x.id === selectedTask);
  if (!task) {
    selectedTask = '';
    box.innerHTML = `<div class="empty">${esc(t('tasks.noneSelected'))}</div>`;
    return;
  }
  const list = tlistOf(task.listId);
  const due = dueLabel(task);
  const pct = task.percent ?? 0;
  // like a mail: actions on top (progress small), then list, title, dates, note
  box.innerHTML = `<div class="reader-actions">
      <button type="button" class="btn ${task.done ? 'ghost' : 'primary'} with-ico" data-td="done">${svgIco('<path d="m5 12 5 5L20 7"/>')}${esc(t(task.done ? 'tasks.markOpen' : 'tasks.markDone'))}</button>
      <button type="button" class="btn ghost" data-td="edit">${esc(t('btn.edit'))}</button>
      ${replyAddress(task) ? `<button type="button" class="btn ghost with-ico" data-td="reply" title="${esc(t('tasks.replyTip', { email: replyAddress(task) }))}">${ACT_ICONS.reply}${esc(t('mail.reply'))}</button>` : ''}
      <span class="spacer"></span>
      <label class="td-pct" title="${esc(t('tasks.progress'))}">
        <input type="range" min="0" max="100" step="10" value="${pct}" data-td-pct aria-label="${esc(t('tasks.progress'))}">
        <span id="td-pct">${pct} %</span>
      </label>
      <button type="button" class="icon-btn sm" data-td="pin" aria-label="${esc(t('pins.pin'))}" title="${esc(t('pins.pinTip'))}">${PIN_ICON}</button>
      <button type="button" class="icon-btn sm danger" data-td="delete" aria-label="${esc(t('btn.delete'))}" title="${esc(t('btn.delete'))}">${ACT_ICONS.trash}</button>
    </div>
    <div class="meta">
      ${list ? `<div class="acc" style="color:${readable(list.color)}">${esc(`${list.name} · ${list.accountName}`.toUpperCase())}</div>` : ''}
      <h2 class="${task.done ? 'done' : ''}">${esc(task.title)}${task.priority !== 'normal' ? ` <span class="td-prio ${task.priority}">${esc(t(`prio.${task.priority}`))}</span>` : ''}</h2>
      <div class="td-dates">
        ${task.start ? `<span><span class="k">${esc(t('tasks.start').toUpperCase())}</span>${esc(longDay(task.start))}</span>` : ''}
        ${task.due ? `<span><span class="k">${esc(t('tasks.due').toUpperCase())}</span><span class="due ${due.cls}">${esc(longDay(task.due))}</span></span>` : ''}
        ${task.done && task.completed ? `<span><span class="k">${esc(t('tasks.doneField').toUpperCase())}</span>${esc(fmtLong(task.completed))}</span>` : ''}
        ${!task.start && !task.due && !task.done ? `<span class="none">${esc(t('tasks.noDates'))}</span>` : ''}
      </div>
    </div>
    ${task.notes.trim() ? `<div class="td-notes">${linkText(esc(task.notes.trim()))}</div>` : `<p class="hint">${esc(t('tasks.noNotes'))}</p>`}`;
}

// An e-mail address in the note (e.g. a task made from a mail: "… wrote Name <address>:") → answer by mail
function replyAddress(task: Task): string {
  return task.notes.match(new RegExp(MAIL_IN_TEXT.source))?.[0] ?? '';
}

// Reply: to that address, subject "Re: <title>", the note quoted below the signature, from the chosen sender
function replyFromTask(task: Task, from?: Identity): void {
  const to = replyAddress(task);
  if (!to) return;
  const quote = `<blockquote style="margin: 0 0 0 4px; padding-left: 10px; border-left: 2px solid #C1C8BE; color: #555">${textToHtml(task.notes.trim())}</blockquote>`;
  openCompose({ to: [to], subject: withPrefix('Re', task.title), quoteHtml: quote, ...(from ? { accountId: from.accountId, matchAddresses: [from.email] } : {}) });
}

// Choose the sender first: every account with its aliases (one sender only: straight to the mail)
const senderMenu = document.createElement('div');
senderMenu.className = 'ctx-menu';
senderMenu.setAttribute('role', 'menu');
senderMenu.hidden = true;
document.body.appendChild(senderMenu);
let senderTask: Task | null = null;
let senderList: Identity[] = [];

async function pickReplySender(task: Task, btn: HTMLElement): Promise<void> {
  const ids = (await window.api.settings.get().catch(() => null))?.identities ?? [];
  if (ids.length <= 1) return replyFromTask(task, ids[0]);
  senderTask = task;
  senderList = ids;
  const accIds = [...new Set(ids.map((i) => i.accountId))];
  senderMenu.innerHTML =
    `<div class="ctx-head">${esc(t('compose.from').toUpperCase())}</div>` +
    accIds
      .map((accId) => {
        const acc = accountOf(accId);
        const mine = ids.filter((i) => i.accountId === accId).sort((a, b) => Number(b.primary) - Number(a.primary));
        return `${accIds.length > 1 ? `<div class="ctx-sub" style="color:${colorOf(accId)}">${esc(acc ? accLabel(acc) : accId)}</div>` : ''}${mine
          .map((i) => `<button type="button" role="menuitem" data-sender="${esc(i.id)}"><span class="sender-name">${esc(i.name || i.email)}</span><span class="sender-mail">${esc(i.email)}</span></button>`)
          .join('')}`;
      })
      .join('');
  senderMenu.hidden = false;
  const r = btn.getBoundingClientRect();
  const m = senderMenu.getBoundingClientRect();
  senderMenu.style.left = `${Math.min(r.left, innerWidth - m.width - 6)}px`;
  senderMenu.style.top = `${Math.min(r.bottom + 4, innerHeight - m.height - 6)}px`;
  senderMenu.querySelector<HTMLElement>('button')?.focus();
}

senderMenu.addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-sender]')?.dataset.sender;
  const from = senderList.find((i) => i.id === id);
  if (!from || !senderTask) return;
  senderMenu.hidden = true;
  replyFromTask(senderTask, from);
});
// Close on any click elsewhere (capture: before other handlers), scrolling, leaving the window or the view.
// Clicks into a mail/article frame or the title bar don't reach the page, they blur the window instead.
const hideSenderMenu = () => (senderMenu.hidden = true);
document.addEventListener(
  'pointerdown',
  (e) => {
    if (!senderMenu.hidden && !senderMenu.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-td="reply"]')) hideSenderMenu();
  },
  true,
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideSenderMenu();
});
document.addEventListener('scroll', (e) => !senderMenu.contains(e.target as Node) && hideSenderMenu(), true);
document.addEventListener('viewchange', hideSenderMenu);
window.addEventListener('blur', hideSenderMenu);
window.addEventListener('resize', hideSenderMenu);

async function deleteTaskAsk(task: Task): Promise<boolean> {
  if (!confirm(t('tasks.confirmDelete', { title: task.title }))) return false;
  try {
    taskSaves++;
    await window.api.tasks.delete(task.id);
    if (selectedTask === task.id) selectedTask = '';
    taskItems = taskItems.filter((x) => x.id !== task.id); // no reload of all lists
    renderTasks();
    return true;
  } catch (err) {
    setTasksStatus(errMsg(err));
    return false;
  }
}

el('#task-detail').addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-td]')?.dataset.td;
  const task = taskItems.find((x) => x.id === selectedTask);
  if (!act || !task) return;
  if (act === 'done') void setTaskDone(task, !task.done);
  else if (act === 'edit') openTaskDialog(task);
  else if (act === 'reply') {
    if (!senderMenu.hidden) hideSenderMenu(); // second click on Reply closes the list again
    else void pickReplySender(task, (e.target as HTMLElement).closest<HTMLElement>('[data-td]')!);
  }
  else if (act === 'pin') pinTask(task);
  else if (act === 'delete') void deleteTaskAsk(task);
});
el('#task-detail').addEventListener('input', (e) => {
  const r = (e.target as HTMLElement).closest<HTMLInputElement>('[data-td-pct]');
  if (r) el('#td-pct').textContent = `${r.value} %`;
});
el('#task-detail').addEventListener('change', (e) => {
  const r = (e.target as HTMLElement).closest<HTMLInputElement>('[data-td-pct]');
  const task = taskItems.find((x) => x.id === selectedTask);
  if (r && task) void setTaskPercent(task, Number(r.value));
});

// Right-click: done, progress, edit, pin, delete
const taskMenu = document.createElement('div');
taskMenu.className = 'ctx-menu';
taskMenu.setAttribute('role', 'menu');
taskMenu.hidden = true;
document.body.appendChild(taskMenu);
let taskMenuId = '';
const hideTaskMenu = () => (taskMenu.hidden = true);

el('#task-groups').addEventListener('contextmenu', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-task]')?.dataset.task;
  const task = id && taskItems.find((x) => x.id === id);
  if (!task) return;
  e.preventDefault();
  taskMenuId = task.id;
  const item = (action: string, ico: string, label: string, cls = '') => `<button type="button" role="menuitem" class="${cls}" data-tctx="${action}">${ico}<span>${esc(label)}</span></button>`;
  const tick = svgIco('<path d="m5 12 5 5L20 7"/>');
  taskMenu.innerHTML = [
    item(task.done ? 'open' : 'done', tick, t(task.done ? 'tasks.markOpen' : 'tasks.markDone')),
    `<div class="ctx-head">${esc(t('tasks.progress').toUpperCase())}</div>`,
    `<div class="ctx-pcts">${[0, 25, 50, 75, 100].map((n) => `<button type="button" role="menuitemradio" aria-checked="${(task.percent ?? 0) === n}" class="${(task.percent ?? 0) === n ? 'on' : ''}" data-tctx="pct:${n}">${n}%</button>`).join('')}</div>`,
    '<hr>',
    item('pin', PIN_ICON, t('pins.pin')),
    item('edit', svgIco('<path d="M4 20h4L19 9l-4-4L4 16z"/>'), t('btn.edit')),
    '<hr>',
    item('delete', ACT_ICONS.trash, t('btn.delete'), 'danger'),
  ].join('');
  taskMenu.hidden = false;
  const r = taskMenu.getBoundingClientRect();
  taskMenu.style.left = `${Math.min(e.clientX, innerWidth - r.width - 6)}px`;
  taskMenu.style.top = `${Math.min(e.clientY, innerHeight - r.height - 6)}px`;
  taskMenu.querySelector<HTMLElement>('button')?.focus();
});

taskMenu.addEventListener('click', (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>('[data-tctx]')?.dataset.tctx;
  const task = taskItems.find((x) => x.id === taskMenuId);
  if (!action || !task) return;
  hideTaskMenu();
  if (action === 'done' || action === 'open') void setTaskDone(task, action === 'done');
  else if (action.startsWith('pct:')) void setTaskPercent(task, Number(action.slice(4)));
  else if (action === 'pin') pinTask(task);
  else if (action === 'edit') openTaskDialog(task);
  else if (action === 'delete') void deleteTaskAsk(task);
});
document.addEventListener('mousedown', (e) => {
  if (!taskMenu.hidden && !taskMenu.contains(e.target as Node)) hideTaskMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !taskMenu.hidden) hideTaskMenu();
});
window.addEventListener('blur', hideTaskMenu);
window.addEventListener('resize', hideTaskMenu);
el('#task-groups').addEventListener('scroll', hideTaskMenu);

el('#task-groups').addEventListener('keydown', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-task]');
  if (row && (e.key === 'Enter' || e.key === ' ') && e.target === row) {
    e.preventDefault();
    row.click();
  }
});

el('#task-quick').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = el<HTMLInputElement>('#task-quick-input');
  const title = input.value.trim();
  if (!title) return;
  const listId = currentTaskList ?? taskLists[0]?.id;
  if (!listId) return void setTasksStatus(t('tasks.noLists'));
  input.value = '';
  setTasksStatus(t('status.saving'));
  try {
    await saveTaskInput({ listId, title, notes: '', due: '', done: false, priority: 'normal', percent: 0 });
    setTasksStatus('');
  } catch (err) {
    input.value = title;
    setTasksStatus(errMsg(err));
  }
});

el('#side-tasks').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tlist]');
  if (!b) return;
  currentTaskList = b.dataset.tlist || null;
  renderTasks();
});

// Open / all and quick filter
el('#task-filter').addEventListener('click', (e) => {
  const f = (e.target as HTMLElement).closest<HTMLElement>('[data-tfilter]')?.dataset.tfilter;
  if (!f || (f === 'all') === showDoneTasks) return;
  showDoneTasks = f === 'all';
  try {
    localStorage.setItem('tasks.showDone', showDoneTasks ? '1' : '0');
  } catch {
    /* ignore */
  }
  renderTasks();
});
el('#task-search').addEventListener('input', renderTasks);
el('#task-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  el<HTMLInputElement>('#task-search').value = '';
  renderTasks();
});

// Dialog
const tkDlg = el<HTMLDialogElement>('#dlg-task');
const tkForm = el<HTMLFormElement>('#form-task');
const tkField = (n: string) => tkForm.elements.namedItem(n) as HTMLInputElement;

// prefill: new task from a mail or feed article
function openTaskDialog(task: Task | null, prefill?: { title: string; notes: string; start?: string }): void {
  if (!task && !taskLists.length) return void setTasksStatus(t('tasks.noLists'));
  editingTask = task;
  tkForm.reset();
  el('#task-error').textContent = '';
  el('#task-title').innerHTML = t(task ? 'tasks.editTitle' : 'tasks.newTitle');
  const sel = tkForm.elements.namedItem('list') as HTMLSelectElement;
  const opts = task ? taskLists.filter((l) => l.id === task.listId) : taskLists;
  sel.innerHTML = opts.map((l) => `<option value="${esc(l.id)}">${esc(l.name)} · ${esc(l.accountName)}</option>`).join('');
  sel.disabled = !!task;
  if (!task && currentTaskList) sel.value = currentTaskList;
  tkField('title').value = task?.title ?? prefill?.title ?? '';
  (tkForm.elements.namedItem('notes') as HTMLTextAreaElement).value = task?.notes ?? prefill?.notes ?? '';
  tkField('startDate').value = task?.start ? dayOf(task.start) : (prefill?.start ?? '');
  tkField('startTime').value = task?.start && task.start.length > 10 ? new Date(task.start).toTimeString().slice(0, 5) : '';
  tkField('dueDate').value = task?.due ? dueDay(task) : '';
  tkField('dueTime').value = task?.due && task.due.length > 10 ? new Date(task.due).toTimeString().slice(0, 5) : '';
  (tkForm.elements.namedItem('priority') as HTMLSelectElement).value = task?.priority ?? 'normal';
  tkField('done').checked = !!task?.done;
  (tkForm.elements.namedItem('percent') as HTMLSelectElement).value = String(Math.round((task?.percent ?? 0) / 10) * 10);
  el<HTMLButtonElement>('#btn-task-delete').hidden = !task;
  el<HTMLButtonElement>('#btn-task-pin').hidden = !task;
  tkDlg.showModal();
  tkField('title').focus();
}

tkForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const date = tkField('dueDate').value;
  const time = tkField('dueTime').value;
  const sDate = tkField('startDate').value;
  const sTime = tkField('startTime').value;
  if (sDate && date && sDate > date) return void (el('#task-error').textContent = t('err.startAfterDue'));
  const input: TaskInput = {
    listId: editingTask?.listId ?? (tkForm.elements.namedItem('list') as HTMLSelectElement).value,
    id: editingTask?.id,
    title: tkField('title').value,
    notes: (tkForm.elements.namedItem('notes') as HTMLTextAreaElement).value,
    start: sDate ? (sTime ? new Date(`${sDate}T${sTime}`).toISOString() : sDate) : '',
    due: date ? (time ? new Date(`${date}T${time}`).toISOString() : date) : '',
    done: tkField('done').checked,
    priority: (tkForm.elements.namedItem('priority') as HTMLSelectElement).value as Priority,
    percent: Number((tkForm.elements.namedItem('percent') as HTMLSelectElement).value),
  };
  // 100 % means done, and done means 100 %
  if (input.percent === 100) input.done = true;
  if (input.done) input.percent = 100;
  else if (input.percent === 100) input.percent = 0;
  const btn = el<HTMLButtonElement>('#btn-task-save');
  savingBtn(btn, true);
  try {
    await saveTaskInput(input, () => tkDlg.close());
  } catch (err) {
    if (tkDlg.open) el('#task-error').textContent = errMsg(err);
    else setTasksStatus(errMsg(err)); // saved, only the reload failed
  } finally {
    savingBtn(btn, false);
  }
});

el('#btn-task-cancel').addEventListener('click', () => tkDlg.close());
el('#btn-task-pin').addEventListener('click', () => {
  if (editingTask) pinTask(editingTask);
});
el('#btn-task-delete').addEventListener('click', async () => {
  if (editingTask && (await deleteTaskAsk(editingTask))) tkDlg.close();
});
el('#btn-new-task').addEventListener('click', () => openTaskDialog(null));
