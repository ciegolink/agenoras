import { app, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { xml2js, js2xml, ElementCompact } from 'xml-js';
import { decrypt, encrypt } from './accounts';
import { delKv, getKv, searchKv, setKv } from './cache';
import { inlineRemoteImages } from './remote';
import { t } from './i18n';
import { log } from './log';

// RSS/Atom feeds, stored in rss.json. Articles live in the cache.

export interface RssFeed {
  id: string;
  name: string;
  url: string; // the real feed URL
  siteUrl: string;
  username: string;
}

export type NewRssFeed = { name: string; url: string; username: string; password?: string };

interface StoredFeed extends RssFeed {
  password: string; // encrypted, '' = no login
}

export interface RssItem {
  key: string; // feedId|hash
  feedId: string;
  title: string;
  link: string;
  date: string; // ISO
  author: string;
  snippet: string;
  read?: boolean;
}

interface Parsed {
  title: string;
  siteUrl: string;
  items: (Omit<RssItem, 'key' | 'feedId'> & { id: string; html: string })[];
}

const MAX_FEED = 8 * 1024 * 1024;
const MAX_PER_FEED = 300;
const MAX_READ = 10000;

const file = () => path.join(app.getPath('userData'), 'rss.json');

function readAll(): StoredFeed[] {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return [];
  }
}

function writeAll(list: StoredFeed[]): void {
  fs.writeFileSync(file(), JSON.stringify(list, null, 2), 'utf8');
}

const pub = ({ password, ...f }: StoredFeed): RssFeed => f;

export function listFeeds(): RssFeed[] {
  return readAll().map(pub);
}

// Fetch
function checkUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
  } catch {
    throw new Error(t('err.invalidUrl'));
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(t('err.invalidUrl'));
  return u.toString();
}

async function fetchText(url: string, username: string, password: string): Promise<{ text: string; url: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const headers: Record<string, string> = {
      Accept: 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.5, */*;q=0.3',
      'User-Agent': `Agenoras/${app.getVersion()} (RSS reader)`,
    };
    if (username) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const res = await net.fetch(url, { signal: ctl.signal, redirect: 'follow', headers });
    if (res.status === 401 || res.status === 403) throw new Error(t('rss.errAuth'));
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FEED) throw new Error(t('rss.errTooBig'));
    // charset from header, then XML declaration, else utf-8
    const head = buf.subarray(0, 200).toString('latin1');
    const cs = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1] ?? /<\?xml[^>]*encoding=["']([\w-]+)/i.exec(head)?.[1] ?? 'utf-8';
    let text: string;
    try {
      text = new TextDecoder(cs.toLowerCase()).decode(buf);
    } catch {
      text = buf.toString('utf8');
    }
    return { text, url: res.url || url };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error(t('rss.errTimeout'));
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Parsing: RSS 2.0, RSS 1.0 and Atom
type Node = Record<string, unknown> & { _text?: unknown; _cdata?: unknown; _attributes?: Record<string, string> };

const arr = <T>(x: T | T[] | undefined | null): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const first = (n: Node | undefined, ...names: string[]): Node | undefined => {
  for (const name of names) {
    const v = n && arr(n[name] as Node | Node[])[0];
    if (v) return v;
  }
  return undefined;
};

function text(n: Node | undefined): string {
  if (!n) return '';
  const s = [...arr(n._text as string | string[]), ...arr(n._cdata as string | string[])].join('');
  if (s.trim()) return s.trim();
  // Atom type="xhtml": content is a <div> with markup
  const { _attributes, ...rest } = n;
  return Object.keys(rest).length ? js2xml(rest as ElementCompact, { compact: true }).trim() : '';
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENT[e.toLowerCase()] ?? m),
  );
const plain = (html: string) => decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const escHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

function isoDate(s: string): string {
  const d = new Date(s.trim());
  return s && !isNaN(d.getTime()) ? d.toISOString() : '';
}

function atomLink(n: Node | undefined): string {
  const links = arr(n?.link as Node | Node[]);
  const alt = links.find((l) => !l._attributes?.rel || l._attributes.rel === 'alternate') ?? links[0];
  return alt?._attributes?.href ?? '';
}

function parseFeed(xml: string): Parsed | null {
  // &nbsp; and friends break the XML parser
  const safe = xml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, '&amp;');
  let doc: Node;
  try {
    doc = xml2js(safe, { compact: true, ignoreDeclaration: true, ignoreInstruction: true, ignoreComment: true, ignoreDoctype: true }) as Node;
  } catch {
    return null;
  }
  const atom = first(doc, 'feed', 'atom:feed');
  if (atom) {
    return {
      title: plain(text(first(atom, 'title'))),
      siteUrl: atomLink(atom),
      items: arr(atom.entry as Node | Node[]).map((e) => {
        const content = first(e, 'content');
        const summary = first(e, 'summary');
        const isText = (n?: Node) => !n?._attributes?.type || n._attributes.type === 'text';
        const html = content ? (isText(content) ? escHtml(text(content)).replace(/\n/g, '<br>') : text(content)) : summary ? (isText(summary) ? escHtml(text(summary)) : text(summary)) : '';
        const link = atomLink(e);
        return {
          id: text(first(e, 'id')) || link,
          title: plain(text(first(e, 'title'))),
          link,
          date: isoDate(text(first(e, 'published', 'updated'))),
          author: plain(text(first(first(e, 'author'), 'name'))),
          snippet: plain(summary ? text(summary) : html).slice(0, 240),
          html,
        };
      }),
    };
  }
  const rss = first(doc, 'rss');
  const rdf = first(doc, 'rdf:RDF', 'RDF');
  const channel = first(rss ?? rdf, 'channel');
  if (!channel) return null;
  const items = arr((rdf ? rdf.item : channel.item) as Node | Node[]);
  return {
    title: plain(text(first(channel, 'title'))),
    siteUrl: text(first(channel, 'link')) || atomLink({ link: channel['atom:link'] } as Node),
    items: items.map((it) => {
      const desc = text(first(it, 'description'));
      const encoded = text(first(it, 'content:encoded'));
      const raw = encoded || desc;
      const html = /<[a-z][\s\S]*>/i.test(raw) ? raw : escHtml(decode(raw)).replace(/\n/g, '<br>');
      const link = text(first(it, 'link')) || (it._attributes?.['rdf:about'] ?? '');
      return {
        id: text(first(it, 'guid')) || link || text(first(it, 'title')),
        title: plain(text(first(it, 'title'))),
        link,
        date: isoDate(text(first(it, 'pubDate', 'dc:date', 'published', 'updated'))),
        author: plain(text(first(it, 'dc:creator', 'author'))),
        snippet: plain(desc || encoded).slice(0, 240),
        html,
      };
    }),
  };
}

// User gave us a website, look for the feed link in its head
function discover(html: string, base: string): string | null {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["']?alternate/i.test(tag) || !/type=["']?application\/(rss|atom|rdf)\+xml/i.test(tag)) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (href) {
      try {
        return new URL(decode(href), base).toString();
      } catch {
        /* next */
      }
    }
  }
  return null;
}

