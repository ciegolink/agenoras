// Turning a raw mail (RFC 822 source) into what the app shows – shared by IMAP and the local POP3 store.
import { AddressObject, ParsedMail } from 'mailparser';
import type { Account } from './accounts';
import { t } from './i18n';
import { parseInvite } from './invites';
import type { MailDetail, MailSummary, Priority } from './imap';

export function addressList(a?: AddressObject | AddressObject[]): string[] {
  const objs = Array.isArray(a) ? a : a ? [a] : [];
  return objs.flatMap((o) => o.value.map((v) => v.address || '')).filter(Boolean);
}

// Priority from X-Priority (1–2 high, 4–5 low), Importance or Priority
export function parsePriority(headers: string): Priority {
  const h = headers.toLowerCase();
  const xp = /^x-priority:\s*(\d)/m.exec(h)?.[1];
  if (xp) return Number(xp) <= 2 ? 'high' : Number(xp) >= 4 ? 'low' : 'normal';
  const imp = /^(?:importance|priority):\s*(\w+)/m.exec(h)?.[1] ?? '';
  if (/^(high|urgent)/.test(imp)) return 'high';
  if (/^(low|non-urgent)/.test(imp)) return 'low';
  return 'normal';
}

const priorityOf = (parsed: ParsedMail) =>
  parsePriority(
    ['x-priority', 'importance', 'priority']
      .map((h) => (parsed.headers.has(h) ? `${h}: ${String(parsed.headers.get(h))}` : ''))
      .join('\n'),
  );

export interface AttachmentFile {
  filename: string;
  contentType: string;
  content: Buffer;
}

// Embedded images (cid:) go into the HTML as data URIs, everything else is a real attachment.
// The attachment order is the same everywhere → the index identifies an attachment.
export function splitAttachments(parsed: ParsedMail): { html: string | null; files: AttachmentFile[] } {
  let html = parsed.html || null;
  const files: AttachmentFile[] = [];
  for (const att of parsed.attachments) {
    if (att.cid && html && html.includes(`cid:${att.cid}`)) {
      const uri = `data:${att.contentType};base64,${att.content.toString('base64')}`;
      html = html.split(`cid:${att.cid}`).join(uri);
    } else {
      files.push({ filename: att.filename || t('file.attachment'), contentType: att.contentType, content: att.content });
    }
  }
  return { html, files };
}

export function inviteIcs(parsed: ParsedMail): string | null {
  const cal = parsed.attachments.find((x) => /^(text\/calendar|application\/ics)/i.test(x.contentType) || /\.ics$/i.test(x.filename ?? ''));
  return cal ? cal.content.toString('utf8') : null;
}

export function buildDetail(acc: Account, folder: string, uid: number, parsed: ParsedMail): MailDetail {
  const { html, files } = splitAttachments(parsed);
  const ics = inviteIcs(parsed);
  const from = parsed.from?.value[0];
  const to = Array.isArray(parsed.to) ? parsed.to.map((x) => x.text).join(', ') : parsed.to?.text ?? '';
  return {
    accountId: acc.id,
    folder,
    uid,
    subject: parsed.subject || '',
    fromName: from?.name || from?.address || '',
    fromAddress: from?.address || '',
    to,
    toList: addressList(parsed.to),
    ccList: addressList(parsed.cc),
    replyTo: parsed.replyTo?.value[0]?.address || '',
    messageId: parsed.messageId || '',
    references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [],
    date: (parsed.date ?? new Date()).toISOString(),
    html,
    text: parsed.text || '',
    priority: priorityOf(parsed),
    attachments: files.map((f) => ({ filename: f.filename, size: f.content.length, contentType: f.contentType })),
    invite: ics ? parseInvite(ics) : null,
  };
}

// List entry from a fully parsed mail (POP3: there is no server-side envelope)
export function summaryFromParsed(acc: Account, folder: string, uid: number, parsed: ParsedMail): MailSummary {
  const from = parsed.from?.value[0];
  const toObjs = [parsed.to, parsed.cc].flatMap((a) => (Array.isArray(a) ? a : a ? [a] : [])).flatMap((o) => o.value);
  const to = toObjs[0];
  return {
    accountId: acc.id,
    folder,
    uid,
    from: from?.name || from?.address || '',
    fromAddress: from?.address || '',
    toName: to?.name || to?.address || '',
    toAddress: to?.address || '',
    rcpt: toObjs.map((a) => `${a.name ?? ''} <${a.address ?? ''}>`).join(', '),
    flagged: false,
    subject: parsed.subject || '',
    date: (parsed.date ?? new Date()).toISOString(),
    seen: false,
    hasAttachments: splitAttachments(parsed).files.length > 0,
    priority: priorityOf(parsed),
    messageId: parsed.messageId || '',
    inReplyTo: parsed.inReplyTo || '',
  };
}
