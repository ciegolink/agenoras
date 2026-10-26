import './migrate'; // must run first: moves the old user data folder
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { AccountUpdate, addAccount, getAccount, getPassword, listAccounts, NewAccount, removeAccount, updateAccount } from './accounts';
import {
  closeAccount,
  closeAll,
  archiveFolder,
  junkFolder,
  deleteMessages,
  fetchFolder,
  FolderInfo,
  listFolders,
  moveMessages,
  friendlyError,
  getAttachmentFiles,
  getMessage,
  MailDetail,
  MailSummary,
  markSeen,
  getInviteIcs,
  fetchNewSince,
  searchFolder,
  setSeen,
  setFlagged,
  fetchFlagged,
  setOnNewMail,
  startAccount,
  testConnection,
} from './imap';
import { OutgoingMail, sendMail, testSmtp } from './smtp';
import { allowImages, getIdentity, getSettings, Identity, imagesAllowed, isTrustedSender, MailLabel, MailRule, NotifySettings, saveRules, SCALE_FACTOR, saveIdentities, saveLabels, saveNotify, savePrefs, saveTemplates, saveTheme, savedLanguage, setMailLabel, Template, Theme, trustSender, UiScale } from './settings';
import { listSounds, openSoundFolder, soundData } from './sounds';
import { flushWinState, loadWinState, trackWinState } from './winstate';
import { cachedTasks, deleteTask, listTasks, saveTask, TaskInput } from './tasks';
import { runRulesForNew, runRulesNow } from './rules';
import { parseInvite, sendInvitations, sendReply } from './invites';
import { getAvatars, hasRemoteImages, inlineRemoteImages, loadSignatureFile } from './remote';
import { addDavAccount, DavKind, getDavPassword, listDavAccounts, NewDavAccount, removeDavAccount, updateDavAccount } from './davaccounts';
import {
  cachedCalendarView,
  davError,
  deleteEvent,
  EventInput,
  SaveResult,
  eventIcs,
  searchEvents,
  importInvite,
  applyReply,
  deleteByUid,
  fetchEvents,
  forgetCalAccount,
  listCalendars,
  saveEvent,
  testCalDav,
} from './caldav';
import { cachedContacts, ContactInput, deleteContact, forgetCardAccount, listContacts, saveContact, testCardDav } from './carddav';
import { cachedByMessageIds, knownAddresses, rememberAddresses, cachedBody, cachedMail, closeCache, folderKey, forgetMailAccount, getKv, removeCachedMail, setCachedSeen, setKv, storeBody, storeMail } from './cache';
import { availableLanguages, i18nData, initI18n, t } from './i18n';

// Language: system language if lang/<code>.json exists – otherwise English.
// The locale also drives date fields and formats (e.g. de-CH).
// Linux/Wayland: GNOME draws no title bar for native Wayland windows of Electron
// (no moving/resizing). So start via XWayland – then the normal title bar is there.
// To use native Wayland anyway: set the environment variable AGENORAS_WAYLAND=1.
// The switch only takes effect on the command line (too late from here), so the packaged app
// restarts itself once with it; the .desktop entry and `npm start` already pass it.
if (process.platform === 'linux' && !process.env.AGENORAS_WAYLAND && !process.argv.some((a) => a.startsWith('--ozone-platform'))) {
  app.relaunch({ args: [...process.argv.slice(1), '--ozone-platform=x11'] });
  app.exit(0);
}

// Single instance: a second start brings the existing window to the front (important with the tray icon)
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
// Windows: without an app ID no notifications appear
if (process.platform === 'win32') app.setAppUserModelId('ch.ciegolink.agenoras');

const lang = initI18n(savedLanguage());
app.commandLine.appendSwitch('lang', lang.locale);

// Linux: hardware acceleration off. With some drivers Electron's GPU process crashes otherwise
// (exit_code=139) and the window stays empty. A mail app does not need it.
// To turn it back on for testing: AGENORAS_GPU=1 npm start
if (process.platform === 'linux' && process.env.AGENORAS_GPU !== '1') {
  app.disableHardwareAcceleration();
}

// Windows fetch the strings synchronously at startup (once, small)
ipcMain.on('i18n:get', (e) => {
  e.returnValue = { ...i18nData(), weekStart: getSettings().weekStart };
});

let win: BrowserWindow | null = null;

const webPreferences = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

// Custom title bar in the CiegoLink design instead of the system frame (macOS keeps the traffic lights)
// Light/dark: nativeTheme drives prefers-color-scheme in all windows (CSS switches live)
const bgColor = () => (nativeTheme.shouldUseDarkColors ? '#1F2126' : '#EBEBE3');

const frameOpts = process.platform === 'darwin' ? { titleBarStyle: 'hidden' as const } : { frame: false };

// Open links from mails in the default browser, never in the app window
// Font size = zoom of the whole window (Settings → Appearance)
const zoom = () => SCALE_FACTOR[getSettings().uiScale] ?? 1;

