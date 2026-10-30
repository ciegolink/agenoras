// Contacts (CardDAV). Uses el, esc, errMsg, initials, openCompose, openMail, setView and mails from renderer.ts.

let cardAccounts: CalAccount[] = [];
let books: AddressBookInfo[] = [];
let contacts: Contact[] = [];
let currentBook: string | null = null;
let selectedContact = '';
let contactsLoaded = false;
let editingContact: Contact | null = null;

const typeLabel = (type: string) => t(`contacts.type.${['work', 'home', 'cell', 'fax'].includes(type) ? type : 'other'}`).toUpperCase();

function setContactsStatus(text: string): void {
  el('#contacts-status').textContent = text;
}

// Load
async function loadContacts(): Promise<void> {
  try {
    cardAccounts = await window.api.contacts.listAccounts();
    const cached = await window.api.contacts.cached();
    if (cached.contacts.length || cached.books.length) {
      books = cached.books;
      contacts = cached.contacts;
      renderBooks();
      renderContacts();
    }
  } catch {
    /* cache empty */
  }
  setContactsStatus(t('status.updating'));
  try {
    const res = await window.api.contacts.list();
    books = res.books;
    contacts = res.contacts;
    const errs = res.errors.map((e) => `${cardAccounts.find((a) => a.id === e.accountId)?.name ?? t('account.generic')}: ${e.message}`);
    setContactsStatus(errs.join(' · ') || (cardAccounts.length ? '' : t('contacts.noAccount')));
  } catch (e) {
    setContactsStatus(errMsg(e));
  }
  renderBooks();
  renderContacts();
}

// Load once (also for "New contact" from the title bar)
let contactsLoading: Promise<void> | null = null;
function ensureContacts(): Promise<void> {
  if (!contactsLoading) {
    contactsLoaded = true;
    contactsLoading = loadContacts();
  }
  return contactsLoading;
}

document.addEventListener('viewchange', (e) => {
  if ((e as CustomEvent<string>).detail === 'contacts') ensureContacts();
});

// Sidebar
function renderBooks(): void {
  el('#book-list').innerHTML = cardAccounts
    .map((acc) => {
      const items = books
        .filter((b) => b.accountId === acc.id)
        .map((b) => {
          const n = contacts.filter((c) => c.bookId === b.id).length;
          return `<button class="box${currentBook === b.id ? ' active' : ''}" data-book="${esc(b.id)}"><span class="name">${esc(b.name)}</span><span class="count">${n || ''}</span></button>`;
        })
        .join('');
      return `<div class="cal-group"><span>${esc(acc.name.toUpperCase())}</span></div>${items}`;
    })
    .join('');
  document.querySelector<HTMLElement>('#side-contacts [data-book=""]')?.classList.toggle('active', currentBook === null);
  el('#contacts-count').textContent = contacts.length ? String(contacts.length) : '';
}

el('#side-contacts').addEventListener('click', async (e) => {
  const tgt = e.target as HTMLElement;
  const b = tgt.closest<HTMLElement>('[data-book]');
  if (!b) return;
  currentBook = b.dataset.book || null;
  renderBooks();
  renderContacts();
});

// List
function contactMatches(c: Contact, q: string): boolean {
  if (!q) return true;
  const hay = [c.name, c.org, c.title, ...c.emails.map((x) => x.value), ...c.phones.map((x) => x.value.replace(/\s/g, ''))].join(' ').toLowerCase();
  return hay.includes(q) || hay.includes(q.replace(/\s/g, ''));
}

function renderContacts(): void {
  const q = el<HTMLInputElement>('#contact-search').value.trim().toLowerCase();
  const shown = contacts.filter((c) => (!currentBook || c.bookId === currentBook) && contactMatches(c, q));
  let last = '';
  el('#contact-list').innerHTML = shown
    .map((c) => {
      const letter = (c.name[0] || '#').toUpperCase();
      const head = letter !== last ? `<div class="letter">${esc(letter)}</div>` : '';
      last = letter;
      const sub = c.org || c.emails[0]?.value || c.phones[0]?.value || '';
      return `${head}<button class="person${c.id === selectedContact ? ' selected' : ''}" data-contact="${esc(c.id)}">
        <span class="avatar${c.photo ? ' has-img' : ''}">${c.photo ? `<img src="${esc(c.photo)}" alt="">` : esc(initials(c.name))}</span>
        <span class="who"><b>${esc(c.name)}</b><span>${esc(sub)}</span></span>
      </button>`;
    })
    .join('') + (q ? searchElsewhereHtml(el<HTMLInputElement>('#contact-search').value, shown.length > 0) : '');
  if (selectedContact && !contacts.some((c) => c.id === selectedContact)) {
    selectedContact = '';
    el('#contact-detail').innerHTML = `<div class="empty">${esc(t('contacts.noneSelected'))}</div>`;
  } else if (selectedContact) {
    renderContactDetail();
  }
}

