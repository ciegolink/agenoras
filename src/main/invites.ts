import ICAL from 'ical.js';
import { Account, getAccount } from './accounts';
import { getSettings, Identity } from './settings';
import { sendMail } from './smtp';
import { i18nData, t } from './i18n';

// Meeting invitations by mail (iMIP): send invitation (REQUEST), replies (REPLY), cancellations (CANCEL)

export interface Person {
  email: string;
  name: string;
  partstat?: string; // NEEDS-ACTION | ACCEPTED | TENTATIVE | DECLINED
}

export interface InviteInfo {
  method: string; // REQUEST | REPLY | CANCEL | PUBLISH
  uid: string;
  sequence: number;
  summary: string;
  location: string;
  description: string;
  start: string; // ISO or YYYY-MM-DD
  end: string;
  allDay: boolean;
  recurring: boolean;
  organizer: Person | null;
  attendees: Person[];
}

const mailto = (v: unknown) => String(v ?? '').replace(/^mailto:/i, '').trim();

export function readPeople(v: ICAL.Component): { organizer: Person | null; attendees: Person[] } {
  const org = v.getFirstProperty('organizer');
  return {
    organizer: org ? { email: mailto(org.getFirstValue()), name: String(org.getParameter('cn') ?? '') } : null,
    attendees: v.getAllProperties('attendee').map((p) => ({
      email: mailto(p.getFirstValue()),
      name: String(p.getParameter('cn') ?? ''),
      partstat: String(p.getParameter('partstat') ?? 'NEEDS-ACTION').toUpperCase(),
    })),
  };
}

const out = (tm: ICAL.Time) => (tm.isDate ? tm.toString() : tm.toJSDate().toISOString());

export function parseInvite(ics: string): InviteInfo | null {
  try {
    const comp = new ICAL.Component(ICAL.parse(ics));
    for (const tz of comp.getAllSubcomponents('vtimezone')) {
      const z = new ICAL.Timezone(tz);
      if (z.tzid && !ICAL.TimezoneService.has(z.tzid)) ICAL.TimezoneService.register(z);
    }
    const v = comp.getAllSubcomponents('vevent').find((x) => !x.hasProperty('recurrence-id')) ?? comp.getFirstSubcomponent('vevent');
    if (!v) return null;
    const ev = new ICAL.Event(v);
    return {
      method: String(comp.getFirstPropertyValue('method') ?? 'PUBLISH').toUpperCase(),
      uid: ev.uid,
      sequence: Number(v.getFirstPropertyValue('sequence') ?? 0),
      summary: ev.summary || '',
      location: ev.location || '',
      description: ev.description || '',
      start: ev.startDate ? out(ev.startDate) : '',
      end: ev.endDate ? out(ev.endDate) : ev.startDate ? out(ev.startDate) : '',
      allDay: !!ev.startDate?.isDate,
      recurring: ev.isRecurring(),
      ...readPeople(v),
    };
  } catch {
    return null;
  }
}

// Sender matching an address (alias), otherwise the account's main address
export function identityFor(accountId: string, emails: string[]): Identity | undefined {
  const want = new Set(emails.map((e) => e.toLowerCase()));
  const ids = getSettings().identities;
  return ids.find((i) => i.accountId === accountId && want.has(i.email.toLowerCase())) ?? ids.find((i) => want.has(i.email.toLowerCase())) ?? ids.find((i) => i.accountId === accountId && i.primary);
}

function when(info: { start: string; end: string; allDay: boolean }): string {
  const loc = i18nData().locale;
  if (info.allDay) return new Date(`${info.start}T12:00`).toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const s = new Date(info.start);
  const e = new Date(info.end);
  return `${s.toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${s.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })}–${e.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })}`;
}

