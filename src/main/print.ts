// Printing with a preview: the renderer builds a self-contained HTML page (mail, task, event, feed article),
// a hidden window loads it without JavaScript and without network, printToPDF makes the preview.
// From the preview window: print via the system dialog or save as PDF.
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { t } from './i18n';

export interface PrintJob {
  title: string;
  html: string; // complete document
}

export interface PrintOpts {
  pageSize: 'A4' | 'Letter';
  landscape: boolean;
}

interface Job {
  title: string;
  docFile: string;
  pdfFiles: string[];
  worker: BrowserWindow;
  ready: Promise<void>;
}

const jobs = new Map<number, Job>(); // preview window webContents id → job
const tmpDir = () => path.join(app.getPath('temp'), 'agenoras', 'print');
const cleanOpts = (o: Partial<PrintOpts> | undefined): PrintOpts => ({ pageSize: o?.pageSize === 'Letter' ? 'Letter' : 'A4', landscape: o?.landscape === true });

// Own in-memory session: only the page itself and data: images, nothing from the network or the disk
let printSession: Electron.Session | null = null;
const allowed = new Set<string>();
function getSession(): Electron.Session {
  if (printSession) return printSession;
  printSession = session.fromPartition('agenoras-print');
  printSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url.startsWith('data:') || allowed.has(d.url)) }));
  printSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  return printSession;
}

function makeWorker(docFile: string): { worker: BrowserWindow; ready: Promise<void> } {
  const url = pathToFileURL(docFile).href;
  allowed.add(url);
  const worker = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { session: getSession(), javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webgl: false },
  });
  worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  worker.webContents.on('will-navigate', (e) => e.preventDefault());
  const ready = worker.loadURL(url).then(() => undefined);
  return { worker, ready };
}

function dropJob(id: number): void {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  allowed.delete(pathToFileURL(job.docFile).href);
  if (!job.worker.isDestroyed()) job.worker.destroy();
  for (const f of [job.docFile, ...job.pdfFiles]) fs.rm(f, { force: true }, () => {});
}

// Remove what an earlier run left behind (crash, killed process)
export function cleanPrintFiles(): void {
  fs.rm(tmpDir(), { recursive: true, force: true }, () => {});
}

export function openPrintPreview(job: PrintJob, parent: BrowserWindow | null, makeWindow: (parent: BrowserWindow | null) => BrowserWindow): void {
  fs.mkdirSync(tmpDir(), { recursive: true });
  const docFile = path.join(tmpDir(), `${crypto.randomUUID()}.html`);
  fs.writeFileSync(docFile, String(job.html ?? ''), 'utf8');
  const { worker, ready } = makeWorker(docFile);
  const pv = makeWindow(parent);
  const id = pv.webContents.id;
  jobs.set(id, { title: String(job.title ?? '').slice(0, 200) || 'Agenoras', docFile, pdfFiles: [], worker, ready });
  pv.on('closed', () => dropJob(id));
}

const pdfOptions = (o: PrintOpts) => ({
  pageSize: o.pageSize,
  landscape: o.landscape,
  printBackground: true,
  margins: { top: 0.55, bottom: 0.65, left: 0.6, right: 0.6 },
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate: '<div style="width:100%;font:8px system-ui,sans-serif;color:#888;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
});

async function makePdf(id: number, opts: PrintOpts): Promise<Buffer> {
  const job = jobs.get(id);
  if (!job) throw new Error(t('print.gone'));
  await job.ready;
  return job.worker.webContents.printToPDF(pdfOptions(opts));
}

const safeFile = (n: string) => n.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Agenoras';

export function registerPrintIpc(): void {
  ipcMain.handle('print:init', (e) => {
    const job = jobs.get(e.sender.id);
    return job ? { title: job.title } : null;
  });

  // Preview: a fresh PDF file for these settings (the viewer in the preview window shows it)
  ipcMain.handle('print:pdf', async (e, o: Partial<PrintOpts>) => {
    const job = jobs.get(e.sender.id);
    if (!job) throw new Error(t('print.gone'));
    const data = await makePdf(e.sender.id, cleanOpts(o));
    const file = path.join(tmpDir(), `${crypto.randomUUID()}.pdf`);
    await fs.promises.writeFile(file, data);
    for (const old of job.pdfFiles.splice(0)) fs.rm(old, { force: true }, () => {});
    job.pdfFiles.push(file);
    return pathToFileURL(file).href;
  });

  // System print dialog (printer, copies, pages …); true = sent to the printer
  ipcMain.handle('print:print', async (e, o: Partial<PrintOpts>) => {
    const job = jobs.get(e.sender.id);
    if (!job) throw new Error(t('print.gone'));
    await job.ready;
    const opts = cleanOpts(o);
    return new Promise<boolean>((resolve, reject) => {
      job.worker.webContents.print({ silent: false, printBackground: true, landscape: opts.landscape, pageSize: opts.pageSize }, (ok, reason) => {
        if (ok || !reason || /cancel/i.test(reason)) resolve(ok);
        else reject(new Error(reason));
      });
    });
  });

  ipcMain.handle('print:save', async (e, o: Partial<PrintOpts>) => {
    const job = jobs.get(e.sender.id);
    if (!job) throw new Error(t('print.gone'));
    const owner = BrowserWindow.fromWebContents(e.sender);
    const opts = { title: t('print.savePdf'), defaultPath: path.join(app.getPath('documents'), `${safeFile(job.title)}.pdf`), filters: [{ name: 'PDF', extensions: ['pdf'] }] };
    const res = owner ? await dialog.showSaveDialog(owner, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    await fs.promises.writeFile(res.filePath, await makePdf(e.sender.id, cleanOpts(o)));
    return res.filePath;
  });
}
