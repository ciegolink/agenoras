// Shared helpers for the main window and the compose window.

const el = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// Language (strings from lang/<language>.json, delivered by the main process)
const I18N = window.i18n ?? { lang: 'en', locale: 'en-GB', strings: {} };
const LOCALE = I18N.locale;
// First day of the week (1 = Monday, 0 = Sunday, 6 = Saturday) – Settings → General
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

// Custom title bar: move (CSS), minimize, maximize, close
const WIN_ICONS = {
  min: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5h8" stroke="currentColor" stroke-width="1.2"/></svg>',
  max: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  restore:
    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="3" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3 3V1h6v6H7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  close: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.2"/></svg>',
};

// E-mail addresses in already escaped plain text → clickable, opens a new mail (handled in renderer.ts)
const MAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const linkEmails = (html: string) => html.replace(MAIL_IN_TEXT, (a) => `<button type="button" class="mail-link" data-mailto="${a}" title="${esc(t('people.write'))}">${a}</button>`);

// Web addresses in plain text (https://…, www.…); a closing bracket or punctuation at the end is not part of it
const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"]+[^\s<>".,;:!?)\]'’]/gi;

// Links and e-mail addresses in already escaped plain text: links open in the browser, addresses a new mail
function linkText(html: string): string {
  return html
    .split(/(\b(?:https?:\/\/|www\.)[^\s<>"]+[^\s<>".,;:!?)\]'’])/gi)
    .map((part, i) => {
      if (i % 2 === 0) return linkEmails(part);
      const href = /^www\./i.test(part) ? `https://${part}` : part;
      return `<a class="mail-link" href="${href}" target="_blank" rel="noopener" title="${href}">${part}</a>`;
    })
    .join('');
}

// Pin (pin sidebar)
const PIN_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 6 4 4H6l4-4z"/><path d="M12 14v7"/></svg>';

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
  // Compose as popup: fixed like a dialog – no moving, only closing
  if (new URLSearchParams(location.search).has('popup')) {
    document.body.classList.add('is-popup');
    ctl.innerHTML = `<button type="button" class="win-btn close" data-win="close" aria-label="${esc(t('win.close'))}" title="${esc(t('win.close'))}">${WIN_ICONS.close}</button>`;
    ctl.addEventListener('click', () => window.api.win.close());
    return;
  }
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

// File icons for attachments
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

// Sanitize HTML (allow list): editor, templates, signatures
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


// Output languages of the mini AI (settings and compose window), independent of the UI language
const AI_LANG_CODES = ['auto', 'de-CH', 'de-DE', 'en', 'fr', 'it'];

// Translation targets: every language the AI model supports, without regional variants (see ai.ts)
const TR_LANGS = ['de', 'en', 'fr', 'it', 'es', 'pt', 'nl', 'zh', 'ja', 'ko', 'ar'];
// Language name in the app language ("Deutsch", "Englisch" …)
const langNames = new Intl.DisplayNames([LOCALE], { type: 'language' });
const trLangName = (code: string) => {
  const n = langNames.of(code) ?? code;
  return n.charAt(0).toLocaleUpperCase(LOCALE) + n.slice(1);
};
// Default target: Settings → AI, otherwise the app language
function translateTarget(state?: AiState | null): string {
  if (state?.translateLang && TR_LANGS.includes(state.translateLang)) return state.translateLang;
  return systemTrLang();
}

// No target chosen: the system (app) language
function systemTrLang(): string {
  const l = I18N.lang.slice(0, 2).toLowerCase();
  return TR_LANGS.includes(l) ? l : 'en';
}

// Badge on the view buttons at the bottom of the sidebar. Tasks: new since the view was last open
const seenKeys = (view: string): Set<string> | null => {
  try {
    const raw = localStorage.getItem(`seen.${view}`);
    return raw ? new Set(JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
};
const saveSeen = (view: string, keys: Iterable<string>) => {
  try {
    localStorage.setItem(`seen.${view}`, JSON.stringify([...keys]));
  } catch {
    /* ignore */
  }
};

function navBadge(view: string, keys: string[]): void {
  const btn = document.querySelector<HTMLElement>(`.view-btn[data-view="${view}"]`);
  if (!btn) return;
  let seen = seenKeys(view);
  // first run or view open: everything there now counts as seen
  if ((!seen && keys.length) || document.querySelector<HTMLElement>('.app')?.dataset.view === view) {
    saveSeen(view, keys);
    seen = new Set(keys);
  }
  paintNavBadge(view, seen ? keys.filter((k) => !seen.has(k)).length : 0);
}

function paintNavBadge(view: string, n: number): void {
  const btn = document.querySelector<HTMLElement>(`.view-btn[data-view="${view}"]`);
  if (!btn) return;
  let badge = btn.querySelector<HTMLElement>('.nav-new');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'nav-new';
    btn.append(badge);
  }
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = !n;
  badge.title = n ? t(view === 'rss' ? 'nav.unread' : 'nav.new', { n }) : '';
}

// Own new items (quick add, converted mail …) are not news
function markNavSeen(view: string, keys: string[]): void {
  const seen = seenKeys(view);
  if (!seen || !keys.length) return;
  keys.forEach((k) => seen.add(k));
  saveSeen(view, seen);
}

// Save button while saving: disabled with a turning circle
function savingBtn(btn: HTMLButtonElement, on: boolean): void {
  btn.disabled = on;
  btn.classList.toggle('saving', on);
}

// Context menus: an entry that opens a submenu to the side (on hover, or click / Enter)
function ctxSub(icon: string, label: string, inner: string): string {
  return `<div class="ctx-subwrap"><button type="button" role="menuitem" aria-haspopup="menu" class="ctx-more">${icon}<span>${esc(label)}</span><span class="chev">›</span></button><div class="ctx-flyout" role="menu">${inner}</div></div>`;
}

function wireSubmenus(menu: HTMLElement): void {
  // open to the left / higher up when there is no room
  const place = (wrap: HTMLElement) => {
    const fly = wrap.querySelector<HTMLElement>('.ctx-flyout');
    if (!fly) return;
    fly.classList.remove('left');
    fly.style.top = '';
    const r = fly.getBoundingClientRect();
    if (r.right > innerWidth - 6) fly.classList.add('left');
    if (r.bottom > innerHeight - 6) fly.style.top = `${Math.max(-wrap.getBoundingClientRect().top + 6, innerHeight - 6 - r.bottom - 4)}px`;
  };
  menu.addEventListener('mouseover', (e) => {
    const wrap = (e.target as HTMLElement).closest<HTMLElement>('.ctx-subwrap');
    menu.querySelectorAll<HTMLElement>('.ctx-subwrap.open').forEach((w) => w !== wrap && w.classList.remove('open'));
    if (wrap && !wrap.classList.contains('open')) {
      wrap.classList.add('open');
      place(wrap);
    }
  });
  menu.addEventListener('click', (e) => {
    const more = (e.target as HTMLElement).closest<HTMLElement>('.ctx-more');
    if (!more) return;
    e.stopPropagation();
    const wrap = more.parentElement!;
    wrap.classList.add('open');
    place(wrap);
    wrap.querySelector<HTMLElement>('.ctx-flyout button')?.focus();
  });
}

// Right click in text fields: spelling suggestions and editing, drawn like the other menus.
// A popover lies in the top layer, so it also shows above open dialogs (task, settings …).
const textMenu = document.createElement('div');
textMenu.className = 'ctx-menu text-menu';
textMenu.setAttribute('role', 'menu');
textMenu.popover = 'manual';
document.body.appendChild(textMenu);

const hideTextMenu = () => {
  if (textMenu.matches(':popover-open')) textMenu.hidePopover();
};

window.api.ctx.onText((p) => {
  const item = (act: string, label: string, enabled = true, word = '') =>
    `<button type="button" role="menuitem" data-text-act="${act}" data-word="${esc(word)}"${enabled ? '' : ' disabled'}><span>${esc(label)}</span></button>`;
  const parts: string[] = [];
  if (p.spell) {
    parts.push(...p.spell.suggestions.map((w) => item('replace', w, true, w).replace('<span>', '<span class="sugg">')));
    if (!p.spell.suggestions.length) parts.push(`<div class="ctx-sub">${esc(t('ctx.noSuggestions'))}</div>`);
    parts.push(item('learn', t('ctx.addToDictionary'), true, p.spell.word), '<hr>');
  }
  if (p.editable) parts.push(item('cut', t('ctx.cut'), p.can.cut), item('copy', t('ctx.copy'), p.can.copy), item('paste', t('ctx.paste'), p.can.paste), '<hr>', item('selectAll', t('ctx.selectAll')));
  else parts.push(item('copy', t('ctx.copy')));
  textMenu.innerHTML = parts.join('');
  textMenu.showPopover();
  const r = textMenu.getBoundingClientRect();
  textMenu.style.left = `${Math.max(4, Math.min(p.x, innerWidth - r.width - 6))}px`;
  textMenu.style.top = `${Math.max(4, Math.min(p.y, innerHeight - r.height - 6))}px`;
});

// keep the focus (and the selection) in the text field while clicking the menu
textMenu.addEventListener('mousedown', (e) => e.preventDefault());
textMenu.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-text-act]');
  if (!b || b.disabled) return;
  hideTextMenu();
  void window.api.ctx.act(b.dataset.textAct as 'replace', b.dataset.word || undefined);
});
document.addEventListener('mousedown', (e) => {
  if (!textMenu.contains(e.target as Node)) hideTextMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideTextMenu();
}, true);
window.addEventListener('blur', hideTextMenu);
document.addEventListener('scroll', hideTextMenu, true);