// Calendar object → iMIP with METHOD (without foreign exceptions; time zones are kept)
export function withMethod(ics: string, method: string, patch?: (v: ICAL.Component) => void): string {
  const comp = new ICAL.Component(ICAL.parse(ics));
  comp.updatePropertyWithValue('method', method);
  if (!comp.hasProperty('prodid')) comp.updatePropertyWithValue('prodid', '-//Agenoras//Agenoras//DE');
  for (const v of comp.getAllSubcomponents('vevent')) {
    v.updatePropertyWithValue('dtstamp', ICAL.Time.now());
    for (const p of v.getAllProperties('attendee')) p.removeParameter('schedule-agent'); // only for the own server
    patch?.(v);
  }
  return comp.toString();
}

async function sendIcal(identity: Identity, acc: Account, to: Person[], subject: string, text: string, method: string, ics: string): Promise<void> {
  await sendMail(identity, acc, {
    identityId: identity.id,
    to: to.map((p) => (p.name ? `"${p.name.replace(/"/g, '')}" <${p.email}>` : p.email)),
    cc: [],
    bcc: [],
    subject,
    text,
    icalEvent: { method, content: ics },
  });
}

// Invitation to all attendees (except the organizer)
export async function sendInvitations(identityId: string, ics: string, cancel = false): Promise<number> {
  const identity = getSettings().identities.find((i) => i.id === identityId);
  const acc = identity && getAccount(identity.accountId);
  if (!identity || !acc) throw new Error(t('err.senderNotFound'));
  const info = parseInvite(ics);
  if (!info) return 0;
  const to = info.attendees.filter((a) => a.email.toLowerCase() !== identity.email.toLowerCase());
  if (!to.length) return 0;
  const method = cancel ? 'CANCEL' : 'REQUEST';
  const body = [
    info.summary,
    when(info),
    info.location ? `${t('cal.location')}: ${info.location}` : '',
    '',
    info.description,
    '',
    `${t('invite.participants')}: ${info.attendees.map((a) => a.name || a.email).join(', ')}`,
  ]
    .filter((l, i, arr) => l || (i > 0 && arr[i - 1]))
    .join('\n');
  const subject = `${t(cancel ? 'invite.subjectCancel' : 'invite.subject')}: ${info.summary} @ ${when(info)}`;
  await sendIcal(identity, acc, to, subject, body, method, withMethod(ics, method, cancel ? (v) => v.updatePropertyWithValue('status', 'CANCELLED') : undefined));
  return to.length;
}

// Reply to an invitation, sent to the organizer (REPLY)
export async function sendReply(accountId: string, ics: string, partstat: 'ACCEPTED' | 'TENTATIVE' | 'DECLINED'): Promise<{ me: string }> {
  const info = parseInvite(ics);
  if (!info?.organizer) throw new Error(t('invite.noOrganizer'));
  const acc = getAccount(accountId);
  if (!acc) throw new Error(t('err.accountNotFound'));
  const myAddrs = getSettings().identities.filter((i) => i.accountId === accountId).map((i) => i.email.toLowerCase());
  const meAtt = info.attendees.find((a) => myAddrs.includes(a.email.toLowerCase()));
  const identity = identityFor(accountId, meAtt ? [meAtt.email] : [acc.email]);
  if (!identity) throw new Error(t('err.senderNotFound'));
  const me = meAtt?.email ?? identity.email;
  const reply = withMethod(ics, 'REPLY', (v) => {
    // only report back the own participation
    v.removeAllProperties('attendee');
    const p = new ICAL.Property('attendee');
    p.setValue(`mailto:${me}`);
    p.setParameter('partstat', partstat);
    if (identity.name) p.setParameter('cn', identity.name);
    v.addProperty(p);
    for (const k of ['description', 'valarm']) v.removeAllProperties(k);
  });
  const subject = `${t(`invite.subject.${partstat}`)}: ${info.summary}`;
  await sendIcal(identity, acc, [info.organizer], subject, `${t(`invite.text.${partstat}`, { name: identity.name || me })}\n\n${info.summary}\n${when(info)}`, 'REPLY', reply);
  return { me };
}
