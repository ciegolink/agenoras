// Mail in its own window (double-click in the list). Display building blocks come from reader.ts.

let viewMsg: MailDetail | null = null;
const setViewStatus = (s: string) => (el('#status').textContent = s);

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
  reader.innerHTML = `
    <div class="reader-actions">${replyButtonsHtml()}</div>
    ${metaHtml(msg, `${accLabel(acc).toUpperCase()} · ${folderName.toUpperCase()}`, readable(acc?.color ?? '#969993'))}
    ${inviteCardHtml(msg)}
    <div id="body"></div>
    ${attachmentsHtml(msg)}`;
  mountMailBody(el('#body'), msg, () => showMail(ref, true));
  fillInviteCalendars();
}

el('#reader').addEventListener('click', async (e) => {
  const tgt = e.target as HTMLElement;
  const action = tgt.closest<HTMLElement>('[data-action]')?.dataset.action;
  const msg = viewMsg;
  if (!msg) return;
  if (action === 'reply' || action === 'replyAll') return void window.api.compose.open(replyOpts(msg, action === 'replyAll'));
  if (action === 'forward') return void window.api.compose.open(forwardOpts(msg));
  await attachmentAction(msg, tgt, setViewStatus);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.win.close();
});

window.api.mailview.init().then((ref) => {
  if (ref) showMail(ref);
});
