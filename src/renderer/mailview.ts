// Mail in its own window (double-click in the list). Display building blocks come from reader.ts.

let viewMsg: MailDetail | null = null;
let viewKicker = '';
const setViewStatus = (s: string) => (el('#status').textContent = s);
readerStatus = setViewStatus; // right-click menu on attachments (reader.ts)

async function showMail(ref: MailRef, loadImages = false): Promise<void> {
  const reader = el('#reader');
  let msg: MailDetail;
  try {
    msg = { ...(await window.api.getMail(ref.accountId, ref.folder, ref.uid, loadImages)), folder: ref.folder };
  } catch (e) {
    reader.innerHTML = `<div class="empty">${esc(errMsg(e))}</div>`;
    return;
  }
  viewMsg = msg;
  document.title = `${msg.subject || t('mail.noSubject')} – Agenoras`;
  const acc = (await window.api.listAccounts().catch(() => [] as Account[])).find((a) => a.id === ref.accountId);
  const folderName = ref.folder === 'INBOX' ? t('folder.inbox') : ref.folder.split(/[/.]/).pop() || ref.folder;
  // an .eml file: its name instead of account and folder
  viewKicker = msg.fileName ? `${t('eml.file').toUpperCase()} · ${msg.fileName}` : `${accLabel(acc).toUpperCase()} · ${folderName.toUpperCase()}`;
  reader.innerHTML = `
    <div class="reader-actions">${replyButtonsHtml()}<span class="spacer"></span><button class="icon-btn sm" data-action="print" aria-label="${esc(t('print.button'))}" title="${esc(t('print.buttonTip'))}">${ACT_ICONS.print}</button></div>
    ${metaHtml(msg, viewKicker, readable(acc?.color ?? '#969993'))}
    ${inviteCardHtml(msg)}
    <div id="body"></div>
    ${attachmentsHtml(msg)}`;
  mountMailBody(el('#body'), msg, () => showMail(ref, true));
  void fillAnswered(reader, msg, undefined);
  fillInviteCalendars();
}

el('#reader').addEventListener('click', async (e) => {
  const tgt = e.target as HTMLElement;
  const action = tgt.closest<HTMLElement>('[data-action]')?.dataset.action;
  const msg = viewMsg;
  if (!msg) return;
  if (action === 'reply' || action === 'replyAll') return void window.api.compose.open(replyOpts(msg, action === 'replyAll'));
  if (action === 'forward') return void window.api.compose.open(forwardOpts(msg));
  if (action === 'print') return printMail(bodyMsg ?? msg, viewKicker, setViewStatus);
  if (await reactionAction(msg, tgt, setViewStatus)) return;
  await attachmentAction(msg, tgt, setViewStatus);
});

document.addEventListener('keydown', (e) => {
  // Ctrl+R reply, Ctrl+Shift+R reply all, Ctrl+Shift+F forward (as in the main window)
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'r' || (k === 'f' && e.shiftKey))) {
    e.preventDefault();
    if (!viewMsg) return;
    if (k === 'r') window.api.compose.open(replyOpts(viewMsg, e.shiftKey));
    else window.api.compose.open(forwardOpts(viewMsg));
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    if (viewMsg) printMail(bodyMsg ?? viewMsg, viewKicker, setViewStatus);
    return;
  }
  if (e.key === 'Escape') window.api.win.close();
});

// .eml files dropped on the window open in a mail window of their own
dropEmlFiles();
document.addEventListener('emlstatus', (e) => setViewStatus((e as CustomEvent<string>).detail));

window.api.mailview.init().then((ref) => {
  if (ref) showMail(ref);
});
