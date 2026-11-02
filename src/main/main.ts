import './migrate'; // must run first: moves the old user data folder
import './netretry';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, session, shell, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clearLog, flushLog, getLog, log, logState, markLogSeen, resolved, setOnLogChange } from './log';
import {
  AccountUpdate,
  addAccount,
  getAccount,
  getPassword,
  listAccounts,
  listAllAccounts,
  lockAccounts,
  NewAccount,
  privacyState,
  removeAccount,
  setAccountColor,
  setPrivacy,
  unlockedPrivate,
  unlockWithPin,
  updateAccount,
  setSecret,
} from './accounts';
import {
  closeAccount,
  closeAll,
  archiveFolder,
  junkFolder,
  trashFolder,
  emptyFolder,
  moveAllMessages,
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
  searchFolders,
  setSeen,
  setFlagged,
  fetchFlagged,
  findByMessageIds,
  fetchOlder,
  setOnNewMail,
  startAccount,
  testConnection,
  markFolderSeen,
  markAnswered,
  reconnectAll,
} from './imap';
import { OutgoingMail, sendMail, testSmtp } from './smtp';
import { addOutbox, outboxBusy, outboxItem, outboxList, removeOutbox, updateOutbox } from './outbox';
import { offlineComplete, offlineProgress, onOfflineCleared, onOfflineProgress, restartOffline } from './offline';
import { applyImport, buildExport, readExport, summarize } from './transfer';
import { parseDateQuery } from './datequery';
import { checkForUpdates, getUpdate, installUpdate, startUpdates, updateState } from './updater';
import { mailtoArg, parseMailto } from './mailto';
import { closeStore as closePopStore, forgetAccount as forgetPopAccount, vacuumStore as vacuumPop } from './pop3';
import { closeLocal, forgetLocal, isLocalDav, renameLocal } from './localdav';
import { aiState, cancelAiDownload, deleteAiModel, downloadAiModel, proofread, setAiEnabled, setAiLang, setAiModel, setAiTranslateLang, stopWorker as stopAi, suggestSubjects, writeText, translate } from './ai';
import { allowImages, getIdentity, getSettings, Identity, imagesAllowed, isTrustedSender, MailLabel, MailRule, NotifySettings, saveRules, SCALE_FACTOR, saveIdentities, saveLabels, saveNotify, savePrefs, saveTemplates, saveTheme, savedLanguage, setMailLabel, Template, Theme, trustSender, UiScale } from './settings';
import { listSounds, openSoundFolder, soundData } from './sounds';
import { flushWinState, loadWinState, trackWinState } from './winstate';
import { addPin, listPins, PinItem, removePin, togglePin, updatePins } from './pins';
import { cachedTasks, deleteTask, listTasks, saveTask, TaskInput } from './tasks';
import { getLists, MailList, removeList, saveList } from './lists';
import { cancelSignIn, forgetToken, isOAuthProvider, oauthProviders, rememberToken, serverFor, signIn } from './oauth';
import { addFeed, article as rssArticle, cachedItems as cachedRss, listFeeds, NewRssFeed, refreshFeeds, removeFeed, searchItems as searchRss, setArchived as setRssArchived, setFlagged as setRssFlagged, setRead as setRssRead, updateFeed } from './rss';
import { runRulesForNew, runRulesNow } from './rules';
import { parseInvite, sendInvitations, sendReply } from './invites';
import { getAvatars, hasRemoteImages, inlineRemoteImages, loadSignatureFile } from './remote';
import { addDavAccount, addLocalDavAccount, DavKind, getDavAccount, getDavPassword, listDavAccounts, NewDavAccount, removeDavAccount, renameDavAccount, updateDavAccount } from './davaccounts';
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
import { cachedByMessageIds, cachedReplies, hasOffline, offlineBody, offlineOlder, tidyCache, vacuumCache, knownAddresses, rememberAddresses, cachedBody, cachedMail, closeCache, folderKey, forgetFolder, forgetMailAccount, getKv, removeCachedMail, searchCachedMail, setCachedSeen, setKv, storeBody, storeMail } from './cache';
import { availableLanguages, i18nData, initI18n, chromiumLocale, regionWeekStart, t } from './i18n';
import { writeFileSafe } from './files';

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
// mailto: links. Windows/Linux pass them on the command line (also to a second instance),
// macOS sends open-url, possibly before the app is ready
let pendingMailto: string | null = mailtoArg(process.argv) ?? null;
app.on('open-url', (e, url) => {
  if (!/^mailto:/i.test(url)) return;
  e.preventDefault();
  if (app.isReady()) openMailto(url);
  else pendingMailto = url;
});

// Windows: without an app ID no notifications appear
if (process.platform === 'win32') app.setAppUserModelId('ch.ciegolink.agenoras');

// A stray error (a dropped connection nobody waited for, a broken server answer) must not bring up
// Electron's error dialog or stop the app: write it to the console and go on
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

const lang = initI18n(savedLanguage());
app.commandLine.appendSwitch('lang', chromiumLocale());

// Linux: hardware acceleration off. With some drivers Electron's GPU process crashes otherwise
// (exit_code=139) and the window stays empty. A mail app does not need it.
// To turn it back on for testing: AGENORAS_GPU=1 npm start
if (process.platform === 'linux' && process.env.AGENORAS_GPU !== '1') {
  app.disableHardwareAcceleration();
}

// Windows fetch the strings synchronously at startup (once, small)
ipcMain.on('i18n:get', (e) => {
  const ws = getSettings().weekStart;
  e.returnValue = { ...i18nData(), weekStart: ws < 0 ? regionWeekStart() : ws, regionWeekStart: regionWeekStart(), version: app.getVersion() };
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
    if (/^mailto:/i.test(url)) openMailto(url); // our own compose window, no detour through the system
    else if (/^https?:/i.test(url)) {
      // links from the main window: in the browser column if chosen (Settings → General)
      if (w === win && getSettings().linkOpen === 'agenoras') win.webContents.send('web:open', url);
      else shell.openExternal(url);
    }
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

const execFileP = promisify(execFile);

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
    // webviewTag: the browser column (hardened in will-attach-webview below)
    webPreferences: { ...webPreferences, backgroundThrottling: false, webviewTag: true },
  });
  lockDown(win);
  // Browser column: web pages only, no preload, no Node, sandboxed, in their own session that is
  // forgotten when the app closes (no cookies mixed with anything else, nothing left behind)
  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete (prefs as { preload?: string }).preload;
    Object.assign(prefs, { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, partition: WEB_PARTITION });
    if (!/^https?:/i.test(params.src ?? '')) e.preventDefault();
  });
  trackWinState(win, 'main', true);
  win.loadFile(path.join(__dirname, '../../src/renderer/index.html'));
  win.once('ready-to-show', () => {
    if (st.maximized) win?.maximize();
    win?.show();
  });
  win.on('focus', () => setTrayUnread(false));
  // reload (Ctrl+R) of the main window: darken again if a compose popup is still open
  win.webContents.on('did-finish-load', () => paintDim());
  // to the tray and back: the compose popups go along
  win.on('hide', () => popups.forEach((p) => !p.isDestroyed() && p.hide()));
  win.on('show', () => popups.forEach((p) => !p.isDestroyed() && p.show()));
  for (const ev of ['move', 'resize', 'maximize', 'unmaximize'] as const) win.on(ev as 'move', followParent);
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