function lockDown(w: BrowserWindow): void {
  w.webContents.on('did-finish-load', () => w.webContents.setZoomFactor(zoom()));
  const sendState = () => w.webContents.send('win:state', w.isMaximized());
  w.on('maximize', sendState);
  w.on('unmaximize', sendState);
  w.setMenuBarVisibility(false);
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  // Development: F12 opens DevTools (disabled in the packaged app)
  if (!app.isPackaged) {
    w.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') w.webContents.toggleDevTools();
    });
  }
}

const BUILD_DIR = path.join(__dirname, '../../build');
// Custom logo (build/logo.png) takes precedence over the bundled icon
const APP_ICON = fs.existsSync(path.join(BUILD_DIR, 'logo.png')) ? path.join(BUILD_DIR, 'logo.png') : path.join(BUILD_DIR, 'icon.png');

function createWindow(): void {
  const st = loadWinState('main', { width: 1440, height: 900 });
  win = new BrowserWindow({
    width: st.width,
    height: st.height,
    ...(st.x !== undefined ? { x: st.x, y: st.y } : {}),
    show: false,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: bgColor(),
    title: 'Agenoras',
    icon: APP_ICON,
    ...frameOpts,
    // keeps running unthrottled when hidden/minimized (sound, refresh on new mail)
    webPreferences: { ...webPreferences, backgroundThrottling: false },
  });
  lockDown(win);
  trackWinState(win, 'main', true);
  win.loadFile(path.join(__dirname, '../../src/renderer/index.html'));
  win.once('ready-to-show', () => {
    if (st.maximized) win?.maximize();
    win?.show();
  });
  win.on('focus', () => setTrayUnread(false));
  // X: keep running in the background (tray icon), except when quitting
  win.on('close', (e) => {
    if (quitting || !tray || !getSettings().notify.background) return;
    e.preventDefault();
    win?.hide();
    if (!getKv<boolean>('hint:background')) {
      setKv('hint:background', true);
      showNotification(t('notify.backgroundTitle'), t('notify.backgroundBody'));
    }
  });
  win.on('closed', () => (win = null));
}

function showWindow(): void {
  if (!win) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  setTrayUnread(false);
}

app.on('second-instance', showWindow);

// ---------- Tray ----------

let tray: Tray | null = null;
let quitting = false;

function trayIcon(unread: boolean): Electron.NativeImage {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : unread ? 'tray-unread.png' : 'tray.png';
  const img = nativeImage.createFromPath(path.join(BUILD_DIR, file)); // @2x is loaded automatically
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

function setTrayUnread(unread: boolean): void {
  tray?.setImage(trayIcon(unread));
  tray?.setToolTip(unread ? t('tray.tooltipNew') : 'Agenoras');
}

function createTray(): void {
  try {
    tray = new Tray(trayIcon(false));
  } catch (err) {
    console.error('Tray:', err); // e.g. desktop without a tray → X quits the app as before
    tray = null;
    return;
  }
  tray.setToolTip('Agenoras');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('tray.open'), click: showWindow },
      {
        label: t('tray.newMail'),
        click: () => {
          showWindow();
          openComposeWindow({});
        },
      },
      { type: 'separator' },
      {
        label: t('tray.quit'),
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showWindow); // Windows/macOS; Ubuntu only shows the menu
}

// ---------- Desktop notifications ----------

const liveNotifications = new Set<Notification>(); // keep a reference, otherwise the click gets lost

function showNotification(title: string, body: string, icon?: Electron.NativeImage, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: icon && !icon.isEmpty() ? icon : nativeImage.createFromPath(APP_ICON), silent: true }); // the sound comes from the app
  liveNotifications.add(n);
  n.on('click', () => {
    liveNotifications.delete(n);
    onClick?.();
  });
  n.on('close', () => liveNotifications.delete(n));
  n.show();
}

async function notifyNewMail(accountId: string): Promise<void> {
  const acc = getAccount(accountId);
  if (!acc) return;
  let fresh: MailSummary[];
  try {
    fresh = await fetchNewSince(acc); // always query so only really new mail is reported
  } catch {
    return;
  }
  if (!fresh.length) return;
  const focused = !!win && win.isVisible() && win.isFocused();
  if (!focused) setTrayUnread(true);
  const n = getSettings().notify;
  if (focused || !n.desktop || n.desktopOff.includes(accountId)) return;

  const open = (m: MailSummary) => () => {
    showWindow();
    win?.webContents.send('mail:open', { accountId, folder: 'INBOX', uid: m.uid });
  };
  if (fresh.length > 3) {
    const lines = fresh.slice(-3).reverse().map((m) => `${m.from || m.fromAddress}: ${m.subject || t('mail.noSubject')}`);
    showNotification(t('notify.many', { n: fresh.length, email: acc.email }), lines.join('\n'), undefined, showWindow);
    return;
  }
  const icons = await getAvatars(fresh.map((m) => m.fromAddress)).catch(() => ({}) as Record<string, string | null>);
  for (const m of fresh) {
    const data = icons[m.fromAddress.toLowerCase()];
    const icon = data && /^data:image\/(png|jpe?g);/i.test(data) ? nativeImage.createFromDataURL(data) : undefined;
    const prio = m.priority === 'high' ? '❗ ' : '';
    showNotification(`${prio}${m.from || m.fromAddress}`, `${m.subject || t('mail.noSubject')}\n${acc.email}`, icon, open(m));
  }
}

