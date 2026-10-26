// One-time migration from the former internal name "ciegolink-mail" to "agenoras":
// copies the user data folder (accounts, settings, cache, sounds) before anything reads it.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const OLD_NAME = 'ciegolink-mail';

// Fixed data folder "agenoras" – the packaged app is called "Agenoras" (productName), which would
// otherwise change the folder name.
app.setPath('userData', path.join(app.getPath('appData'), 'agenoras'));

export function migrateUserData(): void {
  try {
    const target = app.getPath('userData');
    const old = path.join(app.getPath('appData'), OLD_NAME);
    if (path.resolve(old) === path.resolve(target) || !fs.existsSync(old)) return;
    const hasData = (dir: string) => ['accounts.json', 'settings.json', 'calendars.json', 'contacts.json'].some((f) => fs.existsSync(path.join(dir, f)));
    if (hasData(target) || !hasData(old)) return;
    if (!fs.existsSync(target)) fs.renameSync(old, target);
    else fs.cpSync(old, target, { recursive: true, force: false, errorOnExist: false });
  } catch (err) {
    console.error('User data migration:', (err as Error).message);
  }
}

migrateUserData();
