import { Account, getAccount, listAccounts } from './accounts';
import { deleteMessages, fetchFolder, fetchSinceUid, junkFolder, maxUid, MailSummary, moveMessages, setFlagged, setSeen } from './imap';
import { getSettings, MailRule, RuleCondition, setMailLabel } from './settings';
import { getKv, setKv } from './cache';

// Mail rules: run automatically for new mail in the inbox (also for mail that arrived
// while the app was closed) and on request for the current inbox.

function test(c: RuleCondition, m: MailSummary): boolean {
  const hay =
    c.field === 'from'
      ? `${m.from} <${m.fromAddress}>`
      : c.field === 'to'
        ? m.rcpt || `${m.toName} <${m.toAddress}>`
        : c.field === 'subject'
          ? m.subject
          : `${m.from} <${m.fromAddress}> ${m.rcpt ?? ''} ${m.subject}`;
  const h = hay.toLowerCase();
  const v = c.value.toLowerCase();
  if (c.op === 'equals') {
    // "equals": whole subject or one of the addresses/names
    if (c.field === 'subject') return m.subject.trim().toLowerCase() === v;
    return h.split(/[<>,]/).map((x) => x.trim()).includes(v);
  }
  if (c.op === 'startsWith') return (c.field === 'subject' ? m.subject.toLowerCase() : h.replace(/^\s+/, '')).startsWith(v);
  if (c.op === 'endsWith') return h.split(/[<>,\s]/).some((x) => x.endsWith(v)) || h.trimEnd().endsWith(v);
  return h.includes(v);
}

export function ruleMatches(rule: MailRule, m: MailSummary): boolean {
  if (!rule.enabled) return false;
  if (rule.accountId && rule.accountId !== m.accountId) return false;
  if (rule.hasAttachment && !m.hasAttachments) return false;
  if (!rule.conditions.length) return rule.hasAttachment; // only "with attachment"
  return rule.match === 'any' ? rule.conditions.some((c) => test(c, m)) : rule.conditions.every((c) => test(c, m));
}

export interface RuleResult {
  matched: number;
  moved: number;
}

// Apply rules to the mails of a folder (collected per action → few IMAP commands)
export async function applyRules(acc: Account, folder: string, mails: MailSummary[]): Promise<RuleResult> {
  const rules = getSettings().rules.filter((r) => r.enabled && (!r.accountId || r.accountId === acc.id));
  if (!rules.length || !mails.length) return { matched: 0, moved: 0 };
  const read = new Set<number>();
  const flag = new Set<number>();
  const labels = new Map<string, string[]>(); // category → Message-IDs
  const dest = new Map<number, string>(); // UID → target ('\\Trash' / '\\Junk' / folder)
  let matched = 0;
  for (const m of mails) {
    let hit = false;
    for (const r of rules) {
      if (!ruleMatches(r, m)) continue;
      hit = true;
      if (r.actions.read) read.add(m.uid);
      if (r.actions.flag) flag.add(m.uid);
      if (r.actions.label && m.messageId) labels.set(r.actions.label, [...(labels.get(r.actions.label) ?? []), m.messageId]);
      if (!dest.has(m.uid)) {
        if (r.actions.delete) dest.set(m.uid, '\\Trash');
        else if (r.actions.spam) dest.set(m.uid, '\\Junk');
        else if (r.actions.move && r.actions.move !== folder) dest.set(m.uid, r.actions.move);
      }
      if (r.stop) break;
    }
    if (hit) matched++;
  }
  if (read.size) await setSeen(acc, folder, [...read], true);
  if (flag.size) await setFlagged(acc, folder, [...flag], true);
  for (const [label, ids] of labels) setMailLabel(ids, label, true);
  const byTarget = new Map<string, number[]>();
  for (const [uid, target] of dest) byTarget.set(target, [...(byTarget.get(target) ?? []), uid]);
  let moved = 0;
  for (const [target, uids] of byTarget) {
    try {
      if (target === '\\Trash') await deleteMessages(acc, folder, uids);
      else if (target === '\\Junk') {
        const junk = await junkFolder(acc);
        if (junk) await moveMessages(acc, folder, uids, junk);
      } else await moveMessages(acc, folder, uids, target);
      moved += uids.length;
    } catch (err) {
      console.error('Rule – move:', (err as Error).message);
    }
  }
  return { matched, moved };
}

// New mails in the inbox since the last run (first time: only remember the starting point)
export async function runRulesForNew(acc: Account): Promise<RuleResult> {
  const key = `rules:last:${acc.id}`;
  const last = getKv<number>(key);
  const top = await maxUid(acc);
  if (last === null || last > top) {
    setKv(key, top);
    return { matched: 0, moved: 0 };
  }
  if (top <= last) return { matched: 0, moved: 0 };
  const fresh = await fetchSinceUid(acc, 'INBOX', last + 1);
  setKv(key, top);
  return applyRules(acc, 'INBOX', fresh);
}

// "Apply now": the latest mails in the inbox (one account or all)
export async function runRulesNow(accountId: string | null): Promise<RuleResult> {
  const total: RuleResult = { matched: 0, moved: 0 };
  for (const acc of listAccounts().filter((a) => !accountId || a.id === accountId)) {
    const r = await applyRules(acc, 'INBOX', await fetchFolder(acc, 'INBOX', 200));
    total.matched += r.matched;
    total.moved += r.moved;
  }
  return total;
}

export { getAccount };
