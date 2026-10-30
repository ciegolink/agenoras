// Tasks (CalDAV VTODO). Uses el, esc, errMsg, t, LOCALE from common.ts.

let taskLists: TaskList[] = [];
let taskItems: Task[] = [];
let currentTaskList: string | null = null;
let tasksLoading: Promise<void> | null = null;
let editingTask: Task | null = null;
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
const dueDay = (task: Task) => (task.due ? (task.due.length === 10 ? task.due : dayKey(new Date(task.due))) : '');

async function loadTasks(): Promise<void> {
  try {
    const c = await window.api.tasks.cached();
    if (c.lists.length) {
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
  if ((e as CustomEvent<string>).detail === 'tasks') ensureTasks();
});

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

function taskRow(task: Task): string {
  const due = dueLabel(task);
  const list = tlistOf(task.listId);
  const prio = task.priority === 'high' ? `<span class="prio high" title="${esc(t('prio.high'))}">!</span>` : task.priority === 'low' ? `<span class="prio low" title="${esc(t('prio.low'))}">↓</span>` : '';
  const note = task.notes.split('\n')[0];
  return `<div class="task${task.done ? ' done' : ''}" role="button" tabindex="0" data-task="${esc(task.id)}">
    <button type="button" class="tick" data-tick="${esc(task.id)}" aria-label="${esc(t(task.done ? 'tasks.markOpen' : 'tasks.markDone'))}" title="${esc(t(task.done ? 'tasks.markOpen' : 'tasks.markDone'))}">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>
    </button>
    <span class="tt"><b>${esc(task.title)}</b>${note ? `<small>${esc(note)}</small>` : ''}</span>
    ${prio}
    ${due.text ? `<span class="due ${due.cls}">${esc(due.text)}</span>` : ''}
    ${!currentTaskList && list ? `<span class="ldot" style="background:${list.color}" title="${esc(list.name)}"></span>` : ''}
  </div>`;
}

function renderTasks(): void {
  // Sidebar: lists per account with the number of open tasks
  const open = taskItems.filter((x) => !x.done);
  el('#tasks-count').textContent = open.length ? String(open.length) : '';
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
  el('#tasks-heading').innerHTML = list ? `${esc(list.name)} <em>${esc(t(showDoneTasks ? 'tasks.allShort' : 'tasks.open'))}</em>` : t(showDoneTasks ? 'tasks.headingAll' : 'tasks.heading');

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
  if (showDoneTasks) groups.push(['done', t('tasks.groupDone'), mine.filter((x) => x.done).sort((a, b) => b.completed.localeCompare(a.completed)).slice(0, 100)]);
  const html = groups
    .filter(([, , items]) => items.length)
    .map(([key, title, items]) => `<section class="task-group"><h3 class="${key}">${esc(title.toUpperCase())} <span class="n">${items.length}</span></h3>${items.map(taskRow).join('')}</section>`)
    .join('');
  const elsewhere = q && taskLists.length ? searchElsewhereHtml(el<HTMLInputElement>('#task-search').value, !!html) : '';
  el('#task-groups').innerHTML = html + elsewhere || `<div class="tasks-empty">${esc(!taskLists.length ? t('tasks.noLists') : t('tasks.allDone'))}</div>`;
  if (typeof renderAgendaTasks === 'function') renderAgendaTasks();
}

// Check off as done, quick add
const toInput = (task: Task): TaskInput => ({ listId: task.listId, id: task.id, title: task.title, notes: task.notes, due: task.due, done: task.done, priority: task.priority });

async function saveTaskInput(input: TaskInput): Promise<void> {
  await window.api.tasks.save(input);
  const res = await window.api.tasks.list();
  taskLists = res.lists;
  taskItems = res.tasks;
  renderTasks();
}

el('#task-groups').addEventListener('click', async (e) => {
  const tgt = e.target as HTMLElement;
  const tickId = tgt.closest<HTMLElement>('[data-tick]')?.dataset.tick;
  if (tickId) {
    const task = taskItems.find((x) => x.id === tickId);
    if (!task) return;
    task.done = !task.done; // show right away
    task.completed = task.done ? new Date().toISOString() : '';
    renderTasks();
    try {
      await saveTaskInput(toInput(task));
    } catch (err) {
      setTasksStatus(errMsg(err));
      loadTasks();
    }
    return;
  }
  const id = tgt.closest<HTMLElement>('[data-task]')?.dataset.task;
  const task = id && taskItems.find((x) => x.id === id);
  if (task) openTaskDialog(task);
});
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
    await saveTaskInput({ listId, title, notes: '', due: '', done: false, priority: 'normal' });
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

function openTaskDialog(task: Task | null): void {
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
  tkField('title').value = task?.title ?? '';
  (tkForm.elements.namedItem('notes') as HTMLTextAreaElement).value = task?.notes ?? '';
  tkField('dueDate').value = task?.due ? dueDay(task) : '';
  tkField('dueTime').value = task?.due && task.due.length > 10 ? new Date(task.due).toTimeString().slice(0, 5) : '';
  (tkForm.elements.namedItem('priority') as HTMLSelectElement).value = task?.priority ?? 'normal';
  tkField('done').checked = !!task?.done;
  el<HTMLButtonElement>('#btn-task-delete').hidden = !task;
  tkDlg.showModal();
  tkField('title').focus();
}

tkForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const date = tkField('dueDate').value;
  const time = tkField('dueTime').value;
  const input: TaskInput = {
    listId: editingTask?.listId ?? (tkForm.elements.namedItem('list') as HTMLSelectElement).value,
    id: editingTask?.id,
    title: tkField('title').value,
    notes: (tkForm.elements.namedItem('notes') as HTMLTextAreaElement).value,
    due: date ? (time ? new Date(`${date}T${time}`).toISOString() : date) : '',
    done: tkField('done').checked,
    priority: (tkForm.elements.namedItem('priority') as HTMLSelectElement).value as Priority,
  };
  const btn = el<HTMLButtonElement>('#btn-task-save');
  btn.disabled = true;
  try {
    await saveTaskInput(input);
    tkDlg.close();
  } catch (err) {
    el('#task-error').textContent = errMsg(err);
  } finally {
    btn.disabled = false;
  }
});

el('#btn-task-cancel').addEventListener('click', () => tkDlg.close());
el('#btn-task-delete').addEventListener('click', async () => {
  const task = editingTask;
  if (!task || !confirm(t('tasks.confirmDelete', { title: task.title }))) return;
  try {
    await window.api.tasks.delete(task.id);
    tkDlg.close();
    await loadTasks();
  } catch (err) {
    el('#task-error').textContent = errMsg(err);
  }
});
el('#btn-new-task').addEventListener('click', () => openTaskDialog(null));
