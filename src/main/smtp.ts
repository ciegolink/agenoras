import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import addressparser from 'nodemailer/lib/addressparser';
import fs from 'node:fs';
import path from 'node:path';
import { Account, getAccount, getPassword } from './accounts';
import { appendToSent, getAttachmentFiles } from './imap';
import { Identity } from './settings';
import { i18nData, t } from './i18n';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // limit of most mail servers

export interface OutgoingMail {
  identityId: string; // sender: main address or alias of an account
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html?: string; // from the editor; text is the plain-text alternative
  priority?: 'high' | 'normal' | 'low'; // sets X-Priority / Importance
  inReplyTo?: string;
  references?: string[];
  files?: string[]; // paths on the local machine
  extraAttachments?: { filename: string; content: string; contentType: string }[]; // e.g. an event as .ics (base64)
  icalEvent?: { method: string; content: string }; // invitation/reply (iMIP, text/calendar)
  forward?: { accountId: string; folder: string; uid: number; indexes: number[] }; // attachments of the original mail
  // "Individually to each": one separate mail per recipient (already personalized)
  individual?: { to: string; subject: string; text: string; html?: string }[];
}

export interface SendResult {
  sent: number;
  failed: { to: string; message: string }[];
}

interface SmtpCfg {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  user: string;
}

function transport(cfg: SmtpCfg, pass: string) {
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure, // false → STARTTLS
    auth: { user: cfg.user, pass },
  });
}

export async function testSmtp(cfg: SmtpCfg, pass: string): Promise<void> {
  await transport(cfg, pass).verify();
}

// Accepts "a@b.ch", "Name <a@b.ch>" and lists separated by , or ;
function addresses(list: string[]): { name: string; address: string }[] {
  const out: { name: string; address: string }[] = [];
  const walk = (items: ReturnType<typeof addressparser>) => {
    for (const a of items) {
      if ('group' in a && a.group) walk(a.group);
      else if ('address' in a && a.address) out.push({ name: a.name || '', address: a.address });
    }
  };
  for (const entry of list ?? []) walk(addressparser(entry.replace(/;/g, ',')));
  return out;
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toLocaleString(i18nData().locale, { maximumFractionDigits: 1 });

type Attachment = { filename: string; path?: string; content?: Buffer; contentType?: string };

async function collectAttachments(mail: OutgoingMail): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  let total = 0;
  for (const file of mail.files ?? []) {
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new Error(t('err.fileNotFound', { name: path.basename(file) }));
    total += stat.size;
    attachments.push({ filename: path.basename(file), path: file });
  }
  for (const x of mail.extraAttachments ?? []) {
    const content = Buffer.from(String(x.content ?? ''), 'base64');
    total += content.length;
    attachments.push({ filename: String(x.filename || 'termin.ics'), content, contentType: String(x.contentType || 'application/octet-stream') });
  }
  if (mail.forward?.indexes.length) {
    const src = getAccount(mail.forward.accountId);
    if (!src) throw new Error(t('err.accountNotFound'));
    const files = await getAttachmentFiles(src, mail.forward.folder || 'INBOX', mail.forward.uid);
    for (const i of mail.forward.indexes) {
      const f = files[i];
      if (!f) continue;
      total += f.content.length;
      attachments.push({ filename: f.filename, content: f.content, contentType: f.contentType });
    }
  }
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new Error(t('err.attachmentsTooBig', { size: mb(total), max: mb(MAX_ATTACHMENT_BYTES) }));
  }
  return attachments;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sendMail(
  identity: Identity,
  acc: Account,
  mail: OutgoingMail,
  onProgress?: (done: number, total: number) => void,
): Promise<SendResult> {
  const attachments = await collectAttachments(mail);
  const from = { name: identity.name || acc.name, address: identity.email };
  const transporter = transport(acc, await getPassword(acc.id));

  // Build once: the same message is sent and stored in "Sent".
  // Bcc is only in the envelope, never in the header – the other recipients do not see it.
  const sendOne = async (toList: string[], ccList: string[], bccList: string[], subject: string, text: string, html?: string) => {
    const to = addresses(toList);
    const cc = addresses(ccList);
    const bcc = addresses(bccList);
    if (!to.length && !cc.length && !bcc.length) throw new Error(t('err.noRecipient'));
    const raw = await new MailComposer({
      from,
      to: to.length ? to : undefined,
      cc: cc.length ? cc : undefined,
      subject,
      text,
      html: html || undefined,
      attachDataUrls: true, // inserted images (data:) become embedded attachments
      priority: mail.priority === 'high' || mail.priority === 'low' ? mail.priority : undefined,
      inReplyTo: mail.inReplyTo || undefined,
      references: mail.references?.length ? mail.references : undefined,
      attachments,
      icalEvent: mail.icalEvent ? { method: mail.icalEvent.method, content: mail.icalEvent.content, filename: 'invite.ics' } : undefined,
    })
      .compile()
      .build();
    await transporter.sendMail({ envelope: { from: identity.email, to: [...new Set([...to, ...cc, ...bcc].map((r) => r.address))] }, raw });
    // Gmail stores sent mail itself
    if (!/gmail\.com$/i.test(acc.smtpHost)) {
      await appendToSent(acc, raw).catch((err) => console.error('Sent folder:', err?.message ?? err));
    }
  };

  try {
    if (!mail.individual?.length) {
      await sendOne(mail.to, mail.cc, mail.bcc, mail.subject, mail.text, mail.html);
      return { sent: 1, failed: [] };
    }
    const result: SendResult = { sent: 0, failed: [] };
    const total = mail.individual.length;
    for (const [i, item] of mail.individual.entries()) {
      try {
        await sendOne([item.to], [], [], item.subject, item.text, item.html);
        result.sent++;
      } catch (err) {
        result.failed.push({ to: item.to, message: (err as Error)?.message ?? String(err) });
      }
      onProgress?.(i + 1, total);
      if (i < total - 1) await pause(300); // stays below the mail servers' spam limits
    }
    return result;
  } finally {
    transporter.close();
  }
}