// ---------- Compose window (one window per mail, like Outlook) ----------

const composeOpts = new Map<number, unknown>();

function openComposeWindow(opts: unknown): void {
  const parentBounds = win?.getBounds();
  const st = loadWinState('compose', { width: 900, height: 800 });
  const cw = new BrowserWindow({
    width: st.width,
    height: st.height,
    icon: APP_ICON,
    minWidth: 640,
    minHeight: 520,
    // slightly offset from the main window so both are visible
    ...(parentBounds ? { x: parentBounds.x + 120 + composeOpts.size * 28, y: parentBounds.y + 50 + composeOpts.size * 28 } : {}),
    backgroundColor: bgColor(),
    title: 'Agenoras',
    show: false,
    ...frameOpts,
    webPreferences,
  });
  const id = cw.webContents.id;
  composeOpts.set(id, opts ?? {});
  lockDown(cw);
  trackWinState(cw, 'compose', false);
  cw.loadFile(path.join(__dirname, '../../src/renderer/compose.html'));
  cw.once('ready-to-show', () => {
    if (st.maximized) cw.maximize();
    cw.show();
  });

  // Do not lose an unsent draft silently
  cw.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(cw, {
      type: 'question',
      buttons: [t('draft.discard'), t('draft.keepEditing')],
      defaultId: 1,
      cancelId: 1,
      title: t('draft.title'),
      message: t('draft.message'),
      detail: t('draft.detail'),
    });
    if (choice === 0) e.preventDefault(); // preventDefault = allow closing
  });
  cw.on('closed', () => composeOpts.delete(id));
}

// ---------- Mail in its own window (double-click in the list) ----------

const viewerOpts = new Map<number, unknown>();

function openMailWindow(ref: { accountId: string; folder: string; uid: number }): void {
  const b = win?.getBounds();
  const st = loadWinState('mailview', { width: 1000, height: 820 });
  const vw = new BrowserWindow({
    width: st.width,
    height: st.height,
    icon: APP_ICON,
    minWidth: 640,
    minHeight: 480,
    ...(b ? { x: b.x + 160 + viewerOpts.size * 28, y: b.y + 60 + viewerOpts.size * 28 } : {}),
    backgroundColor: bgColor(),
    title: 'Agenoras',
    show: false,
    ...frameOpts,
    webPreferences,
  });
  const id = vw.webContents.id;
  viewerOpts.set(id, ref);
  lockDown(vw);
  trackWinState(vw, 'mailview', false);
  vw.loadFile(path.join(__dirname, '../../src/renderer/mailview.html'));
  vw.once('ready-to-show', () => {
    if (st.maximized) vw.maximize();
    vw.show();
  });
  vw.on('closed', () => viewerOpts.delete(id));
}

ipcMain.handle('mailview:open', (_e, ref: { accountId: string; folder: string; uid: number }) => openMailWindow(ref));
ipcMain.handle('mailview:init', (e) => viewerOpts.get(e.sender.id) ?? null);

// Buttons of the custom title bar (apply to the window the click comes from)
const senderWindow = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender);
ipcMain.handle('win:minimize', (e) => senderWindow(e)?.minimize());
ipcMain.handle('win:toggleMaximize', (e) => {
  const w = senderWindow(e);
  if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
});
ipcMain.handle('win:close', (e) => senderWindow(e)?.close()); // close() → the draft prompt still applies
ipcMain.handle('win:isMaximized', (e) => senderWindow(e)?.isMaximized() ?? false);

ipcMain.handle('compose:open', (_e, opts: unknown) => openComposeWindow(opts));
ipcMain.handle('compose:init', (e) => composeOpts.get(e.sender.id) ?? {});
// Sent: play the sound in the main window (the compose window closes right away)
ipcMain.handle('compose:sent', () => win?.webContents.send('mail:sent'));
ipcMain.handle('compose:done', (e, status: string) => {
  win?.webContents.send('mail:status', status);
  BrowserWindow.fromWebContents(e.sender)?.destroy(); // sent → close without asking
});

// ---------- Mail accounts ----------

ipcMain.handle('accounts:list', () => listAccounts());

ipcMain.handle('accounts:add', async (_e, input: NewAccount) => {
  if (!input?.email || !input.host || !input.user || !input.pass) throw new Error(t('err.fillAll'));
  try {
    await testConnection(input, input.pass);
  } catch (err) {
    throw new Error('IMAP: ' + friendlyError(err));
  }
  try {
    await testSmtp(input, input.pass);
  } catch (err) {
    throw new Error('SMTP: ' + friendlyError(err));
  }
  const acc = addAccount(input);
  startAccount(acc).catch((err) => console.error(friendlyError(err)));
  return acc;
});

