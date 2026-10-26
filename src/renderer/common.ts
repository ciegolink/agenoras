// Shared helpers for the main window and the compose window.

const el = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---------- Language (strings from lang/<language>.json, delivered by the main process) ----------

const I18N = window.i18n ?? { lang: 'en', locale: 'en-GB', strings: {} };
const LOCALE = I18N.locale;
// First day of the week (1 = Monday, 0 = Sunday, 6 = Saturday) – Settings → Appearance
let WEEK_START = I18N.weekStart ?? 1;

// t('key') → text; {name} placeholders are replaced. If a key is missing, the key itself is shown.
function t(key: string, vars?: Record<string, string | number>): string {
  const s = I18N.strings[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

// Static texts in HTML: data-i18n (text), data-i18n-html (with <em>), -ph, -title, -aria
function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((e) => (e.textContent = t(e.dataset.i18n!)));
  root.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach((e) => (e.innerHTML = t(e.dataset.i18nHtml!)));
  root.querySelectorAll<HTMLElement>('[data-i18n-ph]').forEach((e) => e.setAttribute('placeholder', t(e.dataset.i18nPh!)));
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((e) => (e.title = t(e.dataset.i18nTitle!)));
  root.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((e) => e.setAttribute('aria-label', t(e.dataset.i18nAria!)));
}

document.documentElement.lang = I18N.lang;

// ---------- Custom title bar: move (CSS), minimize, maximize, close ----------

const WIN_ICONS = {
  min: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5h8" stroke="currentColor" stroke-width="1.2"/></svg>',
  max: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  restore:
    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="3" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3 3V1h6v6H7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  close: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.2"/></svg>',
};

// Logo in the title bar: build/logo.png if present (otherwise the "Agenoras." wordmark)
function setupLogo(): void {
  const logo = document.querySelector<HTMLImageElement>('.brand-logo');
  if (!logo) return;
  const img = new Image();
  img.onload = () => {
    logo.src = img.src;
    logo.hidden = false;
    document.body.classList.add('has-logo');
  };
  img.src = '../../build/logo.png';
}

function setupTitlebar(): void {
  setupLogo();
  document.body.classList.add(`platform-${window.api.platform}`);
  const ctl = document.querySelector<HTMLElement>('.win-ctls');
  if (!ctl) return;
  ctl.innerHTML = `
    <button type="button" class="win-btn" data-win="min" aria-label="${esc(t('win.minimize'))}" title="${esc(t('win.minimize'))}">${WIN_ICONS.min}</button>
    <button type="button" class="win-btn" data-win="max" aria-label="${esc(t('win.maximize'))}" title="${esc(t('win.maximize'))}">${WIN_ICONS.max}</button>
    <button type="button" class="win-btn close" data-win="close" aria-label="${esc(t('win.close'))}" title="${esc(t('win.close'))}">${WIN_ICONS.close}</button>`;
  ctl.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-win]')?.dataset.win;
    if (action === 'min') window.api.win.minimize();
    else if (action === 'max') window.api.win.toggleMaximize();
    else if (action === 'close') window.api.win.close();
  });
  const setState = (maximized: boolean) => {
    document.body.classList.toggle('maximized', maximized);
    const b = ctl.querySelector<HTMLElement>('[data-win="max"]')!;
    const label = t(maximized ? 'win.restore' : 'win.maximize');
    b.innerHTML = maximized ? WIN_ICONS.restore : WIN_ICONS.max;
    b.title = label;
    b.setAttribute('aria-label', label);
  };
  window.api.win.onState(setState);
  window.api.win.isMaximized().then(setState).catch(() => {});
  // Double-click on the empty title bar = maximize/restore
  document.querySelector('.titlebar')?.addEventListener('dblclick', (e) => {
    if (!(e.target as HTMLElement).closest('button, input, select, a')) window.api.win.toggleMaximize();
  });
}

