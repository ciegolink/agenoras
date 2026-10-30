import { net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getKv, setKv } from './cache';
import { cachedContacts } from './carddav';

// Everything that fetches content from foreign web servers: sender icons (favicons) and
// – only on request – external images in HTML mails. The mail itself never loads anything directly;
// images are fetched here and inserted as data: URLs (the strict CSP stays in place).

const MAX_IMAGE = 3 * 1024 * 1024;
const MAX_TOTAL = 15 * 1024 * 1024;
const MAX_ICON = 300 * 1024;

async function fetchBytes(url: string, max: number, timeoutMs = 8000): Promise<{ type: string; data: Buffer; url: string } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { Accept: 'image/*,text/html;q=0.8,*/*;q=0.5' } });
    if (!res.ok || !res.body) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len > max) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        ctl.abort();
        return null;
      }
      chunks.push(value);
    }
    return { type: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), data: Buffer.concat(chunks), url: res.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Detect the image type from the content (servers often send wrong content types)
function sniffImage(buf: Buffer, declared: string): string | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  const head = buf.subarray(0, 300).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return declared.startsWith('image/') && declared !== 'image/svg+xml' ? declared : null;
}

const toDataUrl = (type: string, buf: Buffer) => `data:${type};base64,${buf.toString('base64')}`;

