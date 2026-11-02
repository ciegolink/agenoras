import fs from 'node:fs';

// Write a settings file safely: first into a temporary file next to it, then rename it over the old one.
// A crash or power cut in the middle leaves the old file intact instead of a half-written one
// (which would be read as "no settings" and then overwritten with the defaults).
export function writeFileSafe(file: string, text: string, mode?: number): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode ?? 0o600);
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
