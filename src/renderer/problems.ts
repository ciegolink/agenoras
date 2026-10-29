// Problem log: warning sign in the title bar (with the number of new problems) and the log dialog.
// Uses el, esc, t, LOCALE from common.ts and setStatus from renderer.ts.

const logDlg = el<HTMLDialogElement>('#dlg-log');
let logEntries: LogEntry[] = [];

function paintLogButton(state: LogState): void {
  const btn = el<HTMLButtonElement>('#btn-log');
  btn.hidden = !state.total; // nothing logged → no sign
  btn.classList.toggle('alert', state.unseen > 0);
  el('#log-badge').textContent = state.unseen ? String(Math.min(state.unseen, 99)) : '';
}

function logTime(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' })} ${time}`;
}

const LEVEL_ICON = { error: '✕', warn: '!' } as const;

async function renderLog(): Promise<void> {
  logEntries = await window.api.log.list().catch(() => [] as LogEntry[]);
  el('#log-list').innerHTML =
    [...logEntries]
      .reverse()
      .map(
        (e) => `<div class="log-row ${e.level}">
          <span class="lv">${LEVEL_ICON[e.level]}</span>
          <span class="log-time">${esc(logTime(e.time))}</span>
          <span class="log-src">${esc(e.source)}</span>
          <span class="log-acc" title="${esc(e.account)}">${esc(e.account || '–')}</span>
          <div class="log-msg">${esc(e.message)}${e.count > 1 ? `<span class="log-n">×${e.count}</span>` : ''}</div>
        </div>`,
      )
      .join('') || `<div class="log-empty">${esc(t('log.empty'))}</div>`;
}

el('#btn-log').addEventListener('click', async () => {
  await renderLog();
  logDlg.showModal();
  paintLogButton(await window.api.log.seen());
});
el('#btn-log-close').addEventListener('click', () => logDlg.close());
el('#btn-log-clear').addEventListener('click', async () => {
  paintLogButton(await window.api.log.clear());
  await renderLog();
  setStatus(t('log.cleared'));
});
el('#btn-log-copy').addEventListener('click', async () => {
  const text = logEntries.map((e) => `${e.time}\t${e.level.toUpperCase()}\t${e.source}\t${e.account}\t${e.message}${e.count > 1 ? ` (×${e.count})` : ''}`).join('\n');
  await navigator.clipboard.writeText(text).catch(() => {});
  setStatus(t('log.copied'));
});

// New problem: update the sign; with the dialog open, also the list (and it counts as seen)
window.api.log.onChanged(async (state) => {
  if (logDlg.open) {
    await renderLog();
    if (state.unseen) state = await window.api.log.seen();
  }
  paintLogButton(state);
});

window.api.log.state().then(paintLogButton).catch(() => {});
