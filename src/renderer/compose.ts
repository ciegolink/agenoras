// Compose window (compose.html): WYSIWYG editor, multiple recipients (To/Cc/Bcc),
// send to all or individually, attachments as icons, senders/aliases with signature, templates, placeholders.
// Standalone: loads accounts, senders, templates and contacts itself; helpers come from common.ts.

const MAX_ATTACH = 25 * 1024 * 1024;
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

type RecipField = 'to' | 'cc' | 'bcc';

interface Recipient {
  name: string;
  address: string;
}

type ComposeAttachment =
  | { kind: 'file'; path: string; name: string; size: number }
  | { kind: 'fwd'; index: number; name: string; size: number }
  | { kind: 'data'; name: string; size: number; content: string; contentType: string };

const cform = el<HTMLFormElement>('#form-compose');
const cfield = (name: string) => cform.elements.namedItem(name) as HTMLInputElement;
const editor = el<HTMLDivElement>('#editor');
const fromSelect = () => cform.elements.namedItem('from') as HTMLSelectElement;
const recipients: Record<RecipField, Recipient[]> = { to: [], cc: [], bcc: [] };
let composeAtts: ComposeAttachment[] = [];
let fwdSource: { accountId: string; folder: string; uid: number } | null = null;
let threadInfo: { inReplyTo?: string; references?: string[] } = {};
let identities: Identity[] = [];
let templates: Template[] = [];
let sendMode: 'all' | 'each' = 'all';
let stickyEach = false; // "Individually to each" chosen in the mail view
let cAccounts: Account[] = [];
let cContacts: Contact[] = [];
let cSenders: Recipient[] = []; // previous senders from the inbox (for suggestions)
let dirty = false; // unsent changes → ask when closing
let sent = false;

const setInfo = (text: string) => (el('#compose-error').textContent = text);

// ---------- HTML helpers ----------

// sanitizeHtml() lives in common.ts (also used for signatures in the settings)

// plain-text alternative for recipients without HTML
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const out: string[] = [];
  const BLOCK = /^(P|DIV|H[1-6]|BLOCKQUOTE|PRE|UL|OL|TABLE|TR|HR)$/;
  const walk = (node: Node, quote: string) => {
    node.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        out.push((n.textContent ?? '').replace(/\s+/g, ' '));
        return;
      }
      if (!(n instanceof Element)) return;
      const tag = n.tagName;
      if (tag === 'BR') return void out.push('\n' + quote);
      if (tag === 'IMG') return void out.push(t('compose.imageText'));
      if (tag === 'LI') out.push('\n' + quote + '• ');
      else if (BLOCK.test(tag)) out.push('\n' + quote);
      walk(n, tag === 'BLOCKQUOTE' ? quote + '> ' : quote);
      if (tag === 'A') {
        const href = n.getAttribute('href') ?? '';
        if (href && href !== n.textContent && !href.startsWith('mailto:')) out.push(` (${href})`);
      }
      if (BLOCK.test(tag)) out.push('\n' + quote);
    });
  };
  walk(doc.body, '');
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// consistent look for the recipient
const wrapOutgoing = (html: string) =>
  `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.5; color: #1F2126">${html}</div>`;

// ---------- Editor ----------

let lastRange: Range | null = null;

document.addEventListener('selectionchange', () => {
  const sel = document.getSelection();
  if (sel?.rangeCount && editor.contains(sel.anchorNode)) {
    lastRange = sel.getRangeAt(0).cloneRange();
    updateToolbarState();
  }
});

function restoreSelection(): void {
  editor.focus();
  if (!lastRange) return;
  const sel = document.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(lastRange);
}

function exec(cmd: string, value?: string): void {
  restoreSelection();
  document.execCommand(cmd, false, value);
  updateToolbarState();
}