app.on('second-instance', (_e, argv) => {
  const url = mailtoArg(argv);
  if (url) openMailto(url);
  else showWindow();
});

// Runs fn once the main window has loaded (messages sent earlier would get lost)
function whenMainReady(fn: () => void): void {
  if (!win) createWindow();
  const w = win!;
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', fn);
  else fn();
}

function openMailto(url: string): void {
  const m = parseMailto(url);
  if (!m) return;
  showWindow();
  whenMainReady(() => openComposeWindow({ mode: 'new', to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, body: m.body }));
}

// New event, task or contact from the tray: the main window opens the dialog
function createFromTray(kind: 'event' | 'task' | 'contact'): void {
  showWindow();
  whenMainReady(() => win?.webContents.send('app:create', kind));
}

// Tray
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
      { label: t('tb.newEvent'), click: () => createFromTray('event') },
      { label: t('tb.newTask'), click: () => createFromTray('task') },
      { label: t('tb.newContact'), click: () => createFromTray('contact') },
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

// Desktop notifications
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

// Compose window (one window per mail, like Outlook)
const composeOpts = new Map<number, unknown>();
// Open popups: the main window darkens behind them (like a modal dialog)
const popups = new Set<BrowserWindow>();
function paintDim(): void {
  win?.webContents.send('compose:dim', popups.size > 0);
}
// Size like the settings dialog: centred in the main window, at most 960 × 860
function popupBounds(p: Electron.Rectangle): Electron.Rectangle {
  const width = Math.min(960, Math.round(p.width * 0.92));
  const height = Math.min(860, Math.round(p.height * 0.9));
  return { width, height, x: p.x + Math.round((p.width - width) / 2), y: p.y + Math.round((p.height - height) / 2) };
}
// a small main window: the popup may be smaller than the normal minimum, but never larger than the window
const popupMin = (b: Electron.Rectangle) => ({ minWidth: Math.min(640, b.width), minHeight: Math.min(520, b.height) });
// The popups move and resize with the main window
function followParent(): void {
  if (!win || !popups.size) return;
  const b = popupBounds(win.getBounds());
  const min = popupMin(b);
  for (const p of popups) {
    if (p.isDestroyed()) continue;
    p.setMinimumSize(min.minWidth, min.minHeight);
    p.setBounds(b);
  }
}
ipcMain.handle('compose:focusPopup', () => {
  const last = [...popups].pop();
  last?.focus();
});

