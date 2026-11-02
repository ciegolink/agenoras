import crypto from 'node:crypto';
import { getKv, setKv } from './cache';
import { t } from './i18n';
import type { OutgoingMail } from './smtp';

// Outbox: mails after the undo delay, while they are handed to the server, and those that failed.
// Kept on disk so a mail is never lost – not when sending fails, not when the app is closed meanwhile.

export interface OutboxItem {
  id: string;
  accountId: string;
  from: string;
  to: string[];
  subject: string;
  status: 'sending' | 'failed';
  done: number; // "individually to each": how many are out
  total: number;
  error: string;
  created: string; // ISO
  mail: OutgoingMail;
}

export type OutboxView = Omit<OutboxItem, 'mail'> & { editable: boolean };

let items: OutboxItem[] | null = null;

function all(): OutboxItem[] {
  if (items) return items;
  // still "sending" from the last run: the app was closed in between
  items = (getKv<OutboxItem[]>('outbox') ?? []).map((x) => (x.status === 'sending' ? { ...x, status: 'failed', error: t('outbox.interrupted') } : x));
  return items;
}

const save = () => setKv('outbox', all());

export const outboxItem = (id: string) => all().find((x) => x.id === id);

// For the list in the main window: without the mail itself; mails with forwarded attachments can't be
// reopened for editing (those come from the original mail on the server)
export const outboxList = (): OutboxView[] => all().map(({ mail, ...x }) => ({ ...x, editable: !mail.forward?.indexes?.length }));

export const outboxBusy = () => all().some((x) => x.status === 'sending');

export function addOutbox(accountId: string, from: string, mail: OutgoingMail): OutboxItem {
  const to = mail.individual?.length ? mail.individual.map((x) => x.to) : [...mail.to, ...mail.cc, ...mail.bcc];
  const item: OutboxItem = {
    id: crypto.randomUUID(),
    accountId,
    from,
    to,
    subject: mail.subject,
    status: 'sending',
    done: 0,
    total: mail.individual?.length || 1,
    error: '',
    created: new Date().toISOString(),
    mail,
  };
  all().push(item);
  save();
  return item;
}

export function updateOutbox(id: string, patch: Partial<OutboxItem>): void {
  const x = outboxItem(id);
  if (!x) return;
  Object.assign(x, patch);
  save();
}

export function removeOutbox(id: string): void {
  items = all().filter((x) => x.id !== id);
  save();
}