function updateToolbarState(): void {
  cform.querySelectorAll<HTMLElement>('[data-cmd]').forEach((b) => {
    const cmd = b.dataset.cmd!;
    if (['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].includes(cmd)) {
      b.classList.toggle('on', document.queryCommandState(cmd));
    }
  });
  const block = String(document.queryCommandValue('formatBlock') || 'p').toLowerCase();
  const sel = el<HTMLSelectElement>('#fmt-block');
  sel.value = ['h2', 'h3', 'blockquote'].includes(block) ? block : 'p';
}

cform.querySelectorAll<HTMLElement>('[data-cmd]').forEach((b) => {
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection in the editor
  b.addEventListener('click', () => exec(b.dataset.cmd!));
});

el('#fmt-block').addEventListener('change', () => exec('formatBlock', el<HTMLSelectElement>('#fmt-block').value));
el('#fmt-color').addEventListener('input', () => exec('foreColor', el<HTMLInputElement>('#fmt-color').value));

// Links: own input row (Electron has no prompt())
function openLinkRow(): void {
  const sel = document.getSelection();
  const a = sel?.anchorNode?.parentElement?.closest('a');
  el<HTMLInputElement>('#link-url').value = a?.getAttribute('href') ?? '';
  el('#link-row').hidden = false;
  el<HTMLInputElement>('#link-url').focus();
}

function applyLink(): void {
  let url = el<HTMLInputElement>('#link-url').value.trim();
  el('#link-row').hidden = true;
  if (!url) return exec('unlink');
  if (!/^(https?:|mailto:)/i.test(url)) url = url.includes('@') && !url.includes('/') ? `mailto:${url}` : `https://${url}`;
  restoreSelection();
  const sel = document.getSelection();
  if (sel && sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url.replace(/^mailto:/i, ''))}</a>`);
  else document.execCommand('createLink', false, url);
}

el('#btn-link').addEventListener('mousedown', (e) => e.preventDefault());
el('#btn-link').addEventListener('click', openLinkRow);
el('#link-ok').addEventListener('click', applyLink);
el('#link-cancel').addEventListener('click', () => {
  el('#link-row').hidden = true;
  restoreSelection();
});
el('#link-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    applyLink();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    el('#link-row').hidden = true;
    restoreSelection();
  }
});

editor.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openLinkRow();
  }
});

// Paste: sanitize foreign HTML, embed images from the clipboard
editor.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  const html = cd.getData('text/html');
  const imageItem = Array.from(cd.items).find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  e.preventDefault();
  if (html) {
    document.execCommand('insertHTML', false, sanitizeHtml(html));
  } else if (imageItem) {
    const file = imageItem.getAsFile();
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setInfo(t('compose.imageTooBig'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => document.execCommand('insertHTML', false, `<img src="${reader.result}" alt="">`);
    reader.readAsDataURL(file);
  } else {
    document.execCommand('insertText', false, cd.getData('text/plain'));
  }
});

function insertAtCaret(text: string): void {
  restoreSelection();
  document.execCommand('insertText', false, text);
}

// ---------- Recipients ----------

function parseRecipients(text: string): Recipient[] {
  return text
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
      return m ? { name: m[1].trim(), address: m[2].trim() } : { name: '', address: part.replace(/^mailto:/i, '') };
    });
}

const toList = (v?: string | string[]) => (Array.isArray(v) ? v.join(', ') : v ?? '');
const recipBox = (f: RecipField) => el(`.recips[data-field="${f}"]`);
const recipInput = (f: RecipField) => recipBox(f).querySelector('input') as HTMLInputElement;

function addRecipients(f: RecipField, list: Recipient[]): void {
  for (const r of list) {
    if (!recipients[f].some((x) => x.address.toLowerCase() === r.address.toLowerCase())) recipients[f].push(r);
  }
  renderRecipients(f);
}

function renderRecipients(f: RecipField): void {
  const box = recipBox(f);
  box.querySelectorAll('.chip-r').forEach((c) => c.remove());
  const input = recipInput(f);
  recipients[f].forEach((r, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip-r' + (EMAIL_RE.test(r.address) ? '' : ' invalid');
    chip.title = r.address;
    chip.innerHTML = `<span>${esc(r.name || r.address)}</span><button type="button" aria-label="${esc(t('common.removeItem', { name: r.address }))}" data-remove="${i}">×</button>`;
    box.insertBefore(chip, input);
  });
  if (recipients[f].length) el(`#row-${f}`)?.removeAttribute('hidden');
  updateSendMenu();
}

function commitInput(f: RecipField): void {
  const input = recipInput(f);
  if (input.value.trim()) addRecipients(f, parseRecipients(input.value));
  input.value = '';
  hideSuggest();
}

// ---------- Suggestions from contacts and previous senders ----------

let suggestField: RecipField | null = null;
let suggestItems: Recipient[] = [];
let suggestIndex = 0;
const suggestBox = el<HTMLUListElement>('#recip-suggest');

let cKnown: Recipient[] = []; // all known addresses (who wrote to me / whom I wrote to)

function suggestionSource(): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  const add = (name: string, address: string) => {
    const key = address.toLowerCase();
    if (!address || seen.has(key)) return;
    seen.add(key);
    out.push({ name, address });
  };
  for (const c of cContacts) for (const e of c.emails) add(c.name, e.value);
  for (const r of cKnown) add(r.name, r.address);
  for (const r of cSenders) add(r.name, r.address);
  return out;
}

function showSuggest(f: RecipField): void {
  const q = recipInput(f).value.trim().toLowerCase();
  if (!q) return hideSuggest();
  const chosen = new Set(recipients[f].map((r) => r.address.toLowerCase()));
  suggestItems = suggestionSource()
    .filter((r) => !chosen.has(r.address.toLowerCase()) && (r.name.toLowerCase().includes(q) || r.address.toLowerCase().includes(q)))
    .slice(0, 6);
  if (!suggestItems.length) return hideSuggest();
  suggestField = f;
  suggestIndex = 0;
  suggestBox.innerHTML = suggestItems
    .map((r, i) => `<li role="option" data-i="${i}" class="${i === 0 ? 'on' : ''}"><b>${esc(r.name || r.address)}</b><span>${esc(r.address)}</span></li>`)
    .join('');
  const box = recipBox(f);
  suggestBox.style.top = `${box.offsetTop + box.offsetHeight + 4}px`;
  suggestBox.style.left = `${box.offsetLeft}px`;
  suggestBox.style.width = `${box.offsetWidth}px`;
  suggestBox.hidden = false;
}

function hideSuggest(): void {
  suggestBox.hidden = true;
  suggestField = null;
}

function pickSuggestion(i: number): void {
  const f = suggestField;
  const r = suggestItems[i];
  if (!f || !r) return;
  recipInput(f).value = '';
  addRecipients(f, [r]);
  hideSuggest();
  recipInput(f).focus();
}

suggestBox.addEventListener('mousedown', (e) => {
  e.preventDefault(); // keep focus in the input field
  const li = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
  if (li) pickSuggestion(Number(li.dataset.i));
});

