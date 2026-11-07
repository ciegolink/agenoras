// Start with the system (Settings → General). Windows and macOS keep a login item; Linux an entry in
// ~/.config/autostart. "In the background": started with --hidden, Agenoras only goes to the tray.
// Only for the installed app: started from the source it would launch the bare Electron.
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileSafe } from './files';

export const HIDDEN_ARG = '--hidden';

const desktopFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'agenoras.desktop');
// the AppImage moves with its file: start that, not the temporary mount
const exe = () => process.env.APPIMAGE || process.execPath;

export const canAutostart = () => app.isPackaged;

// macOS login items take no arguments: "in the background" is remembered in a file of its own
const macHiddenFile = () => path.join(app.getPath('userData'), 'autostart-hidden');

export function getAutostart(): { on: boolean; hidden: boolean } {
  if (process.platform === 'darwin') return { on: app.getLoginItemSettings().openAtLogin, hidden: fs.existsSync(macHiddenFile()) };
  if (process.platform === 'linux') {
    try {
      const text = fs.readFileSync(desktopFile(), 'utf8');
      return { on: true, hidden: text.includes(HIDDEN_ARG) };
    } catch {
      return { on: false, hidden: false };
    }
  }
  const s = app.getLoginItemSettings({ args: [HIDDEN_ARG] });
  const plain = app.getLoginItemSettings();
  return { on: s.openAtLogin || plain.openAtLogin, hidden: s.openAtLogin };
}

export function setAutostart(on: boolean, hidden: boolean): void {
  if (!canAutostart()) return;
  if (process.platform === 'linux') {
    const file = desktopFile();
    if (!on) return void fs.rmSync(file, { force: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const args = ['--ozone-platform=x11', ...(hidden ? [HIDDEN_ARG] : [])].join(' ');
    writeFileSafe(file, ['[Desktop Entry]', 'Type=Application', 'Name=Agenoras', `Exec="${exe()}" ${args}`, 'Icon=agenoras', 'X-GNOME-Autostart-enabled=true', 'Terminal=false', ''].join('\n'), 0o644);
    return;
  }
  if (process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: on });
    if (on && hidden) writeFileSafe(macHiddenFile(), '1');
    else fs.rmSync(macHiddenFile(), { force: true });
    return;
  }
  // Windows: both variants off first, then the one wanted (they are kept apart by their arguments)
  app.setLoginItemSettings({ openAtLogin: false });
  app.setLoginItemSettings({ openAtLogin: false, args: [HIDDEN_ARG] });
  if (on) app.setLoginItemSettings({ openAtLogin: true, ...(hidden ? { args: [HIDDEN_ARG] } : {}) });
}

// Started that way: no window, only the tray
export function startedHidden(): boolean {
  if (process.argv.includes(HIDDEN_ARG)) return true;
  if (process.platform === 'darwin') return app.getLoginItemSettings().wasOpenedAtLogin && fs.existsSync(macHiddenFile());
  return false;
}