applyI18n();
setupTitlebar();

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function fmtShort(iso: string): string {
  const d = new Date(iso);
  if (d.toDateString() === new Date().toDateString()) {
    return d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' });
}

function fmtLong(iso: string): string {
  return new Date(iso).toLocaleString(LOCALE, { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} MB`;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
}

function textToHtml(text: string): string {
  const paras = text.replace(/\r/g, '').trim().split(/\n{2,}/);
  return paras.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('') || '<p><br></p>';
}

// ---------- File icons for attachments ----------

const FILE_COLORS: [RegExp, string][] = [
  [/^pdf$/, '#E0574B'],
  [/^(docx?|odt|rtf|pages|txt|md)$/, '#7FA6CF'],
  [/^(xlsx?|xlsm|csv|ods|numbers)$/, '#4DB37A'],
  [/^(pptx?|key|odp)$/, '#E0A458'],
  [/^(jpe?g|png|gif|webp|heic|svg|bmp|tiff?)$/, '#2BA89F'],
  [/^(zip|rar|7z|tar|gz|tgz)$/, '#C1C8BE'],
  [/^(mp3|wav|m4a|aac|flac|mp4|mov|avi|mkv|mxf|ts)$/, '#B48EAD'],
];

function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

// Light/dark: follows prefers-color-scheme (set by the main process via nativeTheme)
const LIGHT_MQ = window.matchMedia('(prefers-color-scheme: light)');

// Account colors are chosen for a dark background – darken them on light backgrounds so text stays readable
function readable(hex: string): string {
  if (!LIGHT_MQ.matches) return hex;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * 0.55).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

function fileIcon(name: string): string {
  const ext = fileExt(name);
  const color = FILE_COLORS.find(([re]) => re.test(ext))?.[1] ?? '#969993';
  const label = esc((ext || t('file.generic')).slice(0, 4).toUpperCase());
  return `<svg class="fi" width="34" height="42" viewBox="0 0 34 42" aria-hidden="true">
    <path d="M4 1h19l10 10v27a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3Z" style="fill: var(--icon-fill)" stroke="${color}" stroke-width="1.5"/>
    <path d="M23 1v7a3 3 0 0 0 3 3h7" fill="none" stroke="${color}" stroke-width="1.5"/>
    <rect x="1.75" y="23" width="30.5" height="11" fill="${color}"/>
    <text x="17" y="31.3" text-anchor="middle" font-family="JetBrains Mono, Consolas, monospace" font-size="7.5" font-weight="700" fill="#16181C">${label}</text>
  </svg>`;
}

// ---------- Sanitize HTML (allow list): editor, templates, signatures ----------

const ALLOWED_TAGS = new Set(['P', 'BR', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'PRE', 'CODE', 'IMG', 'HR', 'FONT', 'SUB', 'SUP', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']);
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'TITLE', 'HEAD', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'VIDEO', 'AUDIO', 'CANVAS']);
// Styles: enough for signatures (table layouts), but no positioning and no url()
const STYLE_OK = /^(color|background|background-color|font|font-family|font-weight|font-style|font-size|line-height|letter-spacing|text-decoration|text-decoration-line|text-align|text-transform|vertical-align|white-space|margin|margin-(top|right|bottom|left)|padding|padding-(top|right|bottom|left)|border|border-(top|right|bottom|left|color|style|width|radius|collapse|spacing)|width|height|max-width|min-width|display)$/;
const TABLE_ATTRS = new Set(['colspan', 'rowspan', 'cellpadding', 'cellspacing', 'border', 'width', 'height', 'align', 'valign', 'bgcolor']);

// Reduce pasted or custom HTML to a safe minimum (allow list)
function sanitizeHtml(html: string, keepMarkers = false): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toUpperCase();
      if (DROP_TAGS.has(tag)) {
        child.remove();
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const n = attr.name.toLowerCase();
        const v = attr.value.trim();
        if (tag === 'A' && n === 'href' && /^(https?:|mailto:)/i.test(v)) continue;
        if (tag === 'IMG' && n === 'src' && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v)) continue;
        if (tag === 'IMG' && (n === 'alt' || n === 'width' || n === 'height' || n === 'border')) continue;
        if (tag === 'FONT' && (n === 'color' || n === 'face' || n === 'size')) continue;
        if (/^(TABLE|TR|TD|TH|TBODY|THEAD)$/.test(tag) && TABLE_ATTRS.has(n)) continue;
        if (/^(P|DIV|TD|TH)$/.test(tag) && n === 'align') continue;
        if (keepMarkers && (n === 'data-sig' || n === 'data-quote')) continue;
        if (n === 'style') {
          const kept = v
            .split(';')
            .map((d) => d.trim())
            .filter((d) => {
              const [prop, ...rest] = d.split(':');
              return prop && STYLE_OK.test(prop.trim().toLowerCase()) && !/url\(|expression|javascript:/i.test(rest.join(':'));
            })
            .join('; ');
          if (kept) {
            child.setAttribute('style', kept);
            continue;
          }
        }
        child.removeAttribute(attr.name);
      }
      if (tag === 'IMG' && !child.getAttribute('src')) {
        child.remove();
        continue;
      }
      walk(child);
      if (!ALLOWED_TAGS.has(tag)) child.replaceWith(...Array.from(child.childNodes)); // unwrap unknown tags
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