(['to', 'cc', 'bcc'] as RecipField[]).forEach((f) => {
  const box = recipBox(f);
  const input = recipInput(f);

  box.addEventListener('click', (e) => {
    const rm = (e.target as HTMLElement).closest<HTMLElement>('[data-remove]');
    if (rm) {
      recipients[f].splice(Number(rm.dataset.remove), 1);
      renderRecipients(f);
    }
    input.focus();
  });

  input.addEventListener('input', () => {
    if (/[,;]/.test(input.value)) {
      // comma/semicolon completes an address
      const parts = input.value.split(/[,;]/);
      const rest = parts.pop() ?? '';
      addRecipients(f, parseRecipients(parts.join(',')));
      input.value = rest.trimStart();
    }
    showSuggest(f);
    updateSendMenu();
  });

  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (!/[,;\n]/.test(text)) return;
    e.preventDefault();
    addRecipients(f, parseRecipients(input.value + text));
    input.value = '';
  });

  input.addEventListener('keydown', (e) => {
    const open = !suggestBox.hidden && suggestField === f;
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      suggestIndex = (suggestIndex + (e.key === 'ArrowDown' ? 1 : suggestItems.length - 1)) % suggestItems.length;
      suggestBox.querySelectorAll('li').forEach((li, i) => li.classList.toggle('on', i === suggestIndex));
    } else if (open && (e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      pickSuggestion(suggestIndex);
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      commitInput(f);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      hideSuggest();
    } else if (e.key === 'Backspace' && !input.value && recipients[f].length) {
      recipients[f].pop();
      renderRecipients(f);
    }
  });

  input.addEventListener('blur', () => {
    if (input.value.trim()) addRecipients(f, parseRecipients(input.value));
    input.value = '';
    setTimeout(hideSuggest, 100);
  });
});

cform.querySelectorAll<HTMLElement>('[data-show]').forEach((b) => {
  b.addEventListener('click', () => {
    const f = b.dataset.show as RecipField;
    el(`#row-${f}`).removeAttribute('hidden');
    recipInput(f).focus();
  });
});

// ---------- Attachments ----------

function renderComposeAtts(): void {
  const total = composeAtts.reduce((sum, a) => sum + a.size, 0);
  el('#compose-atts').innerHTML = composeAtts
    .map(
      (a, i) => `<div class="tile">
        <div class="tile-main" title="${esc(a.name)} · ${fmtSize(a.size)}">${fileIcon(a.name)}<span class="tname">${esc(a.name)}</span><span class="tsize">${fmtSize(a.size)}</span></div>
        <button type="button" class="tile-act" data-rm-att="${i}" aria-label="${esc(t('common.removeItem', { name: a.name }))}" title="${esc(t('common.remove'))}">×</button>
      </div>`,
    )
    .join('');
  const totalEl = el('#attach-total');
  const n = composeAtts.length;
  totalEl.textContent = n
    ? `${t(n === 1 ? 'att.countOne' : 'att.countMany', { n })} · ${fmtSize(total)}${total > MAX_ATTACH ? ` – ${t('att.tooBig')}` : ''}`
    : '';
  totalEl.classList.toggle('over', total > MAX_ATTACH);
  el('#atts-area').hidden = !n;
}

function addFiles(list: { path: string; name: string; size: number }[]): void {
  for (const f of list) {
    if (!composeAtts.some((a) => a.kind === 'file' && a.path === f.path)) composeAtts.push({ kind: 'file', ...f });
  }
  if (list.length) dirty = true;
  renderComposeAtts();
}

el('#compose-atts').addEventListener('click', (e) => {
  const i = (e.target as HTMLElement).closest<HTMLElement>('[data-rm-att]')?.dataset.rmAtt;
  if (i === undefined) return;
  composeAtts.splice(Number(i), 1);
  dirty = true;
  renderComposeAtts();
});

el('#btn-attach').addEventListener('click', async () => {
  try {
    addFiles(await window.api.files.pick());
  } catch (err) {
    setInfo(errMsg(err));
  }
});

async function addDroppedFiles(files: FileList): Promise<void> {
  const added: { path: string; name: string; size: number }[] = [];
  for (const file of Array.from(files)) {
    try {
      added.push(await window.api.files.dropped(file));
    } catch {
      /* skip folders or files without a path */
    }
  }
  addFiles(added);
}

// Drop files anywhere in the window → attachment (text drag in the editor stays normal)
let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault(); // never navigate away to the file
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (!hasFiles(e) || !e.dataTransfer?.files.length) return;
  // Images dropped directly onto the text → insert into the mail; everything else becomes an attachment
  const files = Array.from(e.dataTransfer.files);
  if ((e.target as Element).closest?.('#editor') && files.every((f) => f.type.startsWith('image/'))) {
    const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (pos) {
      lastRange = pos;
    }
    insertImages(files);
    return;
  }
  addDroppedFiles(e.dataTransfer.files);
});

// ---------- Sender and signature ----------

const identityOf = (id: string) => identities.find((i) => i.id === id);
// HTML signature takes precedence; text signature with the usual "-- " in front
function sigHtml(idn?: Identity): string {
  if (!idn) return '';
  if (idn.signatureHtml?.trim()) return `<div data-sig="1">${sanitizeHtml(idn.signatureHtml)}</div>`;
  const sig = idn.signature.trim();
  return sig ? `<div data-sig="1">-- <br>${esc(sig).replace(/\n/g, '<br>')}</div>` : '';
}

