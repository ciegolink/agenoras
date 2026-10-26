import { app, BrowserWindow, Rectangle, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// Remember window size/position and "maximized" (window-state.json in the user folder).
// main = main window (with position), compose/mailview = size only.

export interface WinState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

const file = () => path.join(app.getPath('userData'), 'window-state.json');

function readAll(): Record<string, WinState> {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

let cache: Record<string, WinState> | null = null;
let saveTimer: NodeJS.Timeout | undefined;

function save(kind: string, s: WinState): void {
  cache ??= readAll();
  cache[kind] = s;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8');
    } catch {
      /* not critical */
    }
  }, 400);
}

// Is the window (still) on a connected screen? Otherwise drop the position.
function visible(b: Rectangle): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x + 100 < a.x + a.width && b.x + b.width - 100 > a.x && b.y >= a.y - 20 && b.y + 40 < a.y + a.height;
  });
}

export function loadWinState(kind: string, def: { width: number; height: number }): WinState {
  cache ??= readAll();
  const s = cache[kind];
  if (!s || !(s.width > 200) || !(s.height > 200)) return { ...def };
  const out: WinState = { width: Math.round(s.width), height: Math.round(s.height), maximized: !!s.maximized };
  if (typeof s.x === 'number' && typeof s.y === 'number' && visible({ x: s.x, y: s.y, width: out.width, height: out.height })) {
    out.x = Math.round(s.x);
    out.y = Math.round(s.y);
  }
  return out;
}

export function trackWinState(w: BrowserWindow, kind: string, withPosition: boolean): void {
  const store = () => {
    if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return;
    const maximized = w.isMaximized();
    const b = w.getNormalBounds(); // size before maximizing
    save(kind, withPosition ? { ...b, maximized } : { width: b.width, height: b.height, maximized });
  };
  w.on('resize', store);
  w.on('move', store);
  w.on('maximize', store);
  w.on('unmaximize', store);
  w.on('close', store);
}

export function flushWinState(): void {
  if (!cache || !saveTimer) return;
  clearTimeout(saveTimer);
  try {
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}
