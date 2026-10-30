// Distribution lists, stored only in this app. Shown in the contacts view (contacts.ts).

let mailLists: MailList[] = [];
let currentList: string | null = null;

const mlistOf = (id: string | null) => mailLists.find((l) => l.id === id);
const LIST_ICO = '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>';

// "Name <address>" for the compose window, which splits on , and ;
const asRecipient = (m: ListMember) => (m.name ? `${m.name.replace(/[,;"<>]/g, ' ').trim()} <${m.address}>` : m.address);

async function loadMailLists(): Promise<void> {
  mailLists = await window.api.lists.get().catch(() => [] as MailList[]);
  renderListSide();
}

function renderListSide(): void {
  el('#mlist-side').innerHTML =
    `<div class="label label-act"><span>${esc(t('lists.title').toUpperCase())}</span><button type="button" data-mlist-new title="${esc(t('lists.new'))}" aria-label="${esc(t('lists.new'))}">+</button></div>` +
    mailLists
      .map((l) => `<button class="box${currentList === l.id ? ' active' : ''}" data-mlist="${esc(l.id)}"><span class="vico">${svgIco(LIST_ICO, 15)}</span><span class="name">${esc(l.name)}</span><span class="count">${l.members.length || ''}</span></button>`)
      .join('');
}

// Middle column while a list is selected
function renderListMembers(): void {
  const list = mlistOf(currentList);
  if (!list) {
    currentList = null;
    return renderContacts();
  }
  const q = el<HTMLInputElement>('#contact-search').value.trim().toLowerCase();
  const shown = list.members.filter((m) => !q || `${m.name} ${m.address}`.toLowerCase().includes(q));
  const bar = `<div class="list-bar">
    <span><b>${esc(list.name)}</b><small>${esc(t('lists.count', { n: list.members.length }))}</small></span>
    <button type="button" class="btn ghost sm" data-mlist-edit>${esc(t('btn.edit'))}</button>
    ${list.members.length ? `<button type="button" class="btn primary sm" data-mlist-mail>${esc(t('lists.mail'))}</button>` : ''}
  </div>`;
  const rows = shown
    .map((m) => {
      const c = contactByAddress(m.address);
      return `<div class="person mlist-member${c && c.id === selectedContact ? ' selected' : ''}" role="button" tabindex="0" data-mlist-member="${esc(m.address)}">
        <span class="avatar${c?.photo ? ' has-img' : ''}">${c?.photo ? `<img src="${esc(c.photo)}" alt="">` : esc(initials(m.name || m.address))}</span>
        <span class="who"><b>${esc(m.name || m.address)}</b><span>${esc(m.address)}</span></span>
        <button type="button" class="mlist-rm" data-mlist-rm="${esc(m.address)}" title="${esc(t('lists.removeMember'))}" aria-label="${esc(t('lists.removeMember'))}">×</button>
      </div>`;
    })
    .join('');
  el('#contact-list').innerHTML = bar + (rows || `<div class="list-empty">${esc(list.members.length ? t('mail.noHits') : t('lists.empty'))}</div>`);
}

const contactByAddress = (address: string) => contacts.find((c) => c.emails.some((e) => e.value.toLowerCase() === address.toLowerCase()));

function showList(id: string | null): void {
  currentList = id;
  if (id) currentBook = null;
  renderBooks();
  renderListSide();
  renderContacts();
}

async function storeList(list: MailList): Promise<void> {
  mailLists = await window.api.lists.save(list);
  renderListSide();
  if (currentList) renderContacts();
}

el('#mlist-side').addEventListener('click', (e) => {
  const tgt = e.target as HTMLElement;
  if (tgt.closest('[data-mlist-new]')) return openListDialog(null);
  const id = tgt.closest<HTMLElement>('[data-mlist]')?.dataset.mlist;
  if (id) showList(id);
});

el('#contact-list').addEventListener('click', (e) => {
  const tgt = e.target as HTMLElement;
  const list = mlistOf(currentList);
  if (!list) return;
  if (tgt.closest('[data-mlist-mail]')) return openCompose({ to: list.members.map(asRecipient) });
  if (tgt.closest('[data-mlist-edit]')) return openListDialog(list);
  const rm = tgt.closest<HTMLElement>('[data-mlist-rm]')?.dataset.mlistRm;
  if (rm) return void storeList({ ...list, members: list.members.filter((m) => m.address !== rm) }).catch((err) => setContactsStatus(errMsg(err)));
  const addr = tgt.closest<HTMLElement>('[data-mlist-member]')?.dataset.mlistMember;
  const c = addr && contactByAddress(addr);
  if (c) {
    selectedContact = c.id;
    renderListMembers();
    renderContactDetail();
  }
});