// For replies: the alias the original mail was sent to; otherwise the account's main address
function pickIdentity(accountId?: string, addresses: string[] = []): Identity | undefined {
  const wanted = new Set(addresses.map((a) => a.toLowerCase()));
  const pool = accountId ? identities.filter((i) => i.accountId === accountId) : identities;
  return (
    pool.find((i) => wanted.has(i.email.toLowerCase())) ??
    identities.find((i) => wanted.has(i.email.toLowerCase())) ??
    pool.find((i) => i.primary) ??
    identities[0]
  );
}

function fillFromSelect(selected?: string): void {
  fromSelect().innerHTML = cAccounts
    .map((acc) => {
      const opts = identities
        .filter((i) => i.accountId === acc.id)
        .map((i) => `<option value="${esc(i.id)}">${esc(i.name || acc.name)} &lt;${esc(i.email)}&gt;${i.primary ? '' : ` · ${esc(t('identity.alias'))}`}</option>`)
        .join('');
      return `<optgroup label="${esc(acc.email)}">${opts}</optgroup>`;
    })
    .join('');
  if (selected) fromSelect().value = selected;
}

// Swap the signature when the sender changes
// Remove all parts of the old signature (Enter inside the signature copies the marker to new lines)
// and insert the new one in the same place – otherwise before the quote or at the end.
function applySignature(identityId: string): void {
  const next = sigHtml(identityOf(identityId));
  const olds = Array.from(editor.querySelectorAll('[data-sig]'));
  const marker = document.createElement('span');
  if (olds.length) olds[0].before(marker);
  else {
    const quote = editor.querySelector('[data-quote]');
    if (quote) quote.before(marker);
    else editor.append(marker);
  }
  olds.forEach((o) => o.remove());
  if (next) marker.insertAdjacentHTML('beforebegin', next);
  marker.remove();
  dirty = true;
}

function paintFromDot(): void {
  const idn = identityOf(fromSelect().value);
  const acc = cAccounts.find((a) => a.id === idn?.accountId);
  el('#from-dot').style.background = acc?.color ?? 'transparent';
  el('#btn-from .fb-name').textContent = idn ? idn.name || acc?.name || idn.email : '';
  el('#btn-from .fb-mail').textContent = idn ? `<${idn.email}>` : '';
}

// Sender picker as its own menu (like templates/priority) – the hidden <select> holds the value
el('#btn-from').addEventListener('click', () => {
  const cur = fromSelect().value;
  const items: MenuItem[] = [];
  for (const acc of cAccounts) {
    const ids = identities.filter((i) => i.accountId === acc.id);
    if (!ids.length) continue;
    if (cAccounts.length > 1) items.push({ value: '', label: acc.email, cls: 'grp', dot: acc.color });
    for (const i of ids) items.push({ value: i.id, label: i.name || acc.name, hint: i.primary ? i.email : `${i.email} · ${t('identity.alias')}`, checked: i.id === cur });
  }
  openTbMenu(el('#btn-from'), items, (v) => {
    if (v === fromSelect().value) return;
    fromSelect().value = v;
    fromSelect().dispatchEvent(new Event('change'));
  });
  tbMenu.classList.add('from-menu');
  tbMenu.style.minWidth = `${el('#btn-from').offsetWidth}px`;
});

fromSelect().addEventListener('change', () => {
  applySignature(fromSelect().value);
  paintFromDot();
});

// ---------- Templates ----------

// ---------- Toolbar dropdown menus (templates, priority, placeholders) ----------

interface MenuItem {
  value: string;
  label: string;
  hint?: string;
  checked?: boolean;
  sep?: boolean;
  cls?: string;
  dot?: string;
}

const tbMenu = document.createElement('div');
tbMenu.className = 'ctx-menu tb-menu';
tbMenu.hidden = true;
tbMenu.setAttribute('role', 'menu');
document.body.appendChild(tbMenu);
let tbMenuPick: ((v: string) => void) | null = null;
let tbMenuFor: HTMLElement | null = null;

function openTbMenu(btn: HTMLElement, items: MenuItem[], pick: (v: string) => void): void {
  if (!tbMenu.hidden && tbMenuFor === btn) return closeTbMenu();
  tbMenu.innerHTML = items
    .map((i) =>
      i.sep
        ? '<hr>'
        : `<button type="button" role="menuitemradio" aria-checked="${!!i.checked}" class="${i.cls ?? ''}${i.checked ? ' on' : ''}" data-v="${esc(i.value)}"${i.value ? '' : ' disabled'}>
            <span class="mk">${i.dot ? `<i class="mdot" style="background:${esc(i.dot)}"></i>` : i.checked ? '✓' : ''}</span><span class="ml">${esc(i.label)}</span>${i.hint ? `<small>${esc(i.hint)}</small>` : ''}</button>`,
    )
    .join('');
  tbMenuPick = pick;
  tbMenuFor?.classList.remove('on');
  tbMenuFor = btn;
  tbMenu.hidden = false;
  const r = btn.getBoundingClientRect();
  tbMenu.style.top = `${r.bottom + 4}px`;
  tbMenu.style.left = `${Math.max(6, Math.min(r.left, innerWidth - tbMenu.offsetWidth - 8))}px`;
  btn.classList.add('on');
}