function openComposeWindow(opts: unknown): void {
  const parentBounds = win?.getBounds();
  // Popup: belongs to the main window (stays above it, no own taskbar entry), centred over it
  const popup = getSettings().composeMode === 'popup' && !!win && win.isVisible() && !!parentBounds;
  const st = loadWinState('compose', { width: 900, height: 800 });
  const cw = new BrowserWindow({
    width: st.width,
    height: st.height,
    icon: APP_ICON,
    minWidth: 640,
    minHeight: 520,
    ...(popup
      ? // like a dialog inside the main window: fixed in the middle, cannot be moved or resized
        { parent: win!, skipTaskbar: true, minimizable: false, maximizable: false, resizable: false, movable: false, fullscreenable: false, ...popupBounds(parentBounds!), ...popupMin(popupBounds(parentBounds!)) }
      : // slightly offset from the main window so both are visible
        parentBounds
        ? { x: parentBounds.x + 120 + composeOpts.size * 28, y: parentBounds.y + 50 + composeOpts.size * 28 }
        : {}),
    backgroundColor: bgColor(),
    title: 'Agenoras',
    show: false,
    ...frameOpts,
    webPreferences,
  });
  const id = cw.webContents.id;
  composeOpts.set(id, opts ?? {});
  lockDown(cw);
  if (!popup) trackWinState(cw, 'compose', false);
  cw.loadFile(path.join(__dirname, '../../src/renderer/compose.html'), popup ? { query: { popup: '1' } } : undefined);
  cw.once('ready-to-show', () => {
    if (st.maximized && !popup) cw.maximize();
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
  if (popup) {
    popups.add(cw);
    paintDim();
  }
  cw.on('closed', () => {
    composeOpts.delete(id);
    if (popups.delete(cw)) paintDim();
  });
}

// Mail in its own window (double-click in the list)
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

// Pin sidebar (a column in the main window): pinned tasks and feed articles, kept in pins.ts
const sendPins = () => win?.webContents.send('pins:changed', listPins());

ipcMain.handle('pins:list', () => listPins());
ipcMain.handle('pins:add', (_e, item: PinItem) => {
  addPin(item);
  sendPins();
});
ipcMain.handle('pins:remove', (_e, key: string) => {
  removePin(String(key));
  sendPins();
});
ipcMain.handle('pins:toggle', (_e, key: string) => {
  togglePin(String(key));
  sendPins();
});
ipcMain.handle('pins:update', (_e, items: PinItem[]) => {
  if (updatePins(items)) sendPins();
});

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

// Default mail app (mailto:)
async function isDefaultMail(): Promise<boolean> {
  if (!app.isPackaged) return false;
  if (process.platform !== 'win32') return app.isDefaultProtocolClient('mailto');
  // Windows: what the user picked in Settings → Default apps (our own registry entry says nothing about that)
  try {
    const { stdout } = await execFileP('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\mailto\\UserChoice', '/v', 'ProgId']);
    return /Agenoras\.mailto/.test(stdout);
  } catch {
    return false;
  }
}

ipcMain.handle('mailto:status', async () => ({ isDefault: await isDefaultMail(), packaged: app.isPackaged, platform: process.platform }));
ipcMain.handle('mailto:setDefault', async () => {
  if (!app.isPackaged) return false;
  // Windows 10/11 only lets the user choose: open the page with Agenoras' entries (registered by the installer)
  if (process.platform === 'win32') {
    await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Agenoras').catch(() => shell.openExternal('ms-settings:defaultapps'));
    return false;
  }
  app.setAsDefaultProtocolClient('mailto');
  return isDefaultMail();
});
ipcMain.handle('compose:init', (e) => composeOpts.get(e.sender.id) ?? {});
// Sent: play the sound in the main window (the compose window closes right away)
ipcMain.handle('compose:sent', () => win?.webContents.send('mail:sent'));
ipcMain.handle('compose:done', (e, status: string) => {
  win?.webContents.send('mail:status', status);
  BrowserWindow.fromWebContents(e.sender)?.destroy(); // sent → close without asking
});

// Mail accounts
ipcMain.handle('accounts:list', () => listAccounts());

ipcMain.handle('accounts:add', async (_e, input: NewAccount) => {
  if (!input?.email || !input.host || !input.user || !input.pass) throw new Error(t('err.fillAll'));
  try {
    await testConnection(input, input.pass);
  } catch (err) {
    log('error', 'IMAP', input.email, t('log.testFailed', { msg: friendlyError(err) }));
    throw new Error('IMAP: ' + friendlyError(err));
  }
  try {
    await testSmtp(input, input.pass);
  } catch (err) {
    log('error', 'SMTP', input.email, t('log.testFailed', { msg: friendlyError(err) }));
    throw new Error('SMTP: ' + friendlyError(err));
  }
  resolved('IMAP', input.email);
  resolved('SMTP', input.email);
  const acc = await addAccount(input);
  startAccount(acc).catch((err) => console.error(friendlyError(err)));
  return acc;
});

// OAuth accounts: sign in in the browser, server settings come from the provider
ipcMain.handle('oauth:providers', () => oauthProviders());
ipcMain.handle('oauth:cancel', () => cancelSignIn());

ipcMain.handle('oauth:signin', async (_e, provider: string, extra: { name?: string; color?: string; pin?: string; autoLockMin?: number }) => {
  if (!isOAuthProvider(provider)) throw new Error(t('oauth.notConfigured'));
  const res = await signIn(provider);
  const server = serverFor(provider);
  const cfg = { ...server, user: res.email, protocol: 'imap' as const };
  try {
    await testConnection(cfg, { accessToken: res.accessToken });
  } catch (err) {
    log('error', 'IMAP', res.email, t('log.testFailed', { msg: friendlyError(err) }));
    throw new Error('IMAP: ' + friendlyError(err));
  }
  try {
    await testSmtp(cfg, { accessToken: res.accessToken });
  } catch (err) {
    log('error', 'SMTP', res.email, t('log.testFailed', { msg: friendlyError(err) }));
    throw new Error('SMTP: ' + friendlyError(err));
  }
  resolved('IMAP', res.email);
  resolved('SMTP', res.email);
  // Same address already there: just renew the sign-in
  const existing = listAccounts().find((a) => a.oauth === provider && a.email.toLowerCase() === res.email.toLowerCase());
  if (existing) return reconnectOAuth(existing.id, res);
  const acc = await addAccount({ ...cfg, email: res.email, name: String(extra?.name ?? '').trim() || res.name || res.email, pass: res.refreshToken, oauth: provider, color: extra?.color, pin: extra?.pin, autoLockMin: extra?.autoLockMin });
  rememberToken(acc.id, res.accessToken, res.expiresAt);
  startAccount(acc).catch((err) => console.error(friendlyError(err)));
  return acc;
});

// "Sign in again" on an OAuth account (access revoked or expired)
ipcMain.handle('oauth:reauth', async (_e, id: string) => {
  const acc = getAccount(id);
  if (!acc?.oauth) throw new Error(t('err.accountNotFound'));
  const res = await signIn(acc.oauth);
  if (res.email.toLowerCase() !== acc.email.toLowerCase()) throw new Error(t('oauth.otherAccount', { email: acc.email }));
  return reconnectOAuth(id, res);
});

async function reconnectOAuth(id: string, res: { refreshToken: string; accessToken: string; expiresAt: number }) {
  await setSecret(id, res.refreshToken);
  rememberToken(id, res.accessToken, res.expiresAt);
  await closeAccount(id);
  const acc = getAccount(id)!;
  startAccount(acc).catch((err) => console.error(friendlyError(err)));
  return acc;
}

ipcMain.handle('accounts:update', async (_e, id: string, input: AccountUpdate) => {
  const current = getAccount(id);
  if (!current) throw new Error(t('err.accountNotFound'));
  // OAuth: only name and colour can change, the rest belongs to the provider
  if (current.oauth) {
    const acc = await updateAccount(id, { ...current, name: input?.name ?? current.name, color: input?.color });
    win?.webContents.send('mail:status', '');
    return acc;
  }
  if (!input?.email || !input.host || !input.user) throw new Error(t('err.fillAll'));
  const pass = input.pass || (await getPassword(id));
  try {
    await testConnection(input, pass);
  } catch (err) {
    log('error', 'IMAP', input.email, t('log.testFailed', { msg: friendlyError(err) }));
    throw new Error('IMAP: ' + friendlyError(err));
  }
  try {
    await testSmtp(input, pass);
  } catch (err) {
    log('error', 'SMTP', input.email, t('log.testFailed', { msg: friendlyError(err) }));
    throw new Error('SMTP: ' + friendlyError(err));
  }
  resolved('IMAP', input.email);
  resolved('SMTP', input.email);
  const acc = await updateAccount(id, input);
  await closeAccount(id); // reconnect with the new settings
  startAccount(acc).catch((err) => console.error(friendlyError(err)));
  return acc;
});

ipcMain.handle('accounts:color', (_e, id: string, color: string) => setAccountColor(id, color));

// Private accounts (PIN, auto-lock)
let lastActivity = Date.now();

// Close the connection, wipe the local copies (mails, bodies, starred list) and
// close single-mail windows – nothing of a locked account stays on screen or on disk
async function forgetPrivate(id: string): Promise<void> {
  await closeAccount(id);
  forgetMailAccount(id);
  setKv(`flagged:${id}`, []);
  for (const [wcId, ref] of viewerOpts) {
    if ((ref as { accountId?: string })?.accountId === id) BrowserWindow.getAllWindows().find((w) => w.webContents.id === wcId)?.destroy();
  }
}

const privacyChanged = () => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('privacy:changed', privacyState());
};

async function lockPrivate(ids?: string[]): Promise<void> {
  const closed = lockAccounts(ids);
  if (!closed.length) return;
  await Promise.all(closed.map(forgetPrivate));
  privacyChanged();
}

ipcMain.handle('privacy:state', () => privacyState());
ipcMain.handle('privacy:activity', () => void (lastActivity = Date.now()));
ipcMain.handle('privacy:lock', () => lockPrivate());
ipcMain.handle('privacy:unlock', (_e, pin: string) => {
  const opened = unlockWithPin(pin);
  lastActivity = Date.now();
  for (const acc of opened) startAccount(acc).catch((err) => console.error(friendlyError(err)));
  privacyChanged();
  return opened.length;
});
ipcMain.handle('privacy:set', (_e, id: string, pin: string | null, autoLockMin?: number) => {
  const wasPrivate = !!getAccount(id)?.private;
  const acc = setPrivacy(id, pin, autoLockMin);
  lastActivity = Date.now();
  if (wasPrivate !== !!acc.private) privacyChanged();
  return acc;
});