// Contact detail: "Add to list" menu with a tick for the lists the contact is already in
const mlistMenu = document.createElement('div');
mlistMenu.className = 'ctx-menu';
mlistMenu.hidden = true;
mlistMenu.setAttribute('role', 'menu');
document.body.appendChild(mlistMenu);
let mlistMenuFor: ListMember[] = [];

const membersOf = (list: Contact[]) => list.filter((c) => c.emails.length).map((c) => ({ name: c.name, address: c.emails[0].value }));
const hasMember = (l: MailList, address: string) => l.members.some((m) => m.address.toLowerCase() === address.toLowerCase());

// Adds people to a list (skips those already in it); returns how many were new
async function addToList(list: MailList, people: ListMember[]): Promise<number> {
  const fresh = people.filter((p) => !hasMember(list, p.address));
  if (fresh.length) await storeList({ ...list, members: [...list.members, ...fresh] });
  return fresh.length;
}

el('#contact-detail').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-mlist-for]');
  if (!btn) return;
  // data-mlist-for="" = the selected contacts
  const people = btn.dataset.mlistFor ? contacts.filter((x) => x.id === btn.dataset.mlistFor) : pickedList();
  mlistMenuFor = membersOf(people);
  if (!mlistMenuFor.length) return;
  e.stopPropagation();
  const tick = (on: boolean) => `<span style="width:14px;display:inline-flex">${on ? '✓' : ''}</span>`;
  mlistMenu.innerHTML =
    mailLists.map((l) => `<button type="button" role="menuitem" data-mlist-toggle="${esc(l.id)}">${tick(mlistMenuFor.every((p) => hasMember(l, p.address)))}<span>${esc(l.name)}</span></button>`).join('') +
    `${mailLists.length ? '<hr>' : ''}<button type="button" role="menuitem" data-mlist-newfor>${tick(false)}<span>${esc(t('lists.new'))} …</span></button>`;
  mlistMenu.hidden = false;
  const r = btn.getBoundingClientRect();
  mlistMenu.style.top = `${r.bottom + 4}px`;
  mlistMenu.style.left = `${Math.min(r.left, innerWidth - mlistMenu.offsetWidth - 6)}px`;
});

mlistMenu.addEventListener('click', async (e) => {
  const tgt = e.target as HTMLElement;
  const people = mlistMenuFor;
  mlistMenu.hidden = true;
  if (!people.length) return;
  if (tgt.closest('[data-mlist-newfor]')) return openListDialog(null, people);
  const list = mlistOf(tgt.closest<HTMLElement>('[data-mlist-toggle]')?.dataset.mlistToggle ?? null);
  if (!list) return;
  try {
    // all already in it: the click takes them out again
    if (people.every((p) => hasMember(list, p.address))) await storeList({ ...list, members: list.members.filter((m) => !people.some((p) => p.address.toLowerCase() === m.address.toLowerCase())) });
    else await addToList(list, people);
  } catch (err) {
    setContactsStatus(errMsg(err));
  }
});

document.addEventListener('mousedown', (e) => {
  if (!mlistMenu.hidden && !mlistMenu.contains(e.target as Node)) mlistMenu.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') mlistMenu.hidden = true;
});

// Drop contacts onto a list in the sidebar, or onto + for a new list
const CONTACT_DRAG = 'application/x-agenoras-contacts';
const dropTargetOf = (e: DragEvent) => (e.target as HTMLElement).closest<HTMLElement>('[data-mlist], [data-mlist-new]');

el('#mlist-side').addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes(CONTACT_DRAG)) return;
  const target = dropTargetOf(e);
  el('#mlist-side').querySelectorAll('.drop-target').forEach((x) => x !== target && x.classList.remove('drop-target'));
  if (!target) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  (target.closest('.label-act') ?? target).classList.add('drop-target');
});
el('#mlist-side').addEventListener('dragleave', (e) => {
  if (!el('#mlist-side').contains(e.relatedTarget as Node)) el('#mlist-side').querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
});
el('#mlist-side').addEventListener('drop', async (e) => {
  const raw = e.dataTransfer?.getData(CONTACT_DRAG);
  const target = dropTargetOf(e);
  el('#mlist-side').querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
  if (!raw || !target) return;
  e.preventDefault();
  e.stopPropagation();
  const ids = new Set<string>(JSON.parse(raw));
  const people = contacts.filter((c) => ids.has(c.id));
  const members = membersOf(people);
  const skipped = people.length - members.length;
  if (target.dataset.mlistNew !== undefined) return openListDialog(null, members);
  const list = mlistOf(target.dataset.mlist ?? null);
  if (!list) return;
  try {
    const n = await addToList(list, members);
    setContactsStatus([t('lists.added', { n, name: list.name }), skipped ? t('lists.skippedNoMail', { n: skipped }) : ''].filter(Boolean).join(' · '));
  } catch (err) {
    setContactsStatus(errMsg(err));
  }
});