function closeTbMenu(): void {
  tbMenu.hidden = true;
  tbMenu.classList.remove('from-menu');
  tbMenu.style.minWidth = '';
  tbMenuFor?.classList.remove('on');
  tbMenuFor = null;
}

tbMenu.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection in the editor
tbMenu.addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>('[data-v]')?.dataset.v;
  if (!v) return;
  const pick = tbMenuPick;
  closeTbMenu();
  pick?.(v);
});
document.addEventListener('mousedown', (e) => {
  if (!tbMenu.hidden && !tbMenu.contains(e.target as Node) && !tbMenuFor?.contains(e.target as Node)) closeTbMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !tbMenu.hidden) {
    e.stopPropagation();
    closeTbMenu();
  }
});
window.addEventListener('blur', closeTbMenu);
window.addEventListener('resize', closeTbMenu);

// templates
function fillTemplateSelect(): void {
  /* list is built when the menu opens */
}

el('#btn-tpl').addEventListener('mousedown', (e) => e.preventDefault());
el('#btn-tpl').addEventListener('click', () => {
  openTbMenu(
    el('#btn-tpl'),
    [
      ...(templates.length ? templates.map((tpl) => ({ value: `tpl:${tpl.id}`, label: tpl.name, hint: tpl.subject })) : [{ value: '', label: t('compose.noTemplates') }]),
      { value: '-', label: '', sep: true },
      { value: 'save', label: t('compose.saveTemplate') },
    ],
    (v) => (v === 'save' ? showSaveTemplate() : applyTemplate(v.slice(4))),
  );
});

function applyTemplate(id: string): void {
  const tpl = templates.find((x) => x.id === id);
  if (!tpl) return;
  if (tpl.subject && (!cfield('subject').value.trim() || confirm(t('compose.replaceSubject')))) cfield('subject').value = tpl.subject;
  // Remove empty lines at the top, insert the template – signature and quote stay below
  while (editor.firstChild && !editor.firstElementChild?.matches('[data-sig],[data-quote]') && !(editor.firstChild.textContent ?? '').trim() && !(editor.firstChild as Element).querySelector?.('img')) {
    editor.firstChild.remove();
  }
  editor.insertAdjacentHTML('afterbegin', sanitizeHtml(tpl.html || textToHtml(tpl.body)) + '<p><br></p>');
  editor.focus();
  editor.scrollTop = 0;
  dirty = true;
}

// Save as template (without signature and quote, with formatting)
function showSaveTemplate(): void {
  el('#save-tpl-row').hidden = false;
  el<HTMLInputElement>('#tpl-name').value = cfield('subject').value.trim();
  el<HTMLInputElement>('#tpl-name').focus();
}
el('#btn-save-tpl-cancel').addEventListener('click', () => (el('#save-tpl-row').hidden = true));
el('#btn-save-tpl-ok').addEventListener('click', async () => {
  const name = el<HTMLInputElement>('#tpl-name').value.trim();
  if (!name) return;
  const clone = editor.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-sig],[data-quote]').forEach((n) => n.remove());
  const html = sanitizeHtml(clone.innerHTML).replace(/(<p><br><\/p>)+$/, '');
  const body = htmlToText(html);
  try {
    const existing = templates.find((tpl) => tpl.name.toLowerCase() === name.toLowerCase());
    const list = existing
      ? templates.map((tpl) => (tpl === existing ? { ...tpl, subject: cfield('subject').value, body, html } : tpl))
      : [...templates, { id: '', name, subject: cfield('subject').value, body, html }];
    templates = await window.api.settings.saveTemplates(list);
    fillTemplateSelect();
    el('#save-tpl-row').hidden = true;
    setInfo(t('compose.templateSaved', { name }));
  } catch (err) {
    setInfo(errMsg(err));
  }
});

// ---------- Placeholders ----------

// The placeholder is inserted in the app language ({{Vorname}} or {{FirstName}})
el('#btn-ph').addEventListener('mousedown', (e) => e.preventDefault());
el('#btn-ph').addEventListener('click', () => {
  const keys: [string, string][] = [
    ['first', 'ph.firstName'],
    ['last', 'ph.lastName'],
    ['name', 'ph.name'],
    ['company', 'ph.company'],
    ['email', 'ph.email'],
    ['date', 'ph.date'],
  ];
  openTbMenu(
    el('#btn-ph'),
    keys.map(([k, label]) => ({ value: k, label: t(label), hint: `{{${t(`ph.token.${k}`)}}}` })),
    (k) => insertAtCaret(`{{${t(`ph.token.${k}`)}}}`),
  );
});

// ---------- Priority (toolbar button) ----------

const prioInput = () => cform.elements.namedItem('priority') as HTMLInputElement;

function paintPriority(): void {
  const p = prioInput().value as Priority;
  // icon only: the current level is in the tooltip
  const tip = `${t('compose.priority')}: ${t(`prio.${p}`)}`;
  el('#btn-prio').title = tip;
  el('#btn-prio').setAttribute('aria-label', tip);
  el('#btn-prio').classList.toggle('prio-high', p === 'high');
  el('#btn-prio').classList.toggle('prio-low', p === 'low');
  const flag = el('#prio-flag');
  flag.hidden = p === 'normal';
  flag.className = `prio-flag ${p}`;
  flag.textContent = p === 'high' ? t('prio.highBadge') : t('prio.lowBadge');
}