ipcMain.handle('accounts:update', async (_e, id: string, input: AccountUpdate) => {
  if (!getAccount(id)) throw new Error(t('err.accountNotFound'));
  if (!input?.email || !input.host || !input.user) throw new Error(t('err.fillAll'));
  const pass = input.pass || getPassword(id);
  try {
    await testConnection(input, pass);
  } catch (err) {
    throw new Error('IMAP: ' + friendlyError(err));
  }
  try {
    await testSmtp(input, pass);
  } catch (err) {
    throw new Error('SMTP: ' + friendlyError(err));
  }
  const acc = updateAccount(id, input);
  await closeAccount(id); // reconnect with the new settings
  startAccount(acc).catch((err) => console.error(friendlyError(err)));
  return acc;
});

ipcMain.handle('accounts:remove', async (_e, id: string) => {
  await closeAccount(id);
  removeAccount(id);
  forgetMailAccount(id);
});

// ---------- Mail ----------

const accountsFor = (accountId: string | null) => listAccounts().filter((a) => !accountId || a.id === accountId);

// Folder tree of an account (with unread counts); offline from the cache
ipcMain.handle('mail:folders', async (_e, accountId: string) => {
  const acc = getAccount(accountId);
  if (!acc) throw new Error(t('err.accountNotFound'));
  try {
    const folders = await listFolders(acc);
    setKv(`folders:${accountId}`, folders);
    return folders;
  } catch (err) {
    const cached = getKv<FolderInfo[]>(`folders:${accountId}`);
    if (cached) return cached;
    throw new Error(friendlyError(err));
  }
});

ipcMain.handle('mail:folders:cached', (_e, accountId: string) => getKv<FolderInfo[]>(`folders:${accountId}`) ?? []);

// Straight from the cache – the renderer then fetches fresh data from the server.
// No account = all inboxes; with account = selected folder of that account.
ipcMain.handle('mail:cached', (_e, accountId: string | null, folder = 'INBOX') =>
  cachedMail<MailSummary>(accountsFor(accountId).map((a) => folderKey(a.id, folder))).map((m) => ({ ...m, folder: m.folder ?? folder })),
);

ipcMain.handle('mail:list', async (_e, accountId: string | null, folder = 'INBOX') => {
  const accs = accountsFor(accountId);
  const results = await Promise.allSettled(accs.map((a) => fetchFolder(a, folder)));
  const mails: MailSummary[] = [];
  const errors: { accountId: string; message: string }[] = [];
  results.forEach((r, i) => {
    const key = folderKey(accs[i].id, folder);
    if (r.status === 'fulfilled') {
      storeMail(key, r.value);
      mails.push(...r.value);
    } else {
      errors.push({ accountId: accs[i].id, message: friendlyError(r.reason) });
      mails.push(...cachedMail<MailSummary>([key]).map((m) => ({ ...m, folder: m.folder ?? folder }))); // offline: last state
    }
  });
  mails.sort((a, b) => b.date.localeCompare(a.date));
  return { mails, errors };
});

// External images: blocked unless requested (loadImages) or from trusted senders.
// They are loaded here in the main process; the mail gets the images as data: URLs.
// "Load images" is remembered per mail (Message-ID, otherwise account|folder|UID).
// The finished embedded HTML stays in memory for the last 30 mails → reopening is instant.
const inlinedHtml = new Map<string, string>();

async function withImages(detail: MailDetail, loadImages: boolean) {
  const remoteImages = hasRemoteImages(detail.html);
  const key = detail.messageId || `${detail.accountId}|${detail.folder}|${detail.uid}`;
  if (remoteImages && loadImages) allowImages(key);
  const load = remoteImages && (loadImages || imagesAllowed(key) || isTrustedSender(detail.fromAddress));
  let html = detail.html;
  if (load && html) {
    html = inlinedHtml.get(key) ?? (await inlineRemoteImages(html));
    inlinedHtml.delete(key);
    inlinedHtml.set(key, html);
    if (inlinedHtml.size > 30) inlinedHtml.delete(inlinedHtml.keys().next().value!);
  }
  return { ...detail, html, remoteImages, imagesLoaded: load };
}

ipcMain.handle('mail:get', async (_e, accountId: string, folder: string, uid: number, loadImages = false) => {
  const acc = getAccount(accountId);
  if (!acc) throw new Error(t('err.accountNotFound'));
  const key = folderKey(accountId, folder);

  const cached = cachedBody<MailDetail>(key, uid);
  if (cached) {
    setCachedSeen(key, uid);
    markSeen(acc, folder, uid).catch(() => {}); // in the background, no error when offline
    return withImages({ ...cached, priority: cached.priority ?? 'normal', folder }, !!loadImages);
  }
  let detail: MailDetail;
  try {
    detail = await getMessage(acc, folder, uid);
  } catch (err) {
    throw new Error(friendlyError(err));
  }
  storeBody(key, uid, detail);
  setCachedSeen(key, uid);
  return withImages(detail, !!loadImages);
});