async function load(url: string, username: string, password: string): Promise<{ url: string; feed: Parsed }> {
  let res = await fetchText(url, username, password);
  let feed = parseFeed(res.text);
  if (!feed) {
    const alt = discover(res.text, res.url);
    if (alt) {
      res = await fetchText(alt, username, password);
      feed = parseFeed(res.text);
    }
  }
  if (!feed) throw new Error(t('rss.errNoFeed'));
  return { url: res.url, feed };
}

// Cache
const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const bodyKey = (key: string) => `rss.body:${key}`;
const cachedList = () => getKv<RssItem[]>('rss.items') ?? [];
const readSet = () => new Set(getKv<string[]>('rss.read') ?? []);

function store(feedId: string, feed: Parsed): void {
  const old = cachedList();
  const mine = new Map(old.filter((i) => i.feedId === feedId).map((i) => [i.key, i]));
  const now = new Date().toISOString();
  for (const p of feed.items) {
    const key = `${feedId}|${hash(p.id || p.title)}`;
    const { id, html, ...rest } = p;
    // no date in the feed: keep the first time we saw it
    mine.set(key, { ...rest, key, feedId, date: p.date || mine.get(key)?.date || now });
    setKv(bodyKey(key), html);
  }
  const sorted = [...mine.values()].sort((a, b) => b.date.localeCompare(a.date));
  delKv(sorted.slice(MAX_PER_FEED).map((i) => bodyKey(i.key)));
  setKv('rss.items', [...old.filter((i) => i.feedId !== feedId), ...sorted.slice(0, MAX_PER_FEED)]);
}

function withRead(items: RssItem[]): RssItem[] {
  const read = readSet();
  const ids = new Set(listFeeds().map((f) => f.id));
  return items.filter((i) => ids.has(i.feedId)).map((i) => ({ ...i, read: read.has(i.key) })).sort((a, b) => b.date.localeCompare(a.date));
}

