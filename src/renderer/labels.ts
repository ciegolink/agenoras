// Mail categories: colored labels, stored locally (per mail via Message-ID).
// Assign: right-click a mail or drag a mail onto the category on the left. Click on the left = filter.

const LABEL_COLORS = ['#2BA89F', '#7FA6CF', '#E0574B', '#E0A458', '#B48EAD', '#4DB37A', '#D9C35B', '#969993'];
let editingLabel: MailLabel | null = null;
let labelAssign: string[] = []; // mails that get the new category right away
let labelColor = LABEL_COLORS[0];

// Categories are listed on the left under "All inboxes" (see renderVirtualList in renderer.ts)
function renderLabelSidebar(): void {
  renderVirtualList();
}

async function toggleLabel(keys: string[], labelId: string): Promise<void> {
  const list = keys.map(summaryOf).filter(Boolean) as MailSummary[];
  if (!list.length) return;
  const on = !list.every((m) => (mailLabels[labelKey(m)] ?? []).includes(labelId));
  try {
    mailLabels = await window.api.settings.setMailLabel(list.map(labelKey), labelId, on);
  } catch (err) {
    return setStatus(errMsg(err));
  }
  renderList();
  if (currentMsg && keys.includes(mailKey(currentMsg))) openMail(mailKey(currentMsg));
  const name = labels.find((l) => l.id === labelId)?.name ?? '';
  setStatus(t(on ? 'labels.added' : 'labels.removed', { name, n: list.length }));
}

// ---------- Dialog: new / edit ----------

const lblDlg = el<HTMLDialogElement>('#dlg-label');
const lblForm = el<HTMLFormElement>('#form-label');

function paintSwatches(): void {
  el('#label-colors').innerHTML = LABEL_COLORS.map(
    (c) => `<button type="button" role="radio" aria-checked="${c === labelColor}" class="swatch${c === labelColor ? ' on' : ''}" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`,
  ).join('');
}

function openLabelDialog(label: MailLabel | null, assign: string[] = []): void {
  editingLabel = label;
  labelAssign = assign;
  lblForm.reset();
  el('#label-error').textContent = '';
  el('#label-title').innerHTML = t(label ? 'labels.editTitle' : 'labels.newTitle');
  (lblForm.elements.namedItem('name') as HTMLInputElement).value = label?.name ?? '';
  labelColor = label?.color ?? LABEL_COLORS[labels.length % LABEL_COLORS.length];
  paintSwatches();
  el<HTMLButtonElement>('#btn-label-delete').hidden = !label;
  lblDlg.showModal();
  (lblForm.elements.namedItem('name') as HTMLInputElement).focus();
}

el('#label-colors').addEventListener('click', (e) => {
  const c = (e.target as HTMLElement).closest<HTMLElement>('[data-color]')?.dataset.color;
  if (!c) return;
  labelColor = c;
  paintSwatches();
});

lblForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = (lblForm.elements.namedItem('name') as HTMLInputElement).value.trim();
  if (!name) return;
  const dup = labels.find((l) => l.name.toLowerCase() === name.toLowerCase() && l.id !== editingLabel?.id);
  if (dup) return void (el('#label-error').textContent = t('labels.exists', { name }));
  const list = editingLabel ? labels.map((l) => (l.id === editingLabel!.id ? { ...l, name, color: labelColor } : l)) : [...labels, { id: '', name, color: labelColor }];
  try {
    const before = new Set(labels.map((l) => l.id));
    labels = await window.api.settings.saveLabels(list);
    const created = labels.find((l) => !before.has(l.id));
    lblDlg.close();
    if (created && labelAssign.length) await toggleLabel(labelAssign, created.id);
    else renderList();
    if (currentMsg) openMail(mailKey(currentMsg));
  } catch (err) {
    el('#label-error').textContent = errMsg(err);
  }
});

el('#btn-label-cancel').addEventListener('click', () => lblDlg.close());
el('#btn-label-delete').addEventListener('click', async () => {
  const l = editingLabel;
  if (!l || !confirm(t('labels.confirmDelete', { name: l.name }))) return;
  try {
    labels = await window.api.settings.saveLabels(labels.filter((x) => x.id !== l.id));
    const s = await window.api.settings.get();
    mailLabels = s.mailLabels ?? {};
    if (labelFilter === l.id) labelFilter = null;
    lblDlg.close();
    renderList();
  } catch (err) {
    el('#label-error').textContent = errMsg(err);
  }
});

// Drag mails onto "Important" or a category on the left = assign star or category.
// While dragging, all categories appear there (also empty ones).
el('#mail-list').addEventListener('dragstart', () => setTimeout(() => renderVirtualList(true), 0));
el('#mail-list').addEventListener('dragend', () => renderVirtualList());

el('#virtual-list').addEventListener('dragover', (e) => {
  const box = (e.target as HTMLElement).closest<HTMLElement>('[data-virtual]');
  document.querySelectorAll('#virtual-list .drop-target').forEach((r) => r !== box && r.classList.remove('drop-target'));
  if (!box || !dragKeys.length) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
  box.classList.add('drop-target');
});
el('#virtual-list').addEventListener('dragleave', (e) => {
  if (!el('#virtual-list').contains(e.relatedTarget as Node)) document.querySelectorAll('#virtual-list .drop-target').forEach((r) => r.classList.remove('drop-target'));
});
el('#virtual-list').addEventListener('drop', async (e) => {
  const box = (e.target as HTMLElement).closest<HTMLElement>('[data-virtual]');
  if (!box || !dragKeys.length) return;
  e.preventDefault();
  const keys = dragKeys;
  dragKeys = [];
  const kind = box.dataset.virtual!;
  if (kind === 'flagged') {
    await toggleFlag(keys, true);
  } else {
    const id = kind.slice(6);
    const list = keys.map(summaryOf).filter(Boolean) as MailSummary[];
    mailLabels = await window.api.settings.setMailLabel(list.map(labelKey), id, true);
    renderList();
    setStatus(t('labels.added', { name: labels.find((l) => l.id === id)?.name ?? '', n: list.length }));
  }
  renderVirtualList();
  const hit = document.querySelector<HTMLElement>(`#virtual-list [data-virtual="${CSS.escape(kind)}"]`);
  hit?.classList.add('drop-hit');
  setTimeout(() => hit?.classList.remove('drop-hit'), 600);
});