// Auto-lock: each private account after its own number of minutes without any use of the app
setInterval(() => {
  const idle = Date.now() - lastActivity;
  const due = unlockedPrivate().filter((a) => idle >= (a.autoLockMin ?? 5) * 60_000);
  if (due.length) lockPrivate(due.map((a) => a.id)).catch((err) => console.error('auto-lock:', err));
}, 15_000);

// Problem log (warning sign in the title bar)
setOnLogChange((state) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('log:changed', state);
});
ipcMain.handle('log:state', () => logState());
ipcMain.handle('log:list', () => getLog());
ipcMain.handle('log:seen', () => markLogSeen());
ipcMain.handle('log:clear', () => clearLog());

ipcMain.handle('accounts:remove', async (_e, id: string) => {
  const big = hasOffline(id); // a lot of local data: shrink the files afterwards
  const pop = listAllAccounts().find((a) => a.id === id)?.protocol === 'pop3';
  await closeAccount(id);
  removeAccount(id);
  forgetMailAccount(id);
  forgetPopAccount(id); // POP3: the local mailbox belongs to the account
  forgetToken(id);
  if (big || pop) freeSpace(big, pop);
});

// After deleting a lot (an account with offline copy or a POP3 mailbox, a switched-off offline copy):
// give the space back to the system right away (incremental, see cache.ts)
function freeSpace(cache = true, pop = false): void {
  try {
    const bytes = (cache ? vacuumCache() : 0) + (pop ? vacuumPop() : 0);
    if (bytes >= 1048576) win?.webContents.send('mail:status', t('cache.freed', { mb: Math.round(bytes / 1048576).toLocaleString(i18nData().locale) }));
  } catch (err) {
    console.error('VACUUM:', err);
  }
}
onOfflineCleared(() => freeSpace());

// Mail
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