// Read / unread (context menu)
// Set/remove star (\Flagged)
ipcMain.handle('mail:flag', async (_e, accountId: string, folder: string, uids: number[], flagged: boolean) => {
  const acc = getAccount(accountId);
  if (!acc) throw new Error(t('err.accountNotFound'));
  try {
    await setFlagged(acc, folder, cleanUids(uids), !!flagged);
  } catch (err) {
    throw new Error(friendlyError(err));
  }
});

// All starred mails (all accounts); offline: last state
ipcMain.handle('mail:flagged', async () => {
  const errors: { accountId: string; message: string }[] = [];
  const lists = await Promise.all(
    listAccounts().map(async (acc) => {
      try {
        const list = await fetchFlagged(acc);
        setKv(`flagged:${acc.id}`, list);
        return list;
      } catch (err) {
        errors.push({ accountId: acc.id, message: friendlyError(err) });
        return getKv<MailSummary[]>(`flagged:${acc.id}`) ?? [];
      }
    }),
  );
  return { mails: lists.flat().sort((a, b) => b.date.localeCompare(a.date)), errors };
});
ipcMain.handle('mail:flagged:cached', () => listAccounts().flatMap((a) => getKv<MailSummary[]>(`flagged:${a.id}`) ?? []).sort((a, b) => b.date.localeCompare(a.date)));

// Mails per category (from the cache, across all folders)
ipcMain.handle('mail:byMessageIds', (_e, ids: string[]) =>
  cachedByMessageIds<MailSummary>(Array.isArray(ids) ? ids.map(String) : []).sort((a, b) => b.date.localeCompare(a.date)),
);

// Known addresses (senders and recipients) for suggestions when composing
ipcMain.handle('addresses:list', () => knownAddresses());

ipcMain.handle('mail:seen', async (_e, accountId: string, folder: string, uids: number[], seen: boolean) => {
  const acc = getAccount(accountId);
  if (!acc) throw new Error(t('err.accountNotFound'));
  const list = cleanUids(uids);
  try {
    await setSeen(acc, folder, list, !!seen);
  } catch (err) {
    throw new Error(friendlyError(err));
  }
  for (const uid of list) setCachedSeen(folderKey(accountId, folder), uid, !!seen);
});

// Full-text search on the server: one folder or all folders (without Gmail's "All Mail")
ipcMain.handle('mail:search', async (_e, accountId: string | null, folder: string | null, query: string) => {
  const q = String(query ?? '').trim();
  if (q.length < 2) return { mails: [], errors: [] };
  const accs = accountsFor(accountId);
  const errors: { accountId: string; message: string }[] = [];
  const perAccount = await Promise.all(
    accs.map(async (acc) => {
      const out: MailSummary[] = [];
      try {
        const folders = folder ? [folder] : (await listFolders(acc)).filter((f) => f.selectable && f.specialUse !== '\\All').map((f) => f.path);
        for (const f of folders) {
          try {
            out.push(...(await searchFolder(acc, f, q, folder ? 100 : 30)));
          } catch {
            /* single folder not searchable */
          }
        }
      } catch (err) {
        errors.push({ accountId: acc.id, message: friendlyError(err) });
      }
      return out;
    }),
  );
  const mails = perAccount.flat().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 300);
  return { mails, errors };
});

// Move or delete several mails of a folder (UIDs as a list)
const cleanUids = (uids: unknown) => (Array.isArray(uids) ? uids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);

ipcMain.handle('mail:move', async (_e, accountId: string, folder: string, uids: number[], target: string) => {
  const acc = getAccount(accountId);
  if (!acc) throw new Error(t('err.accountNotFound'));
  const list = cleanUids(uids);
  try {
    if (target === '\\Archive') {
      const archive = await archiveFolder(acc);
      if (!archive) throw new Error(t('err.noArchive'));
      target = archive;
    } else if (target === '\\Junk') {
      const junk = await junkFolder(acc);
      if (!junk) throw new Error(t('err.noJunk'));
      target = junk;
    }
    await moveMessages(acc, folder, list, target);
    for (const uid of list) removeCachedMail(folderKey(accountId, folder), uid);
  } catch (err) {
    throw new Error(friendlyError(err));
  }
});

ipcMain.handle('mail:delete', async (_e, accountId: string, folder: string, uids: number[]) => {
  const acc = getAccount(accountId);
  if (!acc) throw new Error(t('err.accountNotFound'));
  const list = cleanUids(uids);
  try {
    const result = await deleteMessages(acc, folder, list);
    for (const uid of list) removeCachedMail(folderKey(accountId, folder), uid);
    return result;
  } catch (err) {
    throw new Error(friendlyError(err));
  }
});

// ---------- Attachments ----------

// Only files the user picked or dropped in may be sent
const approvedFiles = new Set<string>();

async function fileInfo(p: string) {
  const stat = await fs.promises.stat(p);
  if (!stat.isFile()) throw new Error(t('err.notAFile', { name: path.basename(p) }));
  approvedFiles.add(p);
  return { path: p, name: path.basename(p), size: stat.size };
}