// Dialog: name and recipients as chips; contacts are suggested while typing
const mlDlg = el<HTMLDialogElement>('#dlg-mlist');
const mlForm = el<HTMLFormElement>('#form-mlist');
const mlInput = el<HTMLInputElement>('#mlist-input');
let mlDraft: MailList = { id: '', name: '', members: [] };

function openListDialog(list: MailList | null, preset: ListMember[] = []): void {
  mlDraft = list ? { ...list, members: [...list.members] } : { id: crypto.randomUUID(), name: '', members: preset };
  mlForm.reset();
  (mlForm.elements.namedItem('name') as HTMLInputElement).value = mlDraft.name;
  el('#mlist-title').innerHTML = t(list ? 'lists.editTitle' : 'lists.newTitle');
  el('#mlist-error').textContent = '';
  el<HTMLButtonElement>('#btn-mlist-delete').hidden = !list;
  el('#mlist-suggest').innerHTML = contacts.flatMap((c) => c.emails.map((m) => `<option value="${esc(asRecipient({ name: c.name, address: m.value }))}"></option>`)).join('');
  renderListChips();
  mlDlg.showModal();
  (mlForm.elements.namedItem('name') as HTMLInputElement).focus();
}

function renderListChips(): void {
  const box = el('#mlist-recips');
  box.querySelectorAll('.chip-r').forEach((c) => c.remove());
  mlDraft.members.forEach((m, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip-r';
    chip.title = m.address;
    chip.innerHTML = `<span>${esc(m.name || m.address)}</span><button type="button" data-chip-rm="${i}" aria-label="${esc(t('common.removeItem', { name: m.address }))}">×</button>`;
    box.insertBefore(chip, mlInput);
  });
}

// "Anna <a@b.ch>, c@d.ch; …" → members; returns the parts that are no address
function takeInput(): string[] {
  const bad: string[] = [];
  for (const part of mlInput.value.split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean)) {
    const m = /^(.*?)\s*<([^<>]+)>$/.exec(part);
    const address = (m ? m[2] : part).trim();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) {
      bad.push(part);
      continue;
    }
    if (mlDraft.members.some((x) => x.address.toLowerCase() === address.toLowerCase())) continue;
    const name = (m ? m[1].replace(/^"|"$/g, '') : '') || contactByAddress(address)?.name || '';
    mlDraft.members.push({ name: name.trim(), address });
  }
  mlInput.value = bad.join(', ');
  renderListChips();
  el('#mlist-error').textContent = bad.length ? t('lists.invalid', { addr: bad.join(', ') }) : '';
  return bad;
}

mlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
    if (!mlInput.value.trim()) return; // Enter on an empty field saves
    e.preventDefault();
    takeInput();
  } else if (e.key === 'Backspace' && !mlInput.value && mlDraft.members.length) {
    mlDraft.members.pop();
    renderListChips();
  }
});
// picking a suggestion from the list adds it right away
mlInput.addEventListener('input', (e) => {
  if ((e as InputEvent).inputType === 'insertReplacementText' || !(e as InputEvent).inputType) takeInput();
});
mlInput.addEventListener('paste', () => setTimeout(() => /[,;\n]/.test(mlInput.value) && takeInput()));

el('#mlist-recips').addEventListener('click', (e) => {
  const i = (e.target as HTMLElement).closest<HTMLElement>('[data-chip-rm]')?.dataset.chipRm;
  if (i !== undefined) {
    mlDraft.members.splice(Number(i), 1);
    renderListChips();
  }
  mlInput.focus();
});

mlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (mlInput.value.trim() && takeInput().length) return;
  mlDraft.name = (mlForm.elements.namedItem('name') as HTMLInputElement).value.trim();
  try {
    await storeList(mlDraft);
    mlDlg.close();
    showList(mlDraft.id);
  } catch (err) {
    el('#mlist-error').textContent = errMsg(err);
  }
});

el('#btn-mlist-cancel').addEventListener('click', () => mlDlg.close());
el('#btn-mlist-delete').addEventListener('click', async () => {
  if (!confirm(t('lists.confirmDelete', { name: mlDraft.name }))) return;
  try {
    mailLists = await window.api.lists.remove(mlDraft.id);
    mlDlg.close();
    showList(null);
  } catch (err) {
    el('#mlist-error').textContent = errMsg(err);
  }
});

loadMailLists();