el('#btn-prio').addEventListener('mousedown', (e) => e.preventDefault());
el('#btn-prio').addEventListener('click', () => {
  const cur = prioInput().value;
  openTbMenu(
    el('#btn-prio'),
    (['high', 'normal', 'low'] as Priority[]).map((p) => ({ value: p, label: t(`prio.${p}`), checked: p === cur, cls: `prio-${p}` })),
    (p) => {
      prioInput().value = p;
      paintPriority();
      dirty = true;
    },
  );
});
paintPriority();

// ---------- Insert images into the text (button, drop onto the text, paste) ----------

const MAX_IMG_W = 1600;

// Scale down large images so the mail does not get unnecessarily large
function imageToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const src = String(reader.result);
      const img = new Image();
      img.onerror = () => reject(new Error(t('ed.imageError')));
      img.onload = () => {
        if (img.naturalWidth <= MAX_IMG_W && file.size < 1.5 * 1024 * 1024) return resolve(src);
        const scale = Math.min(1, MAX_IMG_W / img.naturalWidth);
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        resolve(file.type === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.86));
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

async function insertImages(files: File[]): Promise<void> {
  for (const f of files) {
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(f.type)) continue;
    try {
      const url = await imageToDataUrl(f);
      restoreSelection();
      document.execCommand('insertHTML', false, `<img src="${url}" alt="${esc(f.name)}" style="max-width: 100%">`);
      dirty = true;
    } catch (err) {
      setInfo(errMsg(err));
    }
  }
}

el('#btn-image').addEventListener('mousedown', (e) => e.preventDefault());
el('#btn-image').addEventListener('click', () => el<HTMLInputElement>('#image-input').click());
el('#image-input').addEventListener('change', () => {
  const input = el<HTMLInputElement>('#image-input');
  insertImages(Array.from(input.files ?? []));
  input.value = '';
});

// Both languages are recognized – a template works regardless of the app language
const PH_ALIASES: Record<string, string> = {
  vorname: 'first', firstname: 'first',
  nachname: 'last', lastname: 'last',
  name: 'name',
  firma: 'company', company: 'company',
  'e-mail': 'email', email: 'email',
  datum: 'date', date: 'date',
};
const PLACEHOLDER_RE = /\{\{\s*(Vorname|FirstName|Nachname|LastName|Name|Firma|Company|E-Mail|Email|Datum|Date)\s*\}\}/gi;
const hasPlaceholders = () => new RegExp(PLACEHOLDER_RE.source, 'i').test(`${editor.textContent} ${cfield('subject').value}`);

function placeholderValues(r: Recipient): Record<string, string> {
  const c = cContacts.find((x) => x.emails.some((e) => e.value.toLowerCase() === r.address.toLowerCase()));
  const name = c?.name || r.name || '';
  return {
    first: c?.firstName || name.split(/\s+/)[0] || '',
    last: c?.lastName || name.split(/\s+/).slice(1).join(' '),
    name,
    company: c?.org ?? '',
    email: r.address,
    date: new Date().toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }),
  };
}

function personalize(text: string, r: Recipient): string {
  const v = placeholderValues(r);
  return text
    .replace(PLACEHOLDER_RE, (_m, key: string) => v[PH_ALIASES[key.toLowerCase()]] ?? '')
    .replace(/ +([,.!?])/g, '$1') // "Hallo ," → "Hallo,"
    .replace(/[ \t]+$/gm, ''); // "Hallo " → "Hallo"
}

function personalizeHtml(html: string, r: Recipient): string {
  const v = placeholderValues(r);
  return html.replace(PLACEHOLDER_RE, (_m, key: string) => esc(v[PH_ALIASES[key.toLowerCase()]] ?? '')).replace(/ +([,.!?])/g, '$1');
}

// ---------- Send: split button "to all" / "individually to each" ----------

const toCount = () => recipients.to.length + (recipInput('to').value.trim() ? 1 : 0);

function updateSendMenu(): void {
  const multi = toCount() > 1;
  el<HTMLButtonElement>('#btn-send-menu').disabled = !multi;
  el('#send-each-label').textContent = multi ? t('compose.sendEachN', { n: toCount() }) : t('compose.sendEach');
  if (!multi) el('#send-menu').hidden = true;
}

el('#btn-send-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  el('#send-menu').hidden = !el('#send-menu').hidden;
});
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('#send-menu')) el('#send-menu').hidden = true;
});
el('#send-menu').addEventListener('click', (e) => {
  const mode = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]')?.dataset.mode as 'all' | 'each' | undefined;
  if (!mode) return;
  el('#send-menu').hidden = true;
  sendMode = mode;
  cform.requestSubmit();
});

// ---------- Fill the window ----------