ipcMain.handle('files:pick', async () => {
  const res = await dialog.showOpenDialog(win!, { title: t('dlg.pickAttachments'), properties: ['openFile', 'multiSelections'] });
  if (res.canceled) return [];
  return Promise.all(res.filePaths.map(fileInfo));
});

ipcMain.handle('files:dropped', (_e, p: string) => fileInfo(p));

const DANGEROUS = /\.(exe|com|bat|cmd|msi|msp|scr|pif|vbs|vbe|js|jse|wsf|wsh|ps1|psm1|hta|cpl|jar|lnk|reg|dll|application|appref-ms|iso|img|vhd)$/i;

async function attachment(accountId: string, folder: string, uid: number, index: number) {
  const acc = getAccount(accountId);
  if (!acc) throw new Error(t('err.accountNotFound'));
  try {
    const f = (await getAttachmentFiles(acc, folder, uid))[index];
    if (!f) throw new Error(t('err.attachmentNotFound'));
    return f;
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

const safeName = (n: string) => n.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 200) || t('file.attachment');

ipcMain.handle('mail:attachment:save', async (_e, accountId: string, folder: string, uid: number, index: number) => {
  const f = await attachment(accountId, folder, uid, index);
  const res = await dialog.showSaveDialog(win!, { title: t('dlg.saveAttachment'), defaultPath: path.join(app.getPath('downloads'), safeName(f.filename)) });
  if (res.canceled || !res.filePath) return null;
  await fs.promises.writeFile(res.filePath, f.content);
  return res.filePath;
});

ipcMain.handle('mail:attachment:open', async (_e, accountId: string, folder: string, uid: number, index: number) => {
  const f = await attachment(accountId, folder, uid, index);
  if (DANGEROUS.test(f.filename)) throw new Error(t('err.dangerousFile'));
  const dir = path.join(app.getPath('temp'), 'agenoras', crypto.randomUUID());
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, safeName(f.filename));
  await fs.promises.writeFile(file, f.content);
  const err = await shell.openPath(file);
  if (err) throw new Error(err);
});

ipcMain.handle('mail:send', async (e, mail: OutgoingMail) => {
  const identity = getIdentity(mail?.identityId);
  const acc = identity && getAccount(identity.accountId);
  if (!identity || !acc) throw new Error(t('err.senderNotFound'));
  const notApproved = (mail.files ?? []).find((f) => !approvedFiles.has(f));
  if (notApproved) throw new Error(t('err.fileNotApproved', { name: path.basename(notApproved) }));
  try {
    const res = await sendMail(identity, acc, mail, (done, total) => e.sender.send('mail:progress', done, total));
    // Remember recipients for next time
    const parse = (l: string[] = []) => l.map((x) => /^"?([^"<]*)"?\s*<([^>]+)>$/.exec(x.trim())).map((m, i) => (m ? { name: m[1].trim(), address: m[2] } : { name: '', address: l[i].trim() }));
    try {
      rememberAddresses([...parse(mail.to), ...parse(mail.cc), ...parse(mail.bcc), ...parse((mail.individual ?? []).map((x) => x.to))]);
    } catch {
      /* not critical */
    }
    return res;
  } catch (err) {
    throw new Error(friendlyError(err));
  }
});

// ---------- Settings: senders/aliases, signatures, templates ----------

ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:identities', async (_e, list: Identity[]) => {
  // embed external images in HTML signatures – recipients see them without loading anything
  for (const i of list ?? []) {
    if (i.signatureHtml && hasRemoteImages(i.signatureHtml)) i.signatureHtml = await inlineRemoteImages(i.signatureHtml);
  }
  return saveIdentities(list);
});
ipcMain.handle('settings:signatureFile', async (e) => {
  const w = BrowserWindow.fromWebContents(e.sender) ?? win!;
  const res = await dialog.showOpenDialog(w, { title: t('dlg.pickSignature'), properties: ['openFile'], filters: [{ name: 'HTML', extensions: ['html', 'htm'] }] });
  if (res.canceled || !res.filePaths[0]) return null;
  return loadSignatureFile(res.filePaths[0]);
});
ipcMain.handle('settings:trustSender', (_e, email: string) => trustSender(email));
ipcMain.handle('settings:notify', (_e, n: NotifySettings) => saveNotify(n));
ipcMain.handle('settings:prefs', (_e, p: { uiScale?: UiScale; language?: string; weekStart?: number; sendDelay?: number; externalMark?: boolean; internalDomains?: string[]; accountLabel?: 'name' | 'email' }) => {
  const before = getSettings().language;
  savePrefs(p ?? {});
  if (p?.uiScale) for (const w of BrowserWindow.getAllWindows()) w.webContents.setZoomFactor(zoom());
  return { restartNeeded: p?.language !== undefined && p.language !== before };
});
ipcMain.handle('settings:languages', () => availableLanguages());
// About page: version and runtime
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: `${process.platform} ${process.arch}`,
}));
ipcMain.handle('app:relaunch', () => {
  quitting = true;
  app.relaunch();
  app.quit();
});
ipcMain.handle('labels:save', (_e, list: MailLabel[]) => saveLabels(list));
ipcMain.handle('labels:set', (_e, keys: string[], labelId: string, on: boolean) => setMailLabel(keys, labelId, !!on));