// Scrolling down: the next 50 older mails per account, from the offline copy when it has them
// before = smallest UID shown so far per account; done = nothing older left there
ipcMain.handle('mail:older', async (_e, accountId: string | null, folder = 'INBOX', before: Record<string, number>) => {
  const mails: MailSummary[] = [];
  const done: string[] = [];
  await Promise.all(
    accountsFor(accountId).map(async (acc) => {
      const min = Number(before?.[acc.id]);
      if (!min || min <= 1) return void done.push(acc.id);
      const key = folderKey(acc.id, folder);
      const offline = offlineOlder<MailSummary>(key, min, 50).map((m) => ({ ...m, folder }));
      let got = offline;
      if (offline.length < 50) {
        try {
          got = await fetchOlder(acc, folder, min, 50);
        } catch {
          /* offline: what the copy has */
        }
      }
      if (got.length < 50) done.push(acc.id);
      mails.push(...got);
    }),
  );
  return { mails: mails.sort((a, b) => b.date.localeCompare(a.date)), done };
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

// markRead = false: only show (the main window marks it read itself after the chosen delay)
ipcMain.handle('mail:get', async (_e, accountId: string, folder: string, uid: number, loadImages = false, markRead = true) => {
  const acc = getAccount(accountId);
  if (!acc) throw new Error(t('err.accountNotFound'));
  const key = folderKey(accountId, folder);

  const cached = cachedBody<MailDetail>(key, uid);
  if (cached) {
    if (markRead) {
      setCachedSeen(key, uid);
      markSeen(acc, folder, uid).catch(() => {}); // in the background, no error when offline
    }
    return withImages({ ...cached, priority: cached.priority ?? 'normal', folder }, !!loadImages);
  }
  // offline copy: complete ones like the cache, a shortened one only when the server is not reachable
  const offline = offlineBody<MailDetail & { failed?: boolean }>(key, uid);
  if (offline && !offline.partial && !offline.failed) {
    if (markRead) {
      setCachedSeen(key, uid);
      markSeen(acc, folder, uid).catch(() => {});
    }
    return withImages({ ...offline, priority: offline.priority ?? 'normal', folder }, !!loadImages);
  }
  let detail: MailDetail;
  try {
    detail = await getMessage(acc, folder, uid, !!markRead);
  } catch (err) {
    if (offline?.partial && !offline.failed) return withImages({ ...offline, priority: offline.priority ?? 'normal', folder }, !!loadImages);
    throw new Error(friendlyError(err));
  }
  storeBody(key, uid, detail);
  if (markRead) setCachedSeen(key, uid);
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
// Older mails found on the server are kept in kv 'labelMails' (Message-ID → summaries)
ipcMain.handle('mail:byMessageIds', (_e, ids: string[]) => {
  const want = Array.isArray(ids) ? ids.map(String) : [];
  const found = cachedByMessageIds<MailSummary>(want);
  const have = new Set(found.map((m) => m.messageId));
  const stored = getKv<Record<string, MailSummary[]>>('labelMails') ?? {};
  for (const id of want) if (!have.has(id)) found.push(...(stored[id] ?? []).filter((m) => getAccount(m.accountId)));
  return found.sort((a, b) => b.date.localeCompare(a.date));
});

// Look up on the server the ones that are not in the mail cache
ipcMain.handle('mail:findByMessageIds', async (_e, ids: string[]) => {
  const want = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
  const missing = want.filter((id) => !cachedByMessageIds<MailSummary>([id]).length);
  const found = missing.length ? (await Promise.all(listAccounts().map((acc) => findByMessageIds(acc, missing).catch(() => [] as MailSummary[])))).flat() : [];
  const labeled = new Set(Object.keys(getSettings().mailLabels ?? {}));
  const stored = getKv<Record<string, MailSummary[]>>('labelMails') ?? {};
  for (const id of Object.keys(stored)) if (!labeled.has(id)) delete stored[id];
  for (const id of missing) {
    const hits = found.filter((m) => m.messageId === id);
    if (hits.length) stored[id] = hits;
    else delete stored[id]; // deleted or moved to the trash
  }
  setKv('labelMails', stored);
  return { found: found.length, missing: missing.filter((id) => !found.some((m) => m.messageId === id)).length };
});

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

// Instant hits from the local cache (before the server search answers)
ipcMain.handle('mail:search:cached', (_e, accountId: string | null, folder: string | null, query: string) => {
  const q = String(query ?? '').trim();
  if (q.length < 2) return [];
  return searchCachedMail<MailSummary>(accountsFor(accountId).map((a) => a.id), folder || null, q, 200, parseDateQuery(q));
});

// Full-text search on the server: one folder or all folders (without Gmail's "All Mail")
// A newer search makes the older one stop after its current folder (frees the connection)
let searchGen = 0;
// Most likely places first, trash/junk last
const SEARCH_ORDER = ['', '\\Sent', '\\Archive', '\\Drafts', '\\Junk', '\\Trash'];
const searchRank = (f: FolderInfo) => (f.path === 'INBOX' ? -1 : SEARCH_ORDER.indexOf(f.specialUse) === -1 ? 0 : SEARCH_ORDER.indexOf(f.specialUse));

ipcMain.handle('mail:search', async (_e, accountId: string | null, folder: string | null, query: string) => {
  const q = String(query ?? '').trim();
  const gen = ++searchGen;
  if (q.length < 2) return { mails: [], errors: [] };
  const cancelled = () => gen !== searchGen;
  // whole mailbox stored offline: the local search already found everything
  const accs = accountsFor(accountId).filter((a) => !offlineComplete(a.id));
  const errors: { accountId: string; message: string }[] = [];
  const perAccount = await Promise.all(
    accs.map(async (acc) => {
      try {
        // folder list from the cache when possible (saves a LIST round trip)
        const known = getKv<FolderInfo[]>(`folders:${acc.id}`);
        const all = known?.length ? known : await listFolders(acc);
        const folders = folder
          ? [folder]
          : all
              .filter((f) => f.selectable && f.specialUse !== '\\All')
              .sort((a, b) => searchRank(a) - searchRank(b))
              .map((f) => f.path);
        return await searchFolders(acc, folders, q, folder ? 100 : 30, cancelled, parseDateQuery(q));
      } catch (err) {
        errors.push({ accountId: acc.id, message: friendlyError(err) });
        return [];
      }
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
    const moved = await moveMessages(acc, folder, list, target);
    for (const uid of list) removeCachedMail(folderKey(accountId, folder), uid);
    return { target, uids: moved };
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

// Whole folder read (right-click on a folder)
ipcMain.handle('mail:markFolderSeen', async (_e, accountId: string, folder: string) => {
  const acc = getAccount(accountId);
  if (!acc) throw new Error(t('err.accountNotFound'));
  try {
    const n = await markFolderSeen(acc, String(folder));
    forgetFolder(folderKey(accountId, String(folder)));
    return n;
  } catch (err) {
    throw new Error(friendlyError(err));
  }
});

// Empty the trash (permanently). Only the account's real trash folder – never another folder by mistake.
ipcMain.handle('mail:emptyTrash', async (_e, accountId: string) => {
  const acc = getAccount(accountId);
  if (!acc) throw new Error(t('err.accountNotFound'));
  try {
    const trash = await trashFolder(acc);
    if (!trash) throw new Error(t('err.noTrash'));
    const n = await emptyFolder(acc, trash);
    forgetFolder(folderKey(accountId, trash));
    return n;
  } catch (err) {
    throw new Error(friendlyError(err));
  }
});

// All spam into the trash
ipcMain.handle('mail:junkToTrash', async (_e, accountId: string) => {
  const acc = getAccount(accountId);
  if (!acc) throw new Error(t('err.accountNotFound'));
  try {
    const [junk, trash] = await Promise.all([junkFolder(acc), trashFolder(acc)]);
    if (!junk) throw new Error(t('err.noJunk'));
    if (!trash) throw new Error(t('err.noTrash'));
    const n = await moveAllMessages(acc, junk, trash);
    forgetFolder(folderKey(accountId, junk));
    return n;
  } catch (err) {
    throw new Error(friendlyError(err));
  }
});

// Mini-KI (offline)
ipcMain.handle('ai:state', () => aiState());
ipcMain.handle('ai:enable', (_e, on: boolean) => setAiEnabled(!!on));
ipcMain.handle('ai:model', (_e, id: string) => setAiModel(String(id)));
ipcMain.handle('ai:lang', (_e, lang: string) => setAiLang(String(lang)));
ipcMain.handle('ai:translateLang', (_e, lang: string) => setAiTranslateLang(String(lang ?? '')));
ipcMain.handle('ai:download', (_e, id: string) => downloadAiModel(String(id)));
ipcMain.handle('ai:cancel', () => cancelAiDownload());
ipcMain.handle('ai:delete', (_e, id: string) => deleteAiModel(String(id)));
ipcMain.handle('ai:subjects', (_e, text: string) => suggestSubjects(text));
ipcMain.handle('ai:proofread', (_e, text: string) => proofread(text));
ipcMain.handle('ai:write', (_e, instruction: string, ctx?: { original?: string; subject?: string }) => writeText(instruction, ctx));
ipcMain.handle('ai:translate', (_e, text: string, target: string) => translate(String(text ?? ''), String(target)));

// Reactions: a short reply mail whose content is the emoji
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉'];

// HTML-only mails: rough text for the quote (no DOM in the main process)
function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

ipcMain.handle('mail:react', async (_e, accountId: string, folder: string, uid: number, emoji: string) => {
  const acc = getAccount(accountId);
  if (!acc) throw new Error(t('err.accountNotFound'));
  if (!REACTIONS.includes(emoji)) throw new Error('Unknown reaction');
  const msg = await getMessage(acc, folder, uid, false);
  const to = msg.replyTo || msg.fromAddress;
  if (!to) throw new Error(t('err.noRecipient'));
  // sender: the address the mail went to (alias), otherwise the account's main address
  const mine = getSettings().identities.filter((i) => i.accountId === accountId);
  const wanted = new Set([...msg.toList, ...msg.ccList].map((a) => a.toLowerCase()));
  const identity = mine.find((i) => wanted.has(i.email.toLowerCase())) ?? mine.find((i) => i.primary) ?? mine[0];
  if (!identity) throw new Error(t('err.senderNotFound'));
  const subject = /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`;
  const line = t('react.line', { subject: msg.subject || t('mail.noSubject') });
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  // Quote the original like a normal reply (as text – foreign HTML never goes into an own mail)
  const original = (msg.text.trim() || htmlToText(msg.html ?? '')).replace(/\s+$/, '');
  const when = new Date(msg.date).toLocaleString(i18nData().locale, { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const header = t('quote.header', { date: when, name: msg.fromName, email: msg.fromAddress });
  const quoteText = original ? `\n\n${header}\n${original.split('\n').map((l) => `> ${l}`).join('\n')}` : '';
  const quoteHtml = original
    ? `<p style="color:#555;font-size:13px;margin:16px 0 4px">${esc(header)}</p><blockquote style="margin:0 0 0 4px;padding-left:10px;border-left:2px solid #C1C8BE;color:#555">${esc(original).replace(/\n/g, '<br>')}</blockquote>`
    : '';
  try {
    await sendMail(identity, acc, {
      identityId: identity.id,
      to: [to],
      cc: [],
      bcc: [],
      subject,
      text: `${emoji}\n\n${line}${quoteText}`,
      html: `<div style="font-size:40px;line-height:1.2">${emoji}</div><div style="color:#888;font-size:12px;margin-top:8px">${esc(line)}</div>${quoteHtml}`,
      inReplyTo: msg.messageId,
      references: [...msg.references, msg.messageId].filter(Boolean),
    }, () => {});
    resolved('SMTP', acc.email);
  } catch (err) {
    log('error', 'SMTP', acc.email, friendlyError(err));
    throw new Error(friendlyError(err));
  }
  return to;
});

// Attachments
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

// Outbox: after the undo delay the compose window closes and the mail is sent here in the background.
// It stays in the outbox until the server has it; failed ones wait there to be sent again, edited or discarded.
const sendOutbox = () => win?.webContents.send('outbox:changed', outboxList());

function rememberRecipients(mail: OutgoingMail): void {
  const parse = (l: string[] = []) => l.map((x) => /^"?([^"<]*)"?\s*<([^>]+)>$/.exec(x.trim())).map((m, i) => (m ? { name: m[1].trim(), address: m[2] } : { name: '', address: l[i].trim() }));
  try {
    rememberAddresses([...parse(mail.to), ...parse(mail.cc), ...parse(mail.bcc), ...parse((mail.individual ?? []).map((x) => x.to))]);
  } catch {
    /* not critical */
  }
}

// Mails being handed to the server right now: a second start (double click on "Send again",
// back online at the same moment) must not send them twice
const sendingNow = new Set<string>();

async function runOutbox(id: string): Promise<void> {
  if (sendingNow.has(id)) return;
  sendingNow.add(id);
  try {
    await sendOutboxItem(id);
  } finally {
    sendingNow.delete(id);
  }
}

async function sendOutboxItem(id: string): Promise<void> {
  const item = outboxItem(id);
  const identity = item && getIdentity(item.mail.identityId);
  const acc = identity && getAccount(identity.accountId);
  if (!item) return;
  if (!identity || !acc) {
    updateOutbox(id, { status: 'failed', error: t('err.senderNotFound') });
    return sendOutbox();
  }
  updateOutbox(id, { status: 'sending', error: '', done: 0 });
  sendOutbox();
  try {
    const res = await sendMail(identity, acc, item.mail, (done, total) => {
      updateOutbox(id, { done, total });
      sendOutbox();
    });
    resolved('SMTP', acc.email);
    rememberRecipients(item.mail);
    if (res.failed.length) {
      // "Individually to each": only the ones that failed stay, to be sent again
      const failed = new Set(res.failed.map((f) => f.to));
      const rest = (item.mail.individual ?? []).filter((x) => failed.has(x.to));
      updateOutbox(id, {
        status: 'failed',
        mail: { ...item.mail, individual: rest },
        to: rest.map((x) => x.to),
        total: rest.length,
        done: 0,
        error: t('compose.partialFail', { sent: res.sent, failed: res.failed.length, list: res.failed.map((f) => `${f.to} (${f.message})`).join('; ') }),
      });
    } else {
      removeOutbox(id);
      // reply / forward: mark the original (the list shows it at once, the server gets the flag)
      const src = item.mail.answers;
      const srcAcc = src && getAccount(src.accountId);
      if (src?.messageId) {
        // when and to whom – shown above the original ("You replied on …")
        const log = getKv<Record<string, AnswerNote[]>>('answeredLog') ?? {};
        log[src.messageId] = [...(log[src.messageId] ?? []), { date: new Date().toISOString(), kind: src.kind, to: item.to }].slice(-10);
        setKv('answeredLog', log);
      }
      if (src && srcAcc) {
        win?.webContents.send('mail:answered', src);
        markAnswered(srcAcc, src.folder, src.uid, src.kind).catch((err) => console.error('answered:', friendlyError(err)));
      }
      win?.webContents.send('mail:sent'); // the "ding"
      win?.webContents.send('mail:status', item.mail.individual?.length ? t('compose.sentEach', { n: res.sent }) : t('compose.sentAll', { n: item.to.length }));
    }
  } catch (err) {
    log('error', 'SMTP', acc.email, friendlyError(err));
    updateOutbox(id, { status: 'failed', error: friendlyError(err) });
  }
  sendOutbox();
}

ipcMain.handle('outbox:send', (_e, mail: OutgoingMail) => {
  const identity = getIdentity(mail?.identityId);
  const acc = identity && getAccount(identity.accountId);
  if (!identity || !acc) throw new Error(t('err.senderNotFound'));
  const notApproved = (mail.files ?? []).find((f) => !approvedFiles.has(f));
  if (notApproved) throw new Error(t('err.fileNotApproved', { name: path.basename(notApproved) }));
  const item = addOutbox(acc.id, identity.email, mail);
  void runOutbox(item.id);
  return item.id;
});
ipcMain.handle('outbox:list', () => outboxList());

// Replies and forwards of one mail: sent from Agenoras (with date and recipients), otherwise own replies
// found in the cache (e.g. written with another program, then in "Sent")
interface AnswerNote {
  date: string;
  kind: 'reply' | 'forward';
  to: string[];
  ref?: { accountId: string; folder: string; uid: number }; // the reply itself, if it is in the cache
}
ipcMain.handle('mail:answeredInfo', (_e, messageId: string) => {
  const id = String(messageId ?? '');
  if (!id) return [];
  const notes: AnswerNote[] = [...((getKv<Record<string, AnswerNote[]>>('answeredLog') ?? {})[id] ?? [])];
  const own = new Set([...listAccounts().map((a) => a.email), ...getSettings().identities.map((i) => i.email)].map((a) => a.toLowerCase()));
  for (const m of cachedReplies<MailSummary>(id)) {
    if (!own.has((m.fromAddress ?? '').toLowerCase())) continue;
    const ref = { accountId: m.accountId, folder: m.folder, uid: m.uid };
    // the same reply logged when sending: about the same time → only add the link to it
    const same = notes.find((n) => Math.abs(Date.parse(n.date) - Date.parse(m.date)) < 10 * 60_000);
    if (same) same.ref ??= ref;
    else notes.push({ date: m.date, kind: 'reply', to: [m.toName || m.toAddress].filter(Boolean), ref });
  }
  return notes.sort((a, b) => b.date.localeCompare(a.date));
});
ipcMain.handle('outbox:retry', (_e, id: string) => void runOutbox(String(id)));
ipcMain.handle('outbox:discard', (_e, id: string) => {
  if (outboxItem(String(id))?.status === 'sending') return;
  removeOutbox(String(id));
  sendOutbox();
});
// Edit: back into a compose window (text, recipients, attachments); it leaves the outbox
ipcMain.handle('outbox:edit', async (_e, id: string) => {
  const item = outboxItem(String(id));
  if (!item || item.status === 'sending' || item.mail.forward?.indexes?.length) return;
  const m = item.mail;
  const files = [];
  for (const f of m.files ?? []) {
    try {
      files.push(await fileInfo(f));
    } catch {
      /* file is gone */
    }
  }
  openComposeWindow({
    accountId: item.accountId,
    matchAddresses: [item.from],
    to: m.individual?.length ? m.individual.map((x) => x.to) : m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    html: m.draftHtml,
    body: m.draftHtml ? undefined : m.text,
    inReplyTo: m.inReplyTo,
    references: m.references,
    sendMode: m.individual?.length ? 'each' : undefined,
    // still a reply / forward: the original gets marked when it is sent
    source: m.answers ? { accountId: m.answers.accountId, folder: m.answers.folder, uid: m.answers.uid, messageId: m.answers.messageId } : undefined,
    mode: m.answers ? (m.answers.kind === 'forward' ? 'forward' : 'reply') : undefined,
    files,
    attachData: (m.extraAttachments ?? []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
  });
  removeOutbox(item.id);
  sendOutbox();
});

// Settings: senders/aliases, signatures, templates
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
// Spell check while writing (red underlines, and the dictionary part of proofreading).
// Off, the system languages, or one dictionary. macOS uses its own checker and picks the language itself.
function applySpellcheck(): void {
  const mode = getSettings().spellcheck;
  const ses = session.defaultSession;
  ses.setSpellCheckerEnabled(mode !== 'off');
  if (mode === 'off' || process.platform === 'darwin') return;
  const avail = ses.availableSpellCheckerLanguages;
  const pick = (code: string) => avail.find((l) => l.toLowerCase() === code.toLowerCase()) ?? avail.find((l) => l.toLowerCase().split('-')[0] === code.toLowerCase().split('-')[0]);
  const wanted = mode === 'system' ? app.getPreferredSystemLanguages() : [mode];
  const langs = [...new Set(wanted.map(pick).filter((l): l is string => !!l))].slice(0, 3);
  try {
    ses.setSpellCheckerLanguages(langs.length ? langs : ['en-US']);
  } catch (err) {
    console.error('spellcheck:', (err as Error).message);
  }
}
// Browser column: its own session; asks for camera, location & co. are always refused
const WEB_PARTITION = 'agenoras-web';
app.whenReady().then(() => {
  const ses = session.fromPartition(WEB_PARTITION);
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
});
// Right click in text: Electron shows no menu of its own. Spelling suggestions for a marked word,
// add to the dictionary, cut / copy / paste. Our windows draw it like their other menus (common.ts);
// the browser column gets the plain system menu. Pages with their own menu (mail list …) prevent this one.
app.on('web-contents-created', (_e, contents) => {
  contents.on('context-menu', (_ev, p) => {
    const spell = p.misspelledWord ? { word: p.misspelledWord, suggestions: p.dictionarySuggestions.slice(0, 6) } : null;
    const copyOnly = !p.isEditable && !!p.selectionText.trim();
    if (!spell && !p.isEditable && !copyOnly) return;
    if (contents.getType() !== 'webview') {
      contents.send('ctx:text', { x: p.x, y: p.y, spell, editable: p.isEditable, can: { cut: p.editFlags.canCut, copy: p.editFlags.canCopy, paste: p.editFlags.canPaste } });
      return;
    }
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (p.isEditable) items.push({ label: t('ctx.cut'), role: 'cut' }, { label: t('ctx.copy'), role: 'copy' }, { label: t('ctx.paste'), role: 'paste' });
    else items.push({ label: t('ctx.copy'), role: 'copy' });
    Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined });
  });
});
// what was picked in that menu
ipcMain.handle('ctx:act', (e, act: string, word?: string) => {
  const c = e.sender;
  if (act === 'replace' && typeof word === 'string') c.replaceMisspelling(word);
  else if (act === 'learn' && typeof word === 'string') c.session.addWordToSpellCheckerDictionary(word);
  else if (act === 'cut') c.cut();
  else if (act === 'copy') c.copy();
  else if (act === 'paste') c.paste();
  else if (act === 'selectAll') c.selectAll();
});

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  // new windows (target=_blank) open in the column itself, mail links in a compose window
  contents.setWindowOpenHandler(({ url }) => {
    if (/^mailto:/i.test(url)) openMailto(url);
    else if (/^https?:/i.test(url)) void contents.loadURL(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (ev, url) => {
    if (/^mailto:/i.test(url)) {
      ev.preventDefault();
      openMailto(url);
    } else if (!/^https?:/i.test(url)) ev.preventDefault();
  });
});
ipcMain.handle('web:external', (_e, url: string) => {
  if (/^https?:/i.test(String(url))) void shell.openExternal(String(url));
});

ipcMain.handle('spell:languages', () => (process.platform === 'darwin' ? [] : session.defaultSession.availableSpellCheckerLanguages));

ipcMain.handle('settings:prefs', (_e, p: { uiScale?: UiScale; language?: string; weekStart?: number; sendDelay?: number; readDelay?: number; composeMode?: 'window' | 'popup'; externalMark?: boolean; internalDomains?: string[]; accountLabel?: 'name' | 'email'; spellcheck?: string; linkOpen?: 'browser' | 'agenoras'; offline?: Record<string, number>; autoUpdate?: boolean; skipVersion?: string }) => {
  const before = getSettings().language;
  const offlineBefore = JSON.stringify(getSettings().offline);
  savePrefs(p ?? {});
  if (p?.spellcheck !== undefined) applySpellcheck();
  if (JSON.stringify(getSettings().offline) !== offlineBefore) restartOffline();
  if (p?.uiScale) for (const w of BrowserWindow.getAllWindows()) w.webContents.setZoomFactor(zoom());
  return { restartNeeded: p?.language !== undefined && p.language !== before };
});
ipcMain.handle('settings:languages', () => availableLanguages());
// Updates (see updater.ts)
ipcMain.handle('update:state', () => updateState());
ipcMain.handle('update:check', () => checkForUpdates());
ipcMain.handle('update:get', () => getUpdate());
ipcMain.handle('update:install', () =>
  installUpdate(() => {
    quitting = true; // past the "keep running in the tray" close
  }),
);

// Settings to another computer: export into one file, import from it (then restart)
ipcMain.handle('transfer:export', async (e, password: string) => {
  const w = BrowserWindow.fromWebContents(e.sender) ?? win!;
  const day = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(w, { title: t('transfer.exportTitle'), defaultPath: path.join(app.getPath('documents'), `agenoras-settings-${day}.json`), filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (res.canceled || !res.filePath) return null;
  writeFileSafe(res.filePath, await buildExport(typeof password === 'string' ? password : ''), 0o600);
  return res.filePath;
});
let importFile: ReturnType<typeof readExport> | null = null;
ipcMain.handle('transfer:pick', async (e) => {
  const w = BrowserWindow.fromWebContents(e.sender) ?? win!;
  const res = await dialog.showOpenDialog(w, { title: t('transfer.importTitle'), properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (res.canceled || !res.filePaths[0]) return null;
  importFile = readExport(res.filePaths[0]);
  return summarize(importFile);
});
ipcMain.handle('transfer:import', async (_e, password: string) => {
  if (!importFile) throw new Error(t('transfer.badFile'));
  const res = await applyImport(importFile, typeof password === 'string' ? password : '');
  importFile = null;
  return res;
});

// Offline copy: state and progress (Settings → General, status at the bottom of the sidebar)
ipcMain.handle('offline:status', () => offlineProgress());
ipcMain.handle('offline:now', () => restartOffline());
onOfflineProgress((p) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('offline:progress', p)));
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

// DAV accounts (calendar + contacts)
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
  if (isLocalDav(getDavAccount(kind, id))) {
    // local: only the name can change
    const acc = renameDavAccount(kind, id, input?.name ?? '');
    renameLocal(id, acc.name);
    if (kind === 'caldav') forgetCalAccount(id);
    else forgetCardAccount(id);
    return acc;
  }
  if (!input?.serverUrl || !input.username) throw new Error(t('err.fillAll'));
  try {
    new URL(input.serverUrl);
  } catch {
    throw new Error(t('err.invalidUrl'));
  }
  const password = input.password || (await getDavPassword(kind, id));
  try {
    if (kind === 'caldav') await testCalDav(input.serverUrl, input.username, password);
    else await testCardDav(input.serverUrl, input.username, password);
  } catch (err) {
    throw new Error(davError(err));
  }
  const acc = await updateDavAccount(kind, id, input);
  if (kind === 'caldav') forgetCalAccount(id);
  else forgetCardAccount(id);
  return acc;
}

ipcMain.handle('cal:accounts:update', (_e, id: string, input: NewDavAccount) => updateDav('caldav', id, input));
ipcMain.handle('contacts:accounts:update', (_e, id: string, input: NewDavAccount) => updateDav('carddav', id, input));

// Calendar (CalDAV)
ipcMain.handle('cal:accounts:list', () => listDavAccounts('caldav'));
ipcMain.handle('cal:accounts:add', (_e, input: NewDavAccount) => addDav('caldav', input));
ipcMain.handle('cal:accounts:addLocal', (_e, name: string) => addLocalDavAccount('caldav', String(name ?? '')));
ipcMain.handle('cal:accounts:remove', (_e, id: string) => {
  forgetCalAccount(id);
  if (isLocalDav(getDavAccount('caldav', id))) forgetLocal(id);
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

// Tasks (CalDAV VTODO)
ipcMain.handle('tasks:cached', () => cachedTasks());
ipcMain.handle('tasks:list', () => listTasks());
ipcMain.handle('tasks:save', async (_e, input: TaskInput) => {
  try {
    return await saveTask(input);
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

// Contacts (CardDAV)
ipcMain.handle('contacts:accounts:list', () => listDavAccounts('carddav'));
ipcMain.handle('contacts:accounts:add', (_e, input: NewDavAccount) => addDav('carddav', input));
ipcMain.handle('contacts:accounts:addLocal', (_e, name: string) => addLocalDavAccount('carddav', String(name ?? '')));
ipcMain.handle('contacts:accounts:remove', (_e, id: string) => {
  forgetCardAccount(id);
  if (isLocalDav(getDavAccount('carddav', id))) forgetLocal(id);
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

// Distribution lists

ipcMain.handle('lists:get', () => getLists());
ipcMain.handle('lists:save', (_e, list: MailList) => saveList(list));
ipcMain.handle('lists:remove', (_e, id: string) => removeList(String(id)));

// RSS
ipcMain.handle('rss:feeds', () => listFeeds());
ipcMain.handle('rss:add', (_e, input: NewRssFeed) => addFeed(input));
ipcMain.handle('rss:update', (_e, id: string, input: NewRssFeed) => updateFeed(id, input));
ipcMain.handle('rss:remove', (_e, id: string) => removeFeed(id));
ipcMain.handle('rss:cached', () => cachedRss());
ipcMain.handle('rss:list', () => refreshFeeds());
ipcMain.handle('rss:search', (_e, query: string) => searchRss(String(query ?? '')));
ipcMain.handle('rss:article', (_e, key: string) => rssArticle(String(key)));
ipcMain.handle('rss:read', (_e, keys: string[], read: boolean) => setRssRead(Array.isArray(keys) ? keys.map(String) : [], !!read));
ipcMain.handle('rss:archive', (_e, keys: string[], archived: boolean) => setRssArchived(Array.isArray(keys) ? keys.map(String) : [], !!archived));
ipcMain.handle('rss:flag', (_e, keys: string[], flagged: boolean) => setRssFlagged(Array.isArray(keys) ? keys.map(String) : [], !!flagged));

// Startup / shutdown
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
  applySpellcheck();
  nativeTheme.themeSource = getSettings().theme;
  powerMonitor.on('resume', () => setTimeout(reconnectAll, 3000)); // give the network a moment to come back
  if (pendingMailto) {
    const url = pendingMailto;
    pendingMailto = null;
    setTimeout(() => openMailto(url), 0); // after the main window exists
  }
  createWindow();
  createTray();
  // Private accounts start locked: remove whatever copies a crash may have left behind
  for (const acc of listAllAccounts()) {
    if (acc.private) {
      forgetMailAccount(acc.id);
      setKv(`flagged:${acc.id}`, []);
    }
  }
  for (const acc of listAccounts()) {
    startAccount(acc)
      .then(() => rulesFor(acc.id)) // Mails that arrived while the app was closed
      .catch((err) => console.error(`[${acc.email}]`, friendlyError(err)));
  }
  // space deleted since the last start (moved, deleted mails, cleared copies) back to the system
  setTimeout(() => {
    try {
      tidyCache();
      vacuumPop(false);
    } catch (err) {
      console.error('VACUUM:', err);
    }
  }, 10_000);
  setTimeout(restartOffline, 20_000); // offline copy: after the start has settled
  startUpdates(getSettings().autoUpdate, () => getSettings().skipVersion, (st) => win?.webContents.send('update:state', st));
});

// In background mode the (hidden) main window stays → only a real quit lands here
app.on('window-all-closed', () => app.quit());

let closing = false;
app.on('before-quit', (e) => {
  // a mail is still on its way: it stays in the outbox, but better ask
  if (!closing && outboxBusy()) {
    const choice = dialog.showMessageBoxSync({ type: 'question', buttons: [t('outbox.quitWait'), t('outbox.quitAnyway')], defaultId: 0, cancelId: 0, message: t('outbox.quitTitle'), detail: t('outbox.quitDetail') });
    if (choice === 0) {
      quitting = false;
      return e.preventDefault();
    }
  }
  quitting = true;
  if (closing) return;
  e.preventDefault();
  closing = true;
  flushWinState();
  flushLog();
  closeAll().finally(() => {
    closeCache();
    closePopStore();
    closeLocal();
    stopAi();
    app.quit();
  });
});
