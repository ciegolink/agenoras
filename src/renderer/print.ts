// Print preview window: shows the PDF of the page for the chosen paper and orientation,
// then prints via the system dialog or saves the PDF.

const PV_KEY = 'ciegolink.print';
const pvRegion = (I18N.locale.split('-')[1] ?? '').toUpperCase();
const pvOpts: PrintOpts = {
  pageSize: ['US', 'CA'].includes(pvRegion) ? 'Letter' : 'A4',
  landscape: false,
  ...(() => {
    try {
      const o = JSON.parse(localStorage.getItem(PV_KEY) || '{}');
      return { ...(o.pageSize === 'A4' || o.pageSize === 'Letter' ? { pageSize: o.pageSize } : {}), ...(typeof o.landscape === 'boolean' ? { landscape: o.landscape } : {}) };
    } catch {
      return {};
    }
  })(),
};

const pvFrame = el<HTMLIFrameElement>('#pv-frame');
const pvLoading = el('#pv-loading');
const pvStatus = (s: string) => (el('#pv-status').textContent = s);
let pvBusy = false;
let pvTurn = 0;

function paintPvBar(): void {
  el<HTMLSelectElement>('#pv-size').value = pvOpts.pageSize;
  document.querySelectorAll<HTMLElement>('#pv-orient [data-orient]').forEach((b) => {
    const on = (b.dataset.orient === 'landscape') === pvOpts.landscape;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

async function refreshPreview(): Promise<void> {
  const turn = ++pvTurn;
  pvLoading.textContent = t('print.preparing');
  pvLoading.hidden = false;
  try {
    const url = await window.api.print.pdf({ ...pvOpts });
    if (turn !== pvTurn) return; // settings changed meanwhile
    pvFrame.src = `${url}#toolbar=0&navpanes=0&view=FitH`;
    pvFrame.hidden = false;
    pvLoading.hidden = true;
  } catch (err) {
    if (turn !== pvTurn) return;
    pvFrame.hidden = true;
    pvLoading.textContent = errMsg(err);
  }
}

function setPvOpts(p: Partial<PrintOpts>): void {
  Object.assign(pvOpts, p);
  localStorage.setItem(PV_KEY, JSON.stringify(pvOpts));
  paintPvBar();
  void refreshPreview();
}

async function pvRun(what: 'print' | 'save'): Promise<void> {
  if (pvBusy) return;
  pvBusy = true;
  document.querySelectorAll<HTMLButtonElement>('.pv-bar button').forEach((b) => (b.disabled = true));
  pvStatus('');
  try {
    if (what === 'print') {
      if (await window.api.print.print({ ...pvOpts })) return void window.api.win.close();
    } else {
      const file = await window.api.print.save({ ...pvOpts });
      if (file) pvStatus(t('print.saved', { file }));
    }
  } catch (err) {
    pvStatus(errMsg(err));
  } finally {
    pvBusy = false;
    document.querySelectorAll<HTMLButtonElement>('.pv-bar button').forEach((b) => (b.disabled = false));
  }
}

el<HTMLSelectElement>('#pv-size').addEventListener('change', (e) => setPvOpts({ pageSize: (e.target as HTMLSelectElement).value === 'Letter' ? 'Letter' : 'A4' }));
el('#pv-orient').addEventListener('click', (e) => {
  const o = (e.target as HTMLElement).closest<HTMLElement>('[data-orient]')?.dataset.orient;
  if (o) setPvOpts({ landscape: o === 'landscape' });
});
el('#pv-print').addEventListener('click', () => void pvRun('print'));
el('#pv-save').addEventListener('click', () => void pvRun('save'));
el('#pv-cancel').addEventListener('click', () => window.api.win.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.win.close();
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    void pvRun('print');
  }
});

window.api.print.init().then((job) => {
  if (!job) {
    pvLoading.textContent = t('print.gone');
    return;
  }
  document.title = `${t('print.title')}: ${job.title} – Agenoras`;
  el('#pv-title').textContent = job.title;
  pvFrame.title = t('print.title');
  paintPvBar();
  void refreshPreview();
});
