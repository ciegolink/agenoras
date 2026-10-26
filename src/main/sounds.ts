import { app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// Sounds for new mail: bundled ones in the project folder "sounds/" and custom ones in the user folder
// (~/.config/agenoras/sounds). Allowed: .ogg, .mp3, .wav, .m4a, .opus
// ID = "app:file.ogg" or "user:file.mp3". "builtin" is built in as well (renderer, Web Audio).

const APP_DIR = path.join(__dirname, '../../sounds');
const userDir = () => path.join(app.getPath('userData'), 'sounds');
const EXT = /\.(ogg|oga|opus|mp3|wav|m4a)$/i;
const MIME: Record<string, string> = { ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' };

export interface SoundInfo {
  id: string;
  name: string;
}

function filesIn(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => EXT.test(f) && fs.statSync(path.join(dir, f)).isFile());
  } catch {
    return [];
  }
}

const pretty = (file: string) => file.replace(EXT, '').replace(/[_-]+/g, ' ').trim();

export function listSounds(): SoundInfo[] {
  const byName = (a: string, b: string) => a.localeCompare(b, 'de', { numeric: true });
  return [
    ...filesIn(APP_DIR).sort(byName).map((f) => ({ id: `app:${f}`, name: pretty(f) })),
    ...filesIn(userDir()).sort(byName).map((f) => ({ id: `user:${f}`, name: pretty(f) })),
  ];
}

// Only files from the two folders – no outside paths
export async function soundData(id: string): Promise<string | null> {
  const m = /^(app|user):([^/\\]+)$/.exec(String(id ?? ''));
  if (!m || !EXT.test(m[2])) return null;
  const file = path.join(m[1] === 'app' ? APP_DIR : userDir(), m[2]);
  try {
    const buf = await fs.promises.readFile(file);
    if (buf.length > 3 * 1024 * 1024) return null;
    const ext = m[2].split('.').pop()!.toLowerCase();
    return `data:${MIME[ext] ?? 'audio/ogg'};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export async function openSoundFolder(): Promise<void> {
  await fs.promises.mkdir(userDir(), { recursive: true });
  await shell.openPath(userDir());
}