// Sounds for new mail
ipcMain.handle('sounds:list', () => listSounds());
ipcMain.handle('sounds:data', (_e, id: string) => soundData(id));
ipcMain.handle('sounds:openFolder', () => openSoundFolder());

// Sender icons (contact photo or website favicon)
ipcMain.handle('avatars:get', (_e, emails: string[]) => getAvatars(Array.isArray(emails) ? emails : []));
ipcMain.handle('settings:templates', (_e, list: Template[]) => saveTemplates(list));
ipcMain.handle('settings:theme', (_e, theme: Theme) => {
  nativeTheme.themeSource = saveTheme(theme);
  for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(bgColor());
  return nativeTheme.themeSource;
});
nativeTheme.on('updated', () => {
  for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(bgColor());
});

// ---------- DAV accounts (calendar + contacts) ----------

async function addDav(kind: DavKind, input: NewDavAccount) {
  if (!input?.serverUrl || !input.username || !input.password) throw new Error(t('err.fillAll'));
  try {
    new URL(input.serverUrl);
  } catch {
    throw new Error(t('err.invalidUrl'));
  }
  try {
    if (kind === 'caldav') await testCalDav(input.serverUrl, input.username, input.password);
    else await testCardDav(input.serverUrl, input.username, input.password);
  } catch (err) {
    throw new Error(davError(err));
  }
  return addDavAccount(kind, input);
}

async function updateDav(kind: DavKind, id: string, input: NewDavAccount) {
  if (!input?.serverUrl || !input.username) throw new Error(t('err.fillAll'));
  try {
    new URL(input.serverUrl);
  } catch {
    throw new Error(t('err.invalidUrl'));
  }
  const password = input.password || getDavPassword(kind, id);
  try {
    if (kind === 'caldav') await testCalDav(input.serverUrl, input.username, password);
    else await testCardDav(input.serverUrl, input.username, password);
  } catch (err) {
    throw new Error(davError(err));
  }
  const acc = updateDavAccount(kind, id, input);
  if (kind === 'caldav') forgetCalAccount(id);
  else forgetCardAccount(id);
  return acc;
}

ipcMain.handle('cal:accounts:update', (_e, id: string, input: NewDavAccount) => updateDav('caldav', id, input));
ipcMain.handle('contacts:accounts:update', (_e, id: string, input: NewDavAccount) => updateDav('carddav', id, input));

// ---------- Calendar (CalDAV) ----------

ipcMain.handle('cal:accounts:list', () => listDavAccounts('caldav'));
ipcMain.handle('cal:accounts:add', (_e, input: NewDavAccount) => addDav('caldav', input));
ipcMain.handle('cal:accounts:remove', (_e, id: string) => {
  forgetCalAccount(id);
  removeDavAccount('caldav', id);
});

ipcMain.handle('cal:cached', (_e, calendarIds: string[], start: string) => cachedCalendarView(calendarIds, start));
ipcMain.handle('cal:calendars', () => listCalendars());
ipcMain.handle('cal:events', (_e, calendarIds: string[], start: string, end: string) => fetchEvents(calendarIds, start, end));

// Save; with invite.identityId the attendees are invited by mail (or informed about changes)
ipcMain.handle('cal:save', async (_e, input: EventInput, invite?: { identityId: string }) => {
  let res: SaveResult;
  try {
    res = await saveEvent(input);
  } catch (err) {
    throw new Error(davError(err));
  }
  if (invite?.identityId && input.attendees?.length) {
    try {
      return { invited: await sendInvitations(invite.identityId, res.ics) };
    } catch (err) {
      throw new Error(t('invite.sendFailed', { msg: friendlyError(err) }));
    }
  }
  return { invited: 0 };
});

// Event as .ics (to forward by mail)
ipcMain.handle('cal:ics', (_e, url: string) => eventIcs(url));
ipcMain.handle('cal:search', (_e, query: string, calendarIds: string[]) => searchEvents(String(query ?? ''), Array.isArray(calendarIds) ? calendarIds : []));

// Answer an invitation in a mail: reply to the organizer + (on accept/maybe) into the calendar
ipcMain.handle('invite:respond', async (_e, accountId: string, folder: string, uid: number, partstat: 'ACCEPTED' | 'TENTATIVE' | 'DECLINED', calendarId: string | null) => {
  const acc = getAccount(accountId);
  if (!acc) throw new Error(t('err.accountNotFound'));
  const ics = await getInviteIcs(acc, folder, uid);
  if (!ics) throw new Error(t('invite.notFound'));
  let me: string;
  try {
    me = (await sendReply(accountId, ics, partstat)).me;
  } catch (err) {
    throw new Error(t('invite.sendFailed', { msg: friendlyError(err) }));
  }
  if (partstat !== 'DECLINED' && calendarId) {
    try {
      await importInvite(calendarId, ics, me, partstat);
    } catch (err) {
      throw new Error(davError(err));
    }
  } else if (partstat === 'DECLINED') {
    const info = parseInvite(ics);
    if (info?.uid) await deleteByUid(info.uid).catch(() => false); // accepted earlier → remove from the calendar
  }
  return true;
});