function initCompose(o: ComposeOpts): void {
  const identity = pickIdentity(o.accountId, o.matchAddresses);
  fillFromSelect(identity?.id);
  paintFromDot();
  fillTemplateSelect();

  // Never take over own addresses (account + aliases) as recipients
  const own = new Set([...cAccounts.map((a) => a.email), ...identities.map((i) => i.email)].map((a) => a.toLowerCase()));
  const notOwn = (r: Recipient) => !own.has(r.address.toLowerCase());
  recipients.to = parseRecipients(toList(o.to));
  recipients.cc = parseRecipients(toList(o.cc)).filter(notOwn);
  recipients.bcc = [];
  el('#row-cc').toggleAttribute('hidden', !recipients.cc.length);
  (['to', 'cc', 'bcc'] as RecipField[]).forEach((f) => renderRecipients(f));

  cfield('subject').value = o.subject ?? '';
  // Layout: space to write – signature – quote
  editor.innerHTML = '<p><br></p><p><br></p>' + sigHtml(identity) + (o.quoteHtml ? `<div data-quote="1">${sanitizeHtml(o.quoteHtml)}</div>` : '');
  threadInfo = { inReplyTo: o.inReplyTo, references: o.references };

  const fw = o.forward;
  fwdSource = fw ? { accountId: fw.accountId, folder: fw.folder ?? 'INBOX', uid: fw.uid } : null;
  composeAtts = fw ? fw.attachments.map((a, index) => ({ kind: 'fwd' as const, index, name: a.filename, size: a.size })) : [];
  for (const f of o.files ?? []) composeAtts.push({ kind: 'file', ...f });
  for (const d of o.attachData ?? []) composeAtts.push({ kind: 'data', name: d.filename, size: Math.round((d.content.length * 3) / 4), content: d.content, contentType: d.contentType });
  renderComposeAtts();

  const mode = o.mode ?? 'new';
  el('#compose-title').innerHTML = t(`compose.heading.${mode}`); // with <em>, from the language file
  document.title = `${t(`compose.window.${mode}`)} – Agenoras`;
  updateWindowTitle();

  if (!recipients.to.length) recipInput('to').focus();
  else {
    editor.focus();
    const r = document.createRange();
    r.setStart(editor.firstChild ?? editor, 0);
    r.collapse(true);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(r);
  }
  dirty = !!o.files?.length;
  if (o.sendMode === 'each' && recipients.to.length > 1) {
    stickyEach = true;
    el('#btn-send').textContent = t('compose.sendEachBtn');
    setInfo(t('compose.eachPreselected', { n: recipients.to.length }));
  }
}

function updateWindowTitle(): void {
  const subject = cfield('subject').value.trim();
  if (subject) document.title = `${subject} – Agenoras`;
}
cfield('subject').addEventListener('input', updateWindowTitle);

// Track changes → ask when closing (the main process shows the prompt)
cform.addEventListener('input', () => (dirty = true));
editor.addEventListener('input', () => (dirty = true));
window.addEventListener('beforeunload', (e) => {
  if (dirty && !sent) {
    e.preventDefault();
    e.returnValue = false;
  }
});

// ---------- Send ----------

el('#btn-discard').addEventListener('click', () => window.close());

cform.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    cform.requestSubmit();
  }
});

window.api.onSendProgress((done, total) => {
  el('#send-progress').textContent = t('compose.progress', { done, total });
});

cform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = stickyEach ? 'each' : sendMode;
  sendMode = 'all'; // applies to this send only
  (['to', 'cc', 'bcc'] as RecipField[]).forEach(commitInput);

  const each = mode === 'each' && recipients.to.length > 1;
  const all = each ? recipients.to : [...recipients.to, ...recipients.cc, ...recipients.bcc];
  const invalid = all.filter((r) => !EMAIL_RE.test(r.address));
  const errBox = el('#compose-error');
  if (!all.length) {
    errBox.textContent = t('compose.needRecipient');
    recipInput('to').focus();
    return;
  }
  if (invalid.length) {
    errBox.textContent = t('compose.invalidAddress', { list: invalid.map((r) => r.address).join(', ') });
    return;
  }
  if (composeAtts.reduce((s, a) => s + a.size, 0) > MAX_ATTACH) {
    errBox.textContent = t('att.totalTooBig');
    return;
  }
  // Placeholders only work if everyone gets their own mail
  if (!each && all.length > 1 && hasPlaceholders()) {
    if (!confirm(t('compose.placeholdersConfirm'))) return;
    sendMode = 'each';
    return cform.requestSubmit();
  }
  if (each && (recipients.cc.length || recipients.bcc.length) && !confirm(t('compose.ccIgnoredConfirm'))) return;
  if (!cfield('subject').value.trim() && !confirm(t('compose.noSubjectConfirm'))) return;
  if (each && !confirm(t('compose.eachConfirm', { n: recipients.to.length }))) return;

  const fmt = (r: Recipient) => (r.name ? `"${r.name.replace(/"/g, '')}" <${r.address}>` : r.address);
  const fwdIdx = composeAtts.filter((a) => a.kind === 'fwd').map((a) => (a as { index: number }).index);
  const subject = cfield('subject').value.trim();
  const html = sanitizeHtml(editor.innerHTML);
  const single = !each && all.length === 1 ? all[0] : null;
  const build = (r: Recipient | null) => {
    const h = r ? personalizeHtml(html, r) : html;
    return { subject: r ? personalize(subject, r) : subject, html: wrapOutgoing(h), text: htmlToText(h) };
  };

  // a few seconds to undo, then really send
  errBox.textContent = '';
  if (!(await sendCountdown())) return;
  const send = el<HTMLButtonElement>('#btn-send');
  send.disabled = true;
  send.textContent = t('compose.sending');
  try {
    const main = build(single);
    const res = await window.api.sendMail({
      identityId: fromSelect().value,
      to: recipients.to.map(fmt),
      cc: each ? [] : recipients.cc.map(fmt),
      bcc: each ? [] : recipients.bcc.map(fmt),
      ...main,
      priority: (cform.elements.namedItem('priority') as HTMLSelectElement).value as Priority,
      inReplyTo: threadInfo.inReplyTo,
      references: threadInfo.references,
      files: composeAtts.filter((a) => a.kind === 'file').map((a) => (a as { path: string }).path),
      forward: fwdSource && fwdIdx.length ? { ...fwdSource, indexes: fwdIdx } : undefined,
      extraAttachments: composeAtts.filter((a) => a.kind === 'data').map((a) => ({ filename: a.name, content: (a as { content: string }).content, contentType: (a as { contentType: string }).contentType })),
      individual: each ? recipients.to.map((r) => ({ to: fmt(r), ...build(r) })) : undefined,
    });
    if (res.failed.length) {
      // Failed ones stay in the field so they can be sent again
      const failed = new Set(res.failed.map((f) => f.to));
      recipients.to = recipients.to.filter((r) => failed.has(fmt(r)));
      renderRecipients('to');
      errBox.textContent = t('compose.partialFail', { sent: res.sent, failed: res.failed.length, list: res.failed.map((f) => `${f.to} (${f.message})`).join('; ') });
      el('#send-progress').textContent = '';
      return;
    }
    sent = true;
    await showSent();
    await window.api.compose.done(each ? t('compose.sentEach', { n: res.sent }) : t('compose.sentAll', { n: all.length }));
  } catch (err) {
    errBox.textContent = errMsg(err);
  } finally {
    hideSendOverlay();
    send.disabled = false;
    send.textContent = stickyEach ? t('compose.sendEachBtn') : t('compose.send');
  }
});