el('#contact-search').addEventListener('input', renderContacts);
el('#contact-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  el<HTMLInputElement>('#contact-search').value = '';
  renderContacts();
});

// Show one contact (from the mail search): all books, no filter, scrolled into view
async function showContact(id: string): Promise<void> {
  await ensureContacts();
  if (!contacts.some((c) => c.id === id)) return;
  currentBook = null;
  el<HTMLInputElement>('#contact-search').value = '';
  selectedContact = id;
  renderBooks();
  renderContacts();
  document.querySelector(`#contact-list [data-contact="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' });
}

el('#contact-list').addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-contact]')?.dataset.contact;
  if (!id) return;
  selectedContact = id;
  renderContacts();
});

// Detail
function renderContactDetail(): void {
  const c = contacts.find((x) => x.id === selectedContact);
  if (!c) return;
  const book = books.find((b) => b.id === c.bookId);

  const fields: string[] = [];
  c.emails.forEach((m) =>
    fields.push(`<div class="c-field"><span class="k">${esc(t('field.email').toUpperCase())} · ${esc(typeLabel(m.type))}</span><button class="v" data-mailto="${esc(m.value)}">${esc(m.value)}</button></div>`),
  );
  c.phones.forEach((p) => fields.push(`<div class="c-field"><span class="k">${esc(t('contacts.phone').toUpperCase())} · ${esc(typeLabel(p.type))}</span><span class="v">${esc(p.value)}</span></div>`));
  if (c.birthday) {
    const d = new Date(c.birthday);
    const txt = isNaN(d.getTime()) ? c.birthday : d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
    fields.push(`<div class="c-field"><span class="k">${esc(t('contacts.birthday').toUpperCase())}</span><span class="v">${esc(txt)}</span></div>`);
  }
  if (c.note) fields.push(`<div class="c-field" style="grid-column: 1 / -1"><span class="k">${esc(t('field.note').toUpperCase())}</span><span class="v">${esc(c.note)}</span></div>`);

  // Latest mails of this contact from the loaded inbox
  const addrs = new Set(c.emails.map((m) => m.value.toLowerCase()));
  const recent = mails.filter((m) => addrs.has(m.fromAddress.toLowerCase())).slice(0, 5);
  const recentHtml = recent.length
    ? `<div class="c-section">${esc(t('contacts.recentMails').toUpperCase())}</div><div>${recent
        .map((m) => `<button class="c-mail" data-open-mail="${esc(mailKey(m))}"><span>${esc(m.subject || t('mail.noSubject'))}</span><span class="when">${fmtShort(m.date)}</span></button>`)
        .join('')}</div>`
    : '';

  const sub = [c.title, c.org].filter(Boolean).join(' · ');
  el('#contact-detail').innerHTML = `
    <div class="c-head">
      <span class="c-avatar${c.photo ? ' has-img' : ''}">${c.photo ? `<img src="${esc(c.photo)}" alt="">` : esc(initials(c.name))}</span>
      <div>
        <div class="book">${esc((book ? `${book.name} · ${book.accountName}` : '').toUpperCase())}</div>
        <h2>${esc(c.name)}</h2>
        ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
      </div>
    </div>
    <div class="c-actions">
      ${c.emails[0] ? `<button class="btn primary" data-mailto="${esc(c.emails[0].value)}">${esc(t('contacts.writeMail'))} →</button>` : ''}
      <button class="btn ghost" id="btn-contact-edit">${esc(t('btn.edit'))}</button>
    </div>
    ${fields.length ? `<div class="c-fields">${fields.join('')}</div>` : ''}
    ${recentHtml}`;
}

el('#contact-detail').addEventListener('click', (e) => {
  const tgt = e.target as HTMLElement;
  const to = tgt.closest<HTMLElement>('[data-mailto]')?.dataset.mailto;
  if (to) {
    openCompose({ to });
    return;
  }
  const key = tgt.closest<HTMLElement>('[data-open-mail]')?.dataset.openMail;
  if (key) {
    setView('mail');
    openMail(key);
    return;
  }
  const photo = tgt.closest<HTMLElement>('.c-avatar.has-img img');
  if (photo) {
    const c = contacts.find((x) => x.id === selectedContact);
    showPhotoLarge((photo as HTMLImageElement).src, c?.name ?? '');
    return;
  }
  if (tgt.closest('#btn-contact-edit')) {
    const c = contacts.find((x) => x.id === selectedContact);
    if (c) openContactDialog(c);
  }
});

// Contact dialog
const ctDlg = el<HTMLDialogElement>('#dlg-contact');
const ctForm = el<HTMLFormElement>('#form-contact');
const ctField = (n: string) => ctForm.elements.namedItem(n) as HTMLInputElement;
const ctBook = () => ctForm.elements.namedItem('book') as HTMLSelectElement;

function openContactDialog(c: Contact | null): void {
  if (!c && !books.length) {
    setContactsStatus(t('contacts.addAccountFirst'));
    return;
  }
  editingContact = c;
  ctForm.reset();
  el('#contact-error').textContent = '';
  el('#contact-title').innerHTML = t(c ? 'contacts.editTitle' : 'contacts.newTitle');
  const options = c ? books.filter((b) => b.id === c.bookId) : books;
  ctBook().innerHTML = options.map((b) => `<option value="${esc(b.id)}">${esc(b.name)} · ${esc(b.accountName)}</option>`).join('');
  ctBook().disabled = !!c;
  if (!c && currentBook) ctBook().value = currentBook;
  if (c) {
    ctField('firstName').value = c.firstName;
    ctField('lastName').value = c.lastName;
    ctField('org').value = c.org;
    ctField('title').value = c.title;
    ctField('emails').value = c.emails.map((m) => m.value).join('\n');
    ctField('phones').value = c.phones.map((p) => p.value).join('\n');
    ctField('note').value = c.note;
  }
  ctPhoto = undefined;
  showCtPhoto(c?.photo ?? null);
  el<HTMLButtonElement>('#btn-contact-delete').hidden = !c;
  ctDlg.showModal();
  ctField('firstName').focus();
}

el('#btn-new-contact').addEventListener('click', () => openContactDialog(null));

// Contact photo: upload (cropped square, 256 px), remove, view large
let ctPhoto: string | null | undefined; // undefined = unchanged

function showCtPhoto(src: string | null): void {
  const box = el('#ct-photo');
  const name = [ctField('firstName').value, ctField('lastName').value].filter(Boolean).join(' ') || editingContact?.name || '';
  box.classList.toggle('has-img', !!src);
  box.innerHTML = src ? `<img src="${esc(src)}" alt="">` : name ? esc(initials(name)) : '+';
  el<HTMLButtonElement>('#ct-photo-remove').hidden = !src;
}

function photoFromFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); // data: URL (blob: is blocked by the CSP)
    reader.onerror = () => reject(new Error(t('contacts.photoInvalid')));
    reader.onload = () => {
      const url = String(reader.result);
      const img = new Image();
      img.onload = () => {
        const size = 256;
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const x = c.getContext('2d')!;
        x.fillStyle = '#fff';
        x.fillRect(0, 0, size, size);
        x.imageSmoothingQuality = 'high';
        x.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
        resolve(c.toDataURL('image/jpeg', 0.86));
      };
      img.onerror = () => reject(new Error(t('contacts.photoInvalid')));
      img.src = url;
    };
    reader.readAsDataURL(file);
  });
}

async function takeCtPhoto(file: File | undefined): Promise<void> {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    ctPhoto = await photoFromFile(file);
    showCtPhoto(ctPhoto);
    el('#contact-error').textContent = '';
  } catch (err) {
    el('#contact-error').textContent = errMsg(err);
  }
}

el('#ct-photo').addEventListener('click', () => el<HTMLInputElement>('#ct-photo-file').click());
el('#ct-photo-pick').addEventListener('click', () => el<HTMLInputElement>('#ct-photo-file').click());
el<HTMLInputElement>('#ct-photo-file').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  takeCtPhoto(input.files?.[0]).finally(() => (input.value = ''));
});
el('#ct-photo-remove').addEventListener('click', () => {
  ctPhoto = null;
  showCtPhoto(null);
});
el('#ct-photo').addEventListener('dragover', (e) => {
  e.preventDefault();
  el('#ct-photo').classList.add('drop');
});
el('#ct-photo').addEventListener('dragleave', () => el('#ct-photo').classList.remove('drop'));
el('#ct-photo').addEventListener('drop', (e) => {
  e.preventDefault();
  el('#ct-photo').classList.remove('drop');
  takeCtPhoto((e as DragEvent).dataTransfer?.files?.[0]);
});

// View the photo large (click on the picture in the contact view)
function showPhotoLarge(src: string, name: string): void {
  const ov = document.createElement('div');
  ov.className = 'photo-view';
  ov.innerHTML = `<figure><img src="${esc(src)}" alt=""><figcaption>${esc(name)}</figcaption></figure>`;
  const close = () => {
    ov.classList.add('closing');
    setTimeout(() => ov.remove(), 150);
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (k: KeyboardEvent) => {
    if (k.key === 'Escape') {
      k.stopPropagation();
      close();
    }
  };
  ov.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(ov);
}
el('#btn-contact-cancel').addEventListener('click', () => ctDlg.close());

ctForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const lines = (n: string) => ctField(n).value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const btn = el<HTMLButtonElement>('#btn-contact-save');
  btn.disabled = true;
  el('#contact-error').textContent = '';
  try {
    await window.api.contacts.save({
      bookId: editingContact?.bookId ?? ctBook().value,
      url: editingContact?.id,
      firstName: ctField('firstName').value,
      lastName: ctField('lastName').value,
      org: ctField('org').value,
      title: ctField('title').value,
      emails: lines('emails'),
      phones: lines('phones'),
      note: ctField('note').value,
      photo: ctPhoto,
    });
    ctDlg.close();
    await loadContacts();
    if (ctPhoto !== undefined) refreshAvatars([...lines('emails'), ...(editingContact?.emails.map((m) => m.value) ?? [])]);
  } catch (err) {
    el('#contact-error').textContent = errMsg(err);
  } finally {
    btn.disabled = false;
  }
});

el('#btn-contact-delete').addEventListener('click', async () => {
  const c = editingContact;
  if (!c || !confirm(t('contacts.confirmDelete', { name: c.name }))) return;
  try {
    await window.api.contacts.delete(c.id);
    ctDlg.close();
    selectedContact = '';
    await loadContacts();
  } catch (err) {
    el('#contact-error').textContent = errMsg(err);
  }
});

// Add CardDAV account
const cardDlg = el<HTMLDialogElement>('#dlg-card-add');
const cardForm = el<HTMLFormElement>('#form-card-add');
const cardField = (n: string) => cardForm.elements.namedItem(n) as HTMLInputElement;

// Opened from Settings → Accounts
let editingCardAcc: string | null = null; // set = edit login

function setCardDialogMode(edit: boolean): void {
  cardDlg.querySelector('h2')!.innerHTML = t(edit ? 'dav.editTitle' : 'contacts.connectTitle');
  cardField('password').required = !edit;
  cardField('password').placeholder = edit ? t('account.passKeep') : '';
  el('#btn-card-add-save').textContent = t(edit ? 'btn.saveConnect' : 'btn.connect');
}

function openAddCardAccount(): void {
  editingCardAcc = null;
  cardForm.reset();
  setCardDialogMode(false);
  fillLocalDav(cardForm, null, false, el('#btn-card-add-save'));
  el('#card-add-error').textContent = '';
  cardDlg.showModal();
}

function openEditCardAccount(acc: CalAccount): void {
  editingCardAcc = acc.id;
  cardForm.reset();
  setCardDialogMode(true);
  cardField('name').value = acc.name;
  cardField('serverUrl').value = acc.serverUrl;
  cardField('username').value = acc.username;
  fillLocalDav(cardForm, acc, true, el('#btn-card-add-save'));
  el('#card-add-error').textContent = '';
  cardDlg.showModal();
}
el('#btn-card-add-cancel').addEventListener('click', () => cardDlg.close());
cardField('local').addEventListener('change', () => syncLocalDav(cardForm, !!editingCardAcc, el('#btn-card-add-save')));

cardForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = el<HTMLButtonElement>('#btn-card-add-save');
  btn.disabled = true;
  btn.textContent = t('btn.connecting');
  el('#card-add-error').textContent = '';
  try {
    const input = {
      name: cardField('name').value.trim(),
      serverUrl: cardField('serverUrl').value.trim(),
      username: cardField('username').value.trim(),
      password: cardField('password').value,
    };
    if (editingCardAcc) await window.api.contacts.updateAccount(editingCardAcc, input);
    else if (cardField('local').checked) await window.api.contacts.addLocalAccount(input.name);
    else await window.api.contacts.addAccount(input);
    cardDlg.close();
    await loadContacts();
  } catch (err) {
    el('#card-add-error').textContent = errMsg(err);
  } finally {
    btn.disabled = false;
    syncLocalDav(cardForm, !!editingCardAcc, btn);
  }
});

// Load contacts from the cache at startup for recipient suggestions
window.api.contacts
  .cached()
  .then((c) => {
    if (!contacts.length) contacts = c.contacts;
  })
  .catch(() => {});

// From a mail: create a new contact from a sender/recipient (dialog prefilled)
readerCreateContact = async (name: string, email: string) => {
  setView('contacts');
  await ensureContacts();
  openContactDialog(null);
  if (!ctDlg.open) return; // no address book available
  const parts = name.replace(/^"|"$/g, '').trim().split(/\s+/);
  ctField('firstName').value = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] || '';
  ctField('lastName').value = parts.length > 1 ? parts[parts.length - 1] : '';
  ctField('emails').value = email;
  const domain = email.split('@')[1] ?? '';
  if (domain && !/gmail|gmx|bluewin|outlook|hotmail|yahoo|icloud|me\.com|sunrise|hispeed|proton/i.test(domain)) {
    ctField('org').placeholder = domain.split('.').slice(-2, -1)[0] ?? '';
  }
};
