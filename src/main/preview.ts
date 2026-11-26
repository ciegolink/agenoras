// Attachment preview in a side panel of the window (main window, compose, mail window):
// PDFs in a locked-down <webview> (Chromium's PDF viewer, no network), images and text directly in the page.
// The page gets a token; "Save" and "Open with app" work on the file kept here.
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { t } from './i18n';

export interface ViewFile {
  filename: string;
  contentType: string;
  content: Buffer;
}

type Kind = 'pdf' | 'image' | 'text' | 'none';
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
const TEXT = /\.(txt|csv|tsv|log|md|json|xml|ics|vcf|ya?ml|ini|conf)$/i;
const TEXT_MAX = 2 * 1024 * 1024;
const PER_WINDOW = 8; // previews kept per window (older ones are released)

// executables, scripts and disk images are never started from a mail (Windows, macOS, Linux)
export const DANGEROUS = /\.(exe|com|bat|cmd|msi|msp|scr|pif|vbs|vbe|js|jse|ws|wsf|wsh|ps1|psm1|hta|cpl|jar|lnk|reg|dll|application|appref-ms|iso|img|vhd|app|command|sh|desktop|appimage|run|deb|rpm)$/i;

export function viewKind(filename: string, contentType = ''): Kind {
  const ct = contentType.toLowerCase();
  if (ct === 'application/pdf' || /\.pdf$/i.test(filename)) return 'pdf';
  if ((ct.startsWith('image/') && ct !== 'image/tiff') || IMAGE.test(filename)) return 'image';
  if (ct.startsWith('text/plain') || ct === 'text/csv' || ct === 'application/json' || TEXT.test(filename)) return 'text';
  return 'none';
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif' };
const imageType = (f: ViewFile) => (f.contentType.startsWith('image/') ? f.contentType : MIME[path.extname(f.filename).slice(1).toLowerCase()] ?? 'image/png');
const safeName = (n: string) => n.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 200) || 'attachment';
const tmpDir = () => path.join(app.getPath('temp'), 'agenoras', 'preview');

const items = new Map<string, { file: ViewFile; owner: number; dir: string | null }>();

function release(token: string): void {
  const it = items.get(token);
  if (!it) return;
  items.delete(token);
  if (it.dir) fs.rm(it.dir, { recursive: true, force: true }, () => {});
}

export function cleanPreviewFiles(): void {
  fs.rm(tmpDir(), { recursive: true, force: true }, () => {});
}

// A PDF of the preview folder – the only thing a preview <webview> may load
export function isPreviewPdf(url: string): boolean {
  if (!/^file:\/\//i.test(url)) return false;
  try {
    const p = path.resolve(fileURLToPath(url.split('#')[0]));
    return p.startsWith(tmpDir() + path.sep) && /\.pdf$/i.test(p);
  } catch {
    return false;
  }
}

export const PREVIEW_PARTITION = 'agenoras-preview';
let previewSession: Electron.Session | null = null;
// Own in-memory session: files of the preview folder and the PDF viewer itself, nothing from the network
function guardPreviewSession(): void {
  if (previewSession) return;
  previewSession = session.fromPartition(PREVIEW_PARTITION);
  previewSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(/^(chrome-extension|chrome|devtools|data|blob):/i.test(d.url) || isPreviewPdf(d.url)) }));
  previewSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
}

// <webview> in a window: PDFs of the preview (all windows) or, in the main window, web pages for the browser column
export function guardWebviews(w: BrowserWindow, webPartition?: string): void {
  w.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete (prefs as { preload?: string }).preload;
    const src = params.src ?? '';
    const base = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true };
    if (isPreviewPdf(src)) {
      guardPreviewSession();
      Object.assign(prefs, base, { partition: PREVIEW_PARTITION, plugins: true });
      return;
    }
    Object.assign(prefs, base, { partition: webPartition ?? PREVIEW_PARTITION });
    if (!webPartition || !/^https?:/i.test(src)) e.preventDefault();
  });
}

export async function makePreview(file: ViewFile, owner: number) {
  // the oldest previews of this window go
  const mine = [...items].filter(([, it]) => it.owner === owner).map(([k]) => k);
  for (const k of mine.slice(0, Math.max(0, mine.length - PER_WINDOW + 1))) release(k);
  const token = crypto.randomUUID();
  const kind = viewKind(file.filename, file.contentType);
  let dir: string | null = null;
  let url: string | undefined;
  if (kind === 'pdf') {
    dir = path.join(tmpDir(), token);
    await fs.promises.mkdir(dir, { recursive: true });
    const f = path.join(dir, safeName(file.filename).replace(/(\.pdf)?$/i, '.pdf'));
    await fs.promises.writeFile(f, file.content);
    url = pathToFileURL(f).href;
  } else if (kind === 'image') url = `data:${imageType(file)};base64,${file.content.toString('base64')}`;
  items.set(token, { file, owner, dir });
  return {
    token,
    name: file.filename,
    size: file.content.length,
    kind,
    canOpen: !DANGEROUS.test(file.filename),
    url,
    ...(kind === 'text' ? { text: file.content.subarray(0, TEXT_MAX).toString('utf8'), cut: file.content.length > TEXT_MAX } : {}),
  };
}

const itemOf = (e: Electron.IpcMainInvokeEvent, token: string) => {
  const it = items.get(String(token));
  if (!it || it.owner !== e.sender.id) throw new Error(t('viewer.gone'));
  return it;
};

export function registerPreviewIpc(): void {
  ipcMain.handle('preview:save', async (e, token: string) => {
    const it = itemOf(e, token);
    const owner = BrowserWindow.fromWebContents(e.sender);
    const opts = { title: t('dlg.saveAttachment'), defaultPath: path.join(app.getPath('downloads'), safeName(it.file.filename)) };
    const res = owner ? await dialog.showSaveDialog(owner, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    await fs.promises.writeFile(res.filePath, it.file.content);
    return res.filePath;
  });
  ipcMain.handle('preview:open', async (e, token: string) => {
    const it = itemOf(e, token);
    if (DANGEROUS.test(it.file.filename)) throw new Error(t('err.dangerousFile'));
    const dir = path.join(tmpDir(), `${crypto.randomUUID()}-open`);
    await fs.promises.mkdir(dir, { recursive: true });
    const f = path.join(dir, safeName(it.file.filename));
    await fs.promises.writeFile(f, it.file.content);
    const err = await shell.openPath(f);
    if (err) throw new Error(err);
  });
  ipcMain.handle('preview:release', (e, token: string) => {
    const it = items.get(String(token));
    if (it && it.owner === e.sender.id) release(String(token));
  });
}