// ---------- Send with undo (circle runs for the configured delay) ----------

let undoMs = 2000; // Settings → Senders & signatures → delay (0–5 s)
const sendOverlay = document.createElement('div');
sendOverlay.className = 'send-undo';
sendOverlay.hidden = true;
sendOverlay.setAttribute('role', 'status');
sendOverlay.innerHTML = `
  <svg class="ring" width="34" height="34" viewBox="0 0 36 36" aria-hidden="true">
    <circle cx="18" cy="18" r="15" class="ring-bg"/><circle cx="18" cy="18" r="15" class="ring-fg"/>
    <path class="ring-check" d="m11.5 18.5 4.5 4.5 8.5-9"/>
  </svg>
  <span class="su-text"></span>
  <button type="button" class="btn ghost sm su-undo"></button>`;
cform.appendChild(sendOverlay);

function hideSendOverlay(): void {
  sendOverlay.hidden = true;
  sendOverlay.className = 'send-undo';
}

function sendCountdown(): Promise<boolean> {
  if (undoMs <= 0) {
    sendOverlay.className = 'send-undo sending';
    sendOverlay.hidden = false;
    sendOverlay.querySelector('.su-text')!.textContent = t('compose.sending');
    sendOverlay.querySelector<HTMLButtonElement>('.su-undo')!.hidden = true;
    return Promise.resolve(true);
  }
  sendOverlay.querySelector<SVGElement>('.ring-fg')!.style.animationDuration = `${undoMs}ms`;
  return new Promise((resolve) => {
    sendOverlay.className = 'send-undo counting';
    sendOverlay.hidden = false;
    sendOverlay.querySelector('.su-text')!.textContent = t('compose.sendingIn');
    const undo = sendOverlay.querySelector<HTMLButtonElement>('.su-undo')!;
    undo.hidden = false;
    undo.textContent = t('compose.undo');
    undo.focus();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      undo.removeEventListener('click', onUndo);
      document.removeEventListener('keydown', onKey, true);
      if (ok) {
        sendOverlay.className = 'send-undo sending';
        sendOverlay.querySelector('.su-text')!.textContent = t('compose.sending');
        undo.hidden = true;
      } else {
        hideSendOverlay();
        setInfo(t('compose.sendCancelled'));
        editor.focus();
      }
      resolve(ok);
    };
    const onUndo = () => finish(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z')) {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    };
    undo.addEventListener('click', onUndo);
    document.addEventListener('keydown', onKey, true);
    const timer = setTimeout(() => finish(true), undoMs);
  });
}

// Show a check mark briefly, then the window closes
function showSent(): Promise<void> {
  window.api.compose.sent().catch(() => {}); // the "ding" comes from the main window
  sendOverlay.className = 'send-undo sent';
  sendOverlay.hidden = false;
  sendOverlay.querySelector('.su-text')!.textContent = t('compose.sentShort');
  sendOverlay.querySelector<HTMLButtonElement>('.su-undo')!.hidden = true;
  return new Promise((r) => setTimeout(r, 650));
}

// ---------- Startup: load everything the window needs ----------

(async () => {
  const [opts, accs, settings, book, inbox] = await Promise.all([
    window.api.compose.init(),
    window.api.listAccounts(),
    window.api.settings.get().catch(() => ({ identities: [], templates: [] })),
    window.api.contacts.cached().catch(() => ({ books: [], contacts: [] })),
    window.api.cachedMail(null).catch(() => [] as MailSummary[]),
  ]);
  cAccounts = accs;
  identities = settings.identities;
  templates = settings.templates;
  undoMs = Math.min(5, Math.max(0, (settings as { sendDelay?: number }).sendDelay ?? 2)) * 1000;
  cContacts = book.contacts;
  cSenders = inbox.map((m) => ({ name: m.from, address: m.fromAddress }));
  window.api
    .knownAddresses()
    .then((list) => (cKnown = list))
    .catch(() => {});
  initCompose(opts);
})();