// Apply someone else's reply/cancellation to the own calendar
ipcMain.handle('invite:apply', async (_e, accountId: string, folder: string, uid: number) => {
  const acc = getAccount(accountId);
  if (!acc) throw new Error(t('err.accountNotFound'));
  const ics = await getInviteIcs(acc, folder, uid);
  const info = ics && parseInvite(ics);
  if (!info) throw new Error(t('invite.notFound'));
  try {
    if (info.method === 'CANCEL') return await deleteByUid(info.uid);
    if (info.method === 'REPLY' && info.attendees[0]) return await applyReply(info.uid, info.attendees[0].email, info.attendees[0].partstat ?? 'NEEDS-ACTION');
  } catch (err) {
    throw new Error(davError(err));
  }
  return false;
});

ipcMain.handle('cal:delete', async (_e, url: string, occurrence?: string, cancel?: { identityId: string }) => {
  // Whole event with attendees deleted → cancellation to everyone (only if wanted)
  const ics = cancel?.identityId && !occurrence ? eventIcs(url) : null;
  if (ics && cancel) await sendInvitations(cancel.identityId, ics, true).catch((err) => console.error('Cancellation:', friendlyError(err)));
  try {
    await deleteEvent(url, occurrence || undefined);
  } catch (err) {
    throw new Error(davError(err));
  }
});

// ---------- Tasks (CalDAV VTODO) ----------

ipcMain.handle('tasks:cached', () => cachedTasks());
ipcMain.handle('tasks:list', () => listTasks());
ipcMain.handle('tasks:save', async (_e, input: TaskInput) => {
  try {
    await saveTask(input);
  } catch (err) {
    throw new Error(davError(err));
  }
});
ipcMain.handle('tasks:delete', async (_e, id: string) => {
  try {
    await deleteTask(id);
  } catch (err) {
    throw new Error(davError(err));
  }
});

// ---------- Contacts (CardDAV) ----------

ipcMain.handle('contacts:accounts:list', () => listDavAccounts('carddav'));
ipcMain.handle('contacts:accounts:add', (_e, input: NewDavAccount) => addDav('carddav', input));
ipcMain.handle('contacts:accounts:remove', (_e, id: string) => {
  forgetCardAccount(id);
  removeDavAccount('carddav', id);
});

ipcMain.handle('contacts:cached', () => cachedContacts());

ipcMain.handle('contacts:list', async () => {
  const res = await listContacts();
  return { ...res, errors: res.errors.map((e) => ({ ...e, message: davError(new Error(e.message)) })) };
});

ipcMain.handle('contacts:save', async (_e, input: ContactInput) => {
  try {
    await saveContact(input);
  } catch (err) {
    throw new Error(davError(err));
  }
});

ipcMain.handle('contacts:delete', async (_e, url: string) => {
  try {
    await deleteContact(url);
  } catch (err) {
    throw new Error(davError(err));
  }
});

// ---------- Startup / shutdown ----------

// New mail: rules first (move, mark read …), then notify – moved mail is not reported
async function rulesFor(accountId: string): Promise<void> {
  const acc = getAccount(accountId);
  if (!acc || !getSettings().rules.some((r) => r.enabled)) return;
  try {
    const r = await runRulesForNew(acc);
    if (r.matched) win?.webContents.send('mail:new', accountId, false); // refresh list/counts
  } catch (err) {
    console.error('Rules:', friendlyError(err));
  }
}

setOnNewMail(async (accountId, grew) => {
  win?.webContents.send('mail:new', accountId, grew);
  if (!grew) return;
  await rulesFor(accountId);
  notifyNewMail(accountId);
});

ipcMain.handle('rules:save', (_e, list: MailRule[]) => saveRules(list));
ipcMain.handle('rules:run', async (_e, accountId: string | null) => {
  try {
    return await runRulesNow(accountId || null);
  } catch (err) {
    throw new Error(friendlyError(err));
  }
});

app.whenReady().then(() => {
  nativeTheme.themeSource = getSettings().theme;
  createWindow();
  createTray();
  for (const acc of listAccounts()) {
    startAccount(acc)
      .then(() => rulesFor(acc.id)) // Mails that arrived while the app was closed
      .catch((err) => console.error(`[${acc.email}]`, friendlyError(err)));
  }
});

// In background mode the (hidden) main window stays → only a real quit lands here
app.on('window-all-closed', () => app.quit());

let closing = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (closing) return;
  e.preventDefault();
  closing = true;
  flushWinState();
  closeAll().finally(() => {
    closeCache();
    app.quit();
  });
});
