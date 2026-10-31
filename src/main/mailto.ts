// mailto: links (RFC 6068) → options for a new compose window.
// "+" stays a plus (addresses like name+tag@…), attachments ("attach=") are ignored on purpose.

export interface MailtoOpts {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const addresses = (s: string) =>
  decode(s)
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);

export function parseMailto(url: string): MailtoOpts | null {
  if (!/^mailto:/i.test(url)) return null;
  const rest = url.slice('mailto:'.length);
  const q = rest.indexOf('?');
  const out: MailtoOpts = { to: addresses(q < 0 ? rest : rest.slice(0, q)), cc: [], bcc: [], subject: '', body: '' };
  if (q < 0) return out;
  for (const pair of rest.slice(q + 1).split('&')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const key = pair.slice(0, i).toLowerCase();
    const value = pair.slice(i + 1);
    if (key === 'to') out.to.push(...addresses(value));
    else if (key === 'cc') out.cc.push(...addresses(value));
    else if (key === 'bcc') out.bcc.push(...addresses(value));
    else if (key === 'subject') out.subject = decode(value).slice(0, 1000);
    else if (key === 'body') out.body = decode(value).slice(0, 100_000);
  }
  return out;
}

// Windows and Linux pass the link as a command line argument
export const mailtoArg = (argv: string[]) => argv.find((a) => /^mailto:/i.test(a));