// External images in mails
const IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["']?)(https?:\/\/[^"'\s>]+)\2/gi;
const CSS_URL = /url\(\s*(["']?)(https?:\/\/[^"')\s]+)\1\s*\)/gi;
const BG_ATTR = /(\bbackground\s*=\s*)(["']?)(https?:\/\/[^"'\s>]+)\2/gi;

export function hasRemoteImages(html: string | null): boolean {
  if (!html) return false;
  return new RegExp(IMG_SRC.source, 'i').test(html) || new RegExp(CSS_URL.source, 'i').test(html) || new RegExp(BG_ATTR.source, 'i').test(html);
}

const decodeEntities = (u: string) => u.replace(/&amp;/g, '&');

export async function inlineRemoteImages(html: string): Promise<string> {
  const urls = new Set<string>();
  for (const m of html.matchAll(IMG_SRC)) urls.add(m[3]);
  for (const m of html.matchAll(CSS_URL)) urls.add(m[2]);
  for (const m of html.matchAll(BG_ATTR)) urls.add(m[3]);
  const list = [...urls].slice(0, 80);
  const map = new Map<string, string>();
  let total = 0;
  // 6 at a time
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(
      list.slice(i, i + 6).map(async (u) => {
        const r = await fetchBytes(decodeEntities(u), MAX_IMAGE);
        if (!r) return;
        const type = sniffImage(r.data, r.type);
        if (!type || total + r.data.length > MAX_TOTAL) return;
        total += r.data.length;
        map.set(u, toDataUrl(type, r.data));
      }),
    );
  }
  return html
    .replace(/\ssrcset\s*=\s*(["']).*?\1/gi, '') // srcset would otherwise try to load directly
    .replace(IMG_SRC, (all, pre, q, u) => (map.has(u) ? `${pre}${q}${map.get(u)}${q}` : all))
    .replace(CSS_URL, (all, q, u) => (map.has(u) ? `url(${q}${map.get(u)}${q})` : all))
    .replace(BG_ATTR, (all, pre, q, u) => (map.has(u) ? `${pre}${q}${map.get(u)}${q}` : all));
}

// Signature from an HTML file: embed local and external images (sent as inline attachments)
export async function loadSignatureFile(file: string): Promise<string> {
  const stat = await fs.promises.stat(file);
  if (stat.size > 2 * 1024 * 1024) throw new Error('HTML > 2 MB');
  let html = await fs.promises.readFile(file, 'utf8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  if (body) html = body[1];
  const dir = path.dirname(file);
  const LOCAL = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi;
  const jobs: Promise<void>[] = [];
  const local = new Map<string, string>();
  for (const m of html.matchAll(LOCAL)) {
    const src = m[3];
    if (/^(https?:|data:|cid:)/i.test(src)) continue;
    const p = path.resolve(dir, decodeURIComponent(src.replace(/^file:\/\//i, '')));
    jobs.push(
      fs.promises
        .readFile(p)
        .then((buf) => {
          const type = sniffImage(buf, '');
          if (type && buf.length <= MAX_IMAGE) local.set(src, toDataUrl(type, buf));
        })
        .catch(() => {}),
    );
  }
  await Promise.all(jobs);
  html = html.replace(LOCAL, (all, pre, q, src) => (local.has(src) ? `${pre}${q}${local.get(src)}${q}` : all));
  return inlineRemoteImages(html);
}

// Sender icons: contact photo → website favicon → (renderer: initials)
// For freemail addresses the favicon only shows the provider – initials are better then
const FREEMAIL = new Set(
  (
    'gmail.com googlemail.com outlook.com hotmail.com hotmail.ch live.com live.ch msn.com yahoo.com yahoo.de yahoo.fr ymail.com icloud.com me.com mac.com ' +
    'gmx.ch gmx.net gmx.de gmx.at gmx.com web.de bluewin.ch sunrise.ch hispeed.ch swissonline.ch mail.ch proton.me protonmail.com protonmail.ch ' +
    'aol.com t-online.de freenet.de posteo.de mailbox.org yandex.com yandex.ru zoho.com tutanota.com tuta.io orange.fr free.fr'
  ).split(' '),
);

const SECOND_LEVEL = new Set(['co', 'com', 'ac', 'gov', 'org', 'net', 'edu']);

function siteOf(email: string): string | null {
  let d = email.split('@')[1]?.toLowerCase().trim();
  if (!d || !d.includes('.') || FREEMAIL.has(d)) return null;
  const parts = d.split('.');
  if (parts.length > 2) d = parts.slice(SECOND_LEVEL.has(parts[parts.length - 2]) ? -3 : -2).join('.');
  return FREEMAIL.has(d) ? null : d;
}

const ICON_TTL = 14 * 24 * 3600 * 1000; // two weeks, also for "no icon"
const inflight = new Map<string, Promise<string | null>>();

function iconLinks(html: string, base: string): string[] {
  const out: { url: string; score: number }[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    if (!/\bicon\b|apple-touch-icon/.test(rel)) continue;
    const href = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!href) continue;
    const size = Number(/\bsizes\s*=\s*["']?(\d+)/i.exec(tag)?.[1] ?? 0);
    const score = (rel.includes('apple-touch-icon') ? 1000 : 0) + Math.min(size, 512) + (/\.svg(\?|$)/i.test(href) ? 300 : 0);
    try {
      out.push({ url: new URL(decodeEntities(href), base).href, score });
    } catch {
      /* invalid */
    }
  }
  return out.sort((a, b) => b.score - a.score).map((x) => x.url);
}

async function fetchIcon(site: string): Promise<string | null> {
  for (const host of [site, `www.${site}`]) {
    const page = await fetchBytes(`https://${host}/`, 1024 * 1024, 6000);
    const candidates = page && page.type.includes('html') ? iconLinks(page.data.toString('utf8'), page.url) : [];
    candidates.push(`https://${host}/apple-touch-icon.png`, `https://${host}/favicon.ico`);
    for (const url of candidates.slice(0, 5)) {
      const r = await fetchBytes(url, MAX_ICON, 6000);
      const type = r && sniffImage(r.data, r.type);
      if (r && type && r.data.length > 100) return toDataUrl(type, r.data);
    }
    if (page) break; // Website reachable but without an icon → do not try www. again
  }
  return null;
}

function siteIcon(site: string): Promise<string | null> {
  const cached = getKv<{ data: string | null; ts: number }>(`icon:${site}`);
  if (cached && Date.now() - cached.ts < ICON_TTL) return Promise.resolve(cached.data);
  const running = inflight.get(site);
  if (running) return running;
  const job = fetchIcon(site)
    .then((data) => {
      setKv(`icon:${site}`, { data, ts: Date.now() });
      return data;
    })
    .finally(() => inflight.delete(site));
  inflight.set(site, job);
  return job;
}

export async function getAvatars(emails: string[]): Promise<Record<string, string | null>> {
  const photos = new Map<string, string>();
  for (const c of cachedContacts().contacts) {
    if (!c.photo) continue;
    for (const e of c.emails) photos.set(e.value.toLowerCase(), c.photo);
  }
  const out: Record<string, string | null> = {};
  const list = [...new Set(emails.map((e) => String(e).toLowerCase()).filter(Boolean))].slice(0, 200);
  // at most 4 websites at a time
  for (let i = 0; i < list.length; i += 4) {
    await Promise.all(
      list.slice(i, i + 4).map(async (email) => {
        const photo = photos.get(email);
        if (photo) return void (out[email] = 'photo:' + photo); // contact photo: show round and filling
        const site = siteOf(email);
        out[email] = site ? await siteIcon(site) : null;
      }),
    );
  }
  return out;
}
