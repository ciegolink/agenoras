// Updates from the GitHub releases (electron-builder uploads latest*.yml with every release).
// Looked for once at start; a new version is announced once in a small window (update, later, skip this
// version). Otherwise only on request in "About Agenoras". Nothing is downloaded without asking.
// Windows, macOS and the AppImage install it themselves; the .deb needs root, so there the
// release page opens. Drafts are not seen: users get a version only once its release is published.
import { app, shell } from 'electron';
import { autoUpdater } from 'electron-updater';

export interface UpdateState {
  state: 'off' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error';
  version?: string; // the new version
  percent?: number;
  error?: string;
  self?: boolean; // installs itself (otherwise: download page)
  announce?: boolean; // found at start and not skipped: show the window once
}

const RELEASES = 'https://github.com/ciegolink/agenoras/releases/latest';

// installs itself: packaged, and on Linux only as AppImage
const selfUpdate = () => app.isPackaged && (process.platform !== 'linux' || !!process.env.APPIMAGE);

let state: UpdateState = { state: app.isPackaged ? 'idle' : 'off', self: selfUpdate() };
let notify: (s: UpdateState) => void = () => {};
let skipped = () => '';
let atStart = false;
let wired = false;

export const updateState = (): UpdateState => ({ ...state });

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  notify(updateState());
}

function wire(): void {
  if (wired) return;
  wired = true;
  autoUpdater.autoDownload = false; // only after "Update"
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: undefined, announce: false }));
  autoUpdater.on('update-not-available', () => set({ state: 'none' }));
  autoUpdater.on('update-available', (info) => set({ state: 'available', version: info.version, announce: atStart && info.version !== skipped() }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent), announce: false }));
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version, announce: false }));
  autoUpdater.on('error', (err) => set({ state: 'error', error: String(err?.message ?? err).split('\n')[0].slice(0, 200), announce: false }));
}

function check(start: boolean): void {
  if (!app.isPackaged) return set({ state: 'off' }); // running from the source: nothing to update
  wire();
  atStart = start;
  autoUpdater.checkForUpdates().catch(() => {}); // reported through the 'error' event
}

// "Look for updates" in About
export const checkForUpdates = () => check(false);

// At start (if switched on), once; skippedVersion = "Skip this version" from before
export function startUpdates(on: boolean, skippedVersion: () => string, onState: (s: UpdateState) => void): void {
  notify = onState;
  skipped = skippedVersion;
  if (on && app.isPackaged) setTimeout(() => check(true), 30_000); // after the start has settled
}

// "Update": download (self-updating) or open the download page (.deb)
export function getUpdate(): void {
  if (!selfUpdate()) return void shell.openExternal(RELEASES);
  if (state.state === 'available') {
    set({ state: 'downloading', percent: 0, announce: false });
    autoUpdater.downloadUpdate().catch(() => {});
  }
}

// "Restart now" once it is downloaded
export function installUpdate(beforeQuit: () => void): void {
  if (state.state !== 'ready') return;
  beforeQuit();
  autoUpdater.quitAndInstall();
}