export function cachedItems(): { feeds: RssFeed[]; items: RssItem[] } {
  return { feeds: listFeeds(), items: withRead(cachedList()) };
}

export async function refreshFeeds(): Promise<{ feeds: RssFeed[]; items: RssItem[]; errors: { feedId: string; message: string }[] }> {
  const all = readAll();
  const errors: { feedId: string; message: string }[] = [];
  // 4 at a time
  for (let i = 0; i < all.length; i += 4) {
    await Promise.all(
      all.slice(i, i + 4).map(async (f) => {
        try {
          const { feed } = await load(f.url, f.username, f.password ? await decrypt(f.password) : '');
          store(f.id, feed);
        } catch (err) {
          errors.push({ feedId: f.id, message: (err as Error).message });
          log('error', 'RSS', f.name, (err as Error).message);
        }
      }),
    );
  }
  return { ...cachedItems(), errors };
}

// Full text search incl. article body
export function searchItems(query: string): RssItem[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const inBody = new Set(searchKv('rss.body:', query.trim()));
  return withRead(cachedList()).filter((i) => inBody.has(i.key) || `${i.title} ${i.author} ${i.snippet}`.toLowerCase().includes(q));
}

export function setRead(keys: string[], read: boolean): void {
  const set = readSet();
  for (const k of keys) {
    if (read) set.add(k);
    else set.delete(k);
  }
  setKv('rss.read', [...set].slice(-MAX_READ));
}

// Article HTML with absolute links and embedded images (CSP blocks remote ones)
const articles = new Map<string, string>();

export async function article(key: string): Promise<string> {
  const hit = articles.get(key);
  if (hit !== undefined) return hit;
  const item = cachedList().find((i) => i.key === key);
  const base = item?.link || readAll().find((f) => f.id === item?.feedId)?.url || '';
  let html = getKv<string>(bodyKey(key)) ?? '';
  if (base) {
    html = html.replace(/(\s(?:src|href)\s*=\s*)(["'])([^"']*)\2/gi, (m, pre: string, q: string, v: string) => {
      if (/^(https?:|mailto:|data:|#)/i.test(v)) return m;
      try {
        return `${pre}${q}${new URL(decode(v), base).toString()}${q}`;
      } catch {
        return m;
      }
    });
  }
  html = await inlineRemoteImages(html);
  articles.set(key, html);
  if (articles.size > 30) articles.delete(articles.keys().next().value!);
  return html;
}

// Add, edit, remove
export async function addFeed(input: NewRssFeed): Promise<RssFeed> {
  const url = checkUrl(String(input?.url ?? '').trim());
  const username = String(input.username ?? '').trim();
  const res = await load(url, username, input.password ?? '');
  const pass = username ? await encrypt(input.password ?? '') : '';
  const all = readAll();
  if (all.some((f) => f.url === res.url)) throw new Error(t('rss.errExists'));
  const f: StoredFeed = {
    id: crypto.randomUUID(),
    name: String(input.name ?? '').trim() || res.feed.title || new URL(res.url).hostname,
    url: res.url,
    siteUrl: res.feed.siteUrl,
    username,
    password: pass,
  };
  all.push(f);
  writeAll(all);
  store(f.id, res.feed);
  return pub(f);
}

// empty password = keep the current one
export async function updateFeed(id: string, input: NewRssFeed): Promise<RssFeed> {
  const cur = readAll().find((f) => f.id === id);
  if (!cur) throw new Error(t('err.accountNotFound'));
  const url = checkUrl(String(input?.url ?? '').trim());
  const username = String(input.username ?? '').trim();
  const password = input.password || (cur.password && username ? await decrypt(cur.password) : '');
  const res = await load(url, username, password);
  const pass = username ? await encrypt(password) : '';
  const all = readAll();
  const i = all.findIndex((f) => f.id === id);
  if (i === -1) throw new Error(t('err.accountNotFound'));
  all[i] = { ...all[i], name: String(input.name ?? '').trim() || res.feed.title || all[i].name, url: res.url, siteUrl: res.feed.siteUrl, username, password: pass };
  writeAll(all);
  store(id, res.feed);
  return pub(all[i]);
}

export function removeFeed(id: string): void {
  writeAll(readAll().filter((f) => f.id !== id));
  const old = cachedList();
  const gone = old.filter((i) => i.feedId === id).map((i) => i.key);
  delKv(gone.map(bodyKey));
  setKv('rss.items', old.filter((i) => i.feedId !== id));
  const read = readSet();
  gone.forEach((k) => read.delete(k));
  setKv('rss.read', [...read]);
}
