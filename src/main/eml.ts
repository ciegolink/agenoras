// .eml files: opened from the file manager ("Open with"), dropped on the window, or an email attached
// to an email. They are shown in the mail window like any mail under the pseudo account "eml:<id>",
// kept in memory only (not in any account, not in the cache).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { simpleParser } from 'mailparser';
import type { Account } from './accounts';
import { AttachmentFile, buildDetail, splitAttachments } from './mailparse';
import type { MailDetail } from './imap';
import { t } from './i18n';

const MAX_BYTES = 50 * 1024 * 1024;
const KEEP = 30; // the last opened ones stay available (attachments, forwarding)
const store = new Map<string, { detail: MailDetail & { fileName: string }; files: AttachmentFile[] }>();

export const isEml = (accountId: string) => typeof accountId === 'string' && accountId.startsWith('eml:');

// A .eml path among the command line arguments (Windows/Linux "Open with", also for a second instance).
// Linux file managers pass a path or a file:// URL (the desktop entry uses %U).
export function emlArg(argv: string[]): string | undefined {
  for (const a of argv.slice(1).reverse()) {
    if (a.startsWith('-')) continue;
    let p = a;
    if (/^file:\/\//i.test(a)) {
      try {
        p = fileURLToPath(a);
      } catch {
        continue;
      }
    }
    if (/\.eml$/i.test(p) && fs.statSync(p, { throwIfNoEntry: false })?.isFile()) return p;
  }
  return undefined;
}

export async function loadEml(source: Buffer, name: string): Promise<string> {
  if (source.length > MAX_BYTES) throw new Error(t('eml.tooBig'));
  const parsed = await simpleParser(source);
  const id = `eml:${crypto.randomUUID()}`;
  const detail = { ...buildDetail({ id } as Account, '', 0, parsed), fileName: name };
  store.set(id, { detail, files: splitAttachments(parsed).files });
  while (store.size > KEEP) store.delete(store.keys().next().value!);
  return id;
}

export async function loadEmlFile(file: string): Promise<string> {
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat?.isFile() || !/\.eml$/i.test(file)) throw new Error(t('eml.notFound'));
  if (stat.size > MAX_BYTES) throw new Error(t('eml.tooBig'));
  return loadEml(await fs.promises.readFile(file), path.basename(file));
}

export function emlDetail(id: string): (MailDetail & { fileName: string }) | null {
  return store.get(id)?.detail ?? null;
}

export function emlFiles(id: string): AttachmentFile[] {
  const e = store.get(id);
  if (!e) throw new Error(t('eml.gone'));
  return e.files;
}

// Subject and date of a raw mail (file names on export, the date on import); throws if it is no mail
export async function mailMeta(raw: Buffer): Promise<{ subject: string; date?: Date }> {
  const p = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  if (!p.headerLines?.length) throw new Error(t('emlio.notMail'));
  return { subject: p.subject ?? '', date: p.date };
}

// "2026-11-24 Contract draft.eml", unique in the folder
export function emlFileName(dir: string, subject: string, date?: Date): string {
  const d = date && !isNaN(date.getTime()) ? date : new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const base = `${day} ${subject.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || t('mail.noSubject')}`.trim();
  let name = `${base}.eml`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base} (${i}).eml`;
  return name;
}
