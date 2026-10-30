// Settings: accounts, senders/aliases with signature, templates.
// Uses el, esc, errMsg from common.ts, account data/dialogs from renderer.ts, calendar.ts and contacts.ts.
// New compose windows load senders and templates themselves when they open.

type SettingsTab = 'accounts' | 'identities' | 'templates' | 'labels' | 'rules' | 'appearance' | 'sounds' | 'ai';
type ThemeChoice = 'dark' | 'light' | 'system';

const setDlg = el<HTMLDialogElement>('#dlg-settings');
let setTab: SettingsTab = 'accounts';
let editIdentities: Identity[] = [];
let editTemplates: Template[] = [];
let calAccs: CalAccount[] = [];
let cardAccs: CalAccount[] = [];
let rssAccs: RssFeed[] = [];
let curTheme: ThemeChoice = 'dark';
let soundList: { id: string; name: string }[] = [];
let prefs: { uiScale: 'small' | 'medium' | 'large'; language: string; weekStart: number; sendDelay: number; composeMode: 'window' | 'popup' } = { uiScale: 'medium', language: 'system', weekStart: 1, sendDelay: 2, composeMode: 'window' };
let langList: string[] = ['de', 'en'];
let editLabels: MailLabel[] = [];
let editRules: MailRule[] = [];
let ruleFolders: Record<string, FolderInfo[]> = {};

async function loadAccountLists(): Promise<void> {
  [accounts, calAccs, cardAccs, rssAccs] = await Promise.all([window.api.listAccounts(), window.api.cal.listAccounts(), window.api.contacts.listAccounts(), window.api.rss.feeds()]);
}

async function openSettings(tab: SettingsTab = setTab): Promise<void> {
  try {
    const s = await window.api.settings.get();
    editIdentities = s.identities.map((i) => ({ ...i }));
    editTemplates = s.templates.map((t) => ({ ...t }));
    curTheme = s.theme ?? 'dark';
    if (s.notify) notify = s.notify;
    soundList = await window.api.sounds.list().catch(() => []);
    prefs = { uiScale: s.uiScale ?? 'medium', language: s.language ?? 'system', weekStart: s.weekStart ?? 1, sendDelay: s.sendDelay ?? 2, composeMode: s.composeMode ?? 'window' };
    langList = await window.api.settings.languages().catch(() => ['de', 'en']);
    editLabels = (s.labels ?? labels).map((l) => ({ ...l }));
    editRules = JSON.parse(JSON.stringify(s.rules ?? []));
    await loadAccountLists();
    ruleFolders = Object.fromEntries(await Promise.all(accounts.map(async (a) => [a.id, folderCache.get(a.id) ?? (await window.api.cachedFolders(a.id).catch(() => []))] as const)));
    await loadAccountLists();
  } catch (err) {
    setStatus(errMsg(err));
    return;
  }
  setTab = tab;
  el('#settings-error').textContent = '';
  renderSettings();
  setDlg.showModal();
}

function renderSettings(): void {
  setDlg.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === setTab));
  el('#settings-body').innerHTML =
    setTab === 'accounts'
      ? accountsHtml()
      : setTab === 'identities'
        ? identitiesHtml()
        : setTab === 'templates'
          ? templatesHtml()
          : setTab === 'sounds'
            ? soundsHtml()
            : setTab === 'labels'
              ? labelsHtml()
              : setTab === 'rules'
                ? rulesHtml()
                : setTab === 'ai'
                  ? aiHtml()
                  : appearanceHtml();
  if (setTab === 'identities' && idnFilter) applyIdnFilter();
  // accounts, appearance and sounds apply immediately
  el('#btn-settings-save').hidden = setTab === 'accounts' || setTab === 'appearance' || setTab === 'sounds' || setTab === 'ai';
}

// Mini-KI (offline): switch on, download/delete models, pick the version
let ai: AiState | null = null;
const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

function aiHtml(): string {
  if (!ai) {
    window.api.ai.state().then((s) => {
      ai = s;
      if (setTab === 'ai') renderSettings();
    });
    return `<p class="hint">${esc(t('status.loading'))}</p>`;
  }
  const rows = ai.models
    .map((m) => {
      const dl = ai!.download?.id === m.id ? ai!.download : null;
      const pct = dl ? Math.floor((dl.received / (dl.total || m.size)) * 100) : 0;
      const status = dl ? `${pct} % · ${mb(dl.received)} / ${mb(dl.total || m.size)}` : m.downloaded ? t('ai.onDisk') : t('ai.notOnDisk');
      const actions = dl
        ? `<button type="button" class="link" data-ai-cancel>${esc(t('btn.cancel'))}</button>`
        : m.downloaded
          ? `<button type="button" class="link danger" data-ai-delete="${esc(m.id)}">${esc(t('btn.delete'))}</button>`
          : `<button type="button" class="btn ghost sm" data-ai-download="${esc(m.id)}"${ai!.download ? ' disabled' : ''}>${esc(t('ai.download'))}</button>`;
      return `<div class="ai-model${ai!.model === m.id ? ' active' : ''}">
        <label class="ai-pick"><input type="radio" name="ai-model" value="${esc(m.id)}" data-ai-model${ai!.model === m.id ? ' checked' : ''}><span><b>${esc(m.name)}</b><small>${esc(t(`ai.model.${m.id}`))} · ${esc(mb(m.size))} · ${esc(status)}</small></span></label>
        ${dl ? `<progress max="100" value="${pct}"></progress>` : ''}
        <span class="ai-act">${actions}</span>
      </div>`;
    })
    .join('');
  const active = ai.models.find((m) => m.id === ai!.model);
  const state = !ai.enabled ? t('ai.stateOff') : active?.downloaded ? t('ai.stateReady') : t('ai.stateNeedsModel');
  return `<div class="set-card">
      <label class="check"><input type="checkbox" data-ai-enable${ai.enabled ? ' checked' : ''}> <b>${esc(t('ai.enable'))}</b></label>
      <p class="hint">${esc(t('ai.hint'))}</p>
      <span class="ai-state${ai.enabled && active?.downloaded ? ' ok' : ''}">${esc(state)}</span>
    </div>
    <div class="set-card">
      <span class="mono">${esc(t('ai.langLabel').toUpperCase())}</span>
      <div class="sound-row"><span class="sound-acc">${esc(t('ai.langHint'))}</span><select data-ai-lang>${AI_LANG_CODES.map((l) => `<option value="${l}"${ai!.lang === l ? ' selected' : ''}>${esc(t(`ai.lang.${l}`))}</option>`).join('')}</select></div>
    </div>
    <div class="set-card">
      <span class="mono">${esc(t('tr.defaultLabel').toUpperCase())}</span>
      <div class="sound-row"><span class="sound-acc">${esc(t('tr.defaultHint'))}</span><select data-ai-trlang>${TR_LANGS.map((l) => `<option value="${l}"${translateTarget(ai) === l ? ' selected' : ''}>${esc(trLangName(l))}</option>`).join('')}</select></div>
    </div>
    <h3 class="set-sub">${esc(t('ai.models'))}</h3>
    <div class="set-card ai-models">${rows}</div>
    <p class="hint">${esc(t('ai.modelsHint'))}</p>`;
}

window.api.ai.onState((s) => {
  ai = s;
  if (setDlg.open && setTab === 'ai') renderSettings();
});

el('#settings-body').addEventListener('change', async (e) => {
  const tgt = e.target as HTMLInputElement;
  try {
    if (tgt.dataset.aiEnable !== undefined) ai = await window.api.ai.enable(tgt.checked);
    else if (tgt.dataset.aiModel !== undefined) ai = await window.api.ai.setModel(tgt.value);
    else if (tgt.dataset.aiLang !== undefined) ai = await window.api.ai.setLang(tgt.value);
    else if (tgt.dataset.aiTrlang !== undefined) ai = await window.api.ai.setTranslateLang(tgt.value);
    else return;
    renderSettings();
  } catch (err) {
    el('#settings-error').textContent = errMsg(err);
  }
});

el('#settings-body').addEventListener('click', async (e) => {
  const tgt = e.target as HTMLElement;
  const dl = tgt.closest<HTMLElement>('[data-ai-download]')?.dataset.aiDownload;
  const del = tgt.closest<HTMLElement>('[data-ai-delete]')?.dataset.aiDelete;
  if (!dl && !del && !tgt.closest('[data-ai-cancel]')) return;
  el('#settings-error').textContent = '';
  try {
    if (dl) ai = await window.api.ai.download(dl);
    else if (del) {
      if (!confirm(t('ai.deleteConfirm'))) return;
      ai = await window.api.ai.remove(del);
    } else await window.api.ai.cancel();
    if (setTab === 'ai') renderSettings();
  } catch (err) {
    el('#settings-error').textContent = errMsg(err);
  }
});

// Sounds for new mail
function soundOptions(selected: string, withDefault: boolean, builtinLabel = t('sounds.builtin')): string {
  const opt = (v: string, label: string) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`;
  // Selected file missing in sounds/ → show it anyway (the built-in sound plays then)
  const missing = selected && !['builtin', 'none'].includes(selected) && !soundList.some((s) => s.id === selected) ? opt(selected, t('sounds.missing', { name: selected.replace(/^(app|user):/, '').replace(/\.[a-z0-9]+$/i, '') })) : '';
  const defName = notify.sound === 'none' ? t('sounds.none') : notify.sound === 'builtin' ? t('sounds.builtin') : soundList.find((s) => s.id === notify.sound)?.name ?? t('sounds.builtin');
  return [
    withDefault ? opt('', t('sounds.default', { name: defName })) : '',
    missing,
    opt('builtin', builtinLabel),
    ...soundList.map((s) => opt(s.id, s.name)),
    opt('none', t('sounds.none')),
  ].join('');
}

const playBtn = (sel: string) =>
  `<button type="button" class="icon-btn sm" data-play="${sel}" aria-label="${esc(t('sounds.play'))}" title="${esc(t('sounds.play'))}"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8Z"/></svg></button>`;

function soundsHtml(): string {
  const rows = accounts
    .map(
      (a) => `<div class="sound-row">
        <span class="dot" style="background:${a.color}"></span><span class="sound-acc">${esc(a.email)}</span>
        <label class="bell" title="${esc(t('notify.desktopAccount'))}"><input type="checkbox" data-desk-acc="${esc(a.id)}"${notify.desktopOff?.includes(a.id) ? '' : ' checked'}${notify.desktop === false ? ' disabled' : ''}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg></label>
        <select data-sound-acc="${esc(a.id)}">${soundOptions(notify.perAccount[a.id] ?? '', true)}</select>${playBtn(`acc:${a.id}`)}
      </div>`,
    )
    .join('');
  return `<div class="set-card">
      <label class="check sound-on"><input type="checkbox" data-notify="desktop"${notify.desktop !== false ? ' checked' : ''}> ${esc(t('notify.desktop'))}</label>
      <label class="check sound-on"><input type="checkbox" data-notify="background"${notify.background !== false ? ' checked' : ''}> ${esc(t('notify.background'))}</label>
    </div>
    <div class="set-card">
      <label class="check sound-on"><input type="checkbox" data-notify="enabled"${notify.enabled ? ' checked' : ''}> ${esc(t('sounds.enabled'))}</label>
      <div class="sound-row"><span class="sound-acc">${esc(t('sounds.defaultSound'))}</span><select data-notify="sound">${soundOptions(notify.sound, false)}</select>${playBtn('default')}</div>
      <div class="sound-row"><span class="sound-acc">${esc(t('sounds.sentSound'))}</span><select data-notify="sentSound">${soundOptions(notify.sentSound ?? 'app:sentMail_Ding.wav', false, t('sounds.builtinDing'))}</select>${playBtn('sent')}</div>
      <div class="sound-row"><span class="sound-acc">${esc(t('sounds.volume'))}</span><input type="range" min="0" max="1" step="0.05" value="${notify.volume}" data-notify="volume"><span></span></div>
    </div>
    <section class="set-acc">
      <div class="set-acc-head"><b>${esc(t('sounds.perAccount'))}</b></div>
      <div class="set-card">${rows || `<p class="hint">${esc(t('settings.addMailAccountFirst'))}</p>`}</div>
    </section>
    <div class="sig-actions"><button type="button" class="btn ghost sm" data-sound-folder>${esc(t('sounds.openFolder'))}</button><span class="hint">${esc(t('sounds.hint'))}</span></div>`;
}

async function saveNotifyNow(): Promise<void> {
  try {
    notify = await window.api.settings.saveNotify(notify);
  } catch (err) {
    el('#settings-error').textContent = errMsg(err);
  }
}

el('#settings-body').addEventListener('change', (e) => {
  const tgt = e.target as HTMLInputElement;
  const acc = tgt.dataset.soundAcc;
  const key = tgt.dataset.notify;
  const desk = tgt.dataset.deskAcc;
  if (desk !== undefined) {
    const off = new Set(notify.desktopOff ?? []);
    if (tgt.checked) off.delete(desk);
    else off.add(desk);
    notify.desktopOff = [...off];
  } else if (key === 'desktop' || key === 'background') {
    notify[key] = tgt.checked;
    saveNotifyNow().then(renderSettings);
    return;
  } else if (acc !== undefined) {
    if (tgt.value) notify.perAccount[acc] = tgt.value;
    else delete notify.perAccount[acc];
    playSound(tgt.value || notify.sound);
  } else if (key === 'enabled') notify.enabled = tgt.checked;
  else if (key === 'sentSound') {
    notify.sentSound = tgt.value;
    playSound(tgt.value, notify.volume, playDing);
  } else if (key === 'sound') {
    notify.sound = tgt.value;
    playSound(tgt.value);
    saveNotifyNow().then(renderSettings); // update "Default (…)" in the account lists
    return;
  } else if (key === 'volume') {
    notify.volume = Number(tgt.value);
    playSound(notify.sound);
  } else return;
  saveNotifyNow();
});

el('#settings-body').addEventListener('click', (e) => {
  const tgt = e.target as HTMLElement;
  const play = tgt.closest<HTMLElement>('[data-play]')?.dataset.play;
  if (play === 'default') playSound(notify.sound);
  else if (play === 'sent') playSound(notify.sentSound ?? 'app:sentMail_Ding.wav', notify.volume, playDing);
  else if (play?.startsWith('acc:')) playSound(notify.perAccount[play.slice(4)] || notify.sound);
  if (tgt.closest('[data-sound-folder]')) window.api.sounds.openFolder();
});

// Appearance
function appearanceHtml(): string {
  const opts: [ThemeChoice, string][] = [
    ['dark', t('settings.themeDark')],
    ['light', t('settings.themeLight')],
    ['system', t('settings.themeSystem')],
  ];
  return `<div class="set-card">
    <span class="mono">${esc(t('settings.theme').toUpperCase())}</span>
    <div class="theme-grid" role="radiogroup">
      ${opts
        .map(
          ([v, label]) => `<button type="button" role="radio" aria-checked="${v === curTheme}" class="theme-opt${v === curTheme ? ' active' : ''}" data-theme-opt="${v}">
          <span class="theme-prev ${v}"><i></i><i></i></span>${esc(label)}</button>`,
        )
        .join('')}
    </div>
    <p class="hint">${esc(t('settings.themeHint'))}</p>
  </div>
  <div class="set-card">
    <span class="mono">${esc(t('settings.uiScale').toUpperCase())}</span>
    <div class="seg scale-seg" role="radiogroup">
      ${(['small', 'medium', 'large'] as const)
        .map((v) => `<button type="button" role="radio" aria-checked="${v === prefs.uiScale}" class="${v === prefs.uiScale ? 'on' : ''}" data-pref-scale="${v}"><span class="scale-a ${v}">A</span> ${esc(t(`settings.scale.${v}`))}</button>`)
        .join('')}
    </div>
  </div>
  <div class="set-card">
    <span class="mono">${esc(t('settings.accountLabel').toUpperCase())}</span>
    <div class="seg" role="radiogroup">
      ${(['name', 'email'] as const)
        .map((v) => `<button type="button" role="radio" aria-checked="${v === accLabelMode}" class="${v === accLabelMode ? 'on' : ''}" data-pref-acclabel="${v}">${esc(t(`settings.accountLabel.${v}`))}</button>`)
        .join('')}
    </div>
    <p class="hint">${esc(t('settings.accountLabelHint'))}</p>
  </div>
  <div class="set-card">
    <span class="mono">${esc(t('settings.composeMode').toUpperCase())}</span>
    <div class="sound-row"><span class="sound-acc">${esc(t('settings.composeModeHint'))}</span><select data-pref-compose>
      <option value="window"${prefs.composeMode !== 'popup' ? ' selected' : ''}>${esc(t('settings.composeWindow'))}</option>
      <option value="popup"${prefs.composeMode === 'popup' ? ' selected' : ''}>${esc(t('settings.composePopup'))}</option>
    </select></div>
  </div>
  <div class="set-card two-col">
    <label>${esc(t('settings.language'))}
      <select data-pref-lang>
        <option value="system"${prefs.language === 'system' ? ' selected' : ''}>${esc(t('settings.langSystem'))}</option>
        ${langList.map((c) => `<option value="${c}"${prefs.language === c ? ' selected' : ''}>${esc(LANG_NAMES[c] ?? c.toUpperCase())}</option>`).join('')}
      </select>
    </label>
    <label>${esc(t('settings.weekStart'))}
      <select data-pref-week>
        ${[1, 0, 6].map((d) => `<option value="${d}"${prefs.weekStart === d ? ' selected' : ''}>${esc(new Date(2026, 0, 4 + d).toLocaleDateString(LOCALE, { weekday: 'long' }))}</option>`).join('')}
      </select>
    </label>
    <p class="hint">${esc(t('settings.languageHint'))}</p>
  </div>
  <div class="set-card">
    <span class="mono">${esc(t('ext.title').toUpperCase())}</span>
    <label class="check"><input type="checkbox" data-pref-ext${extMarkOn ? ' checked' : ''}> ${esc(t('ext.enable'))}</label>
    <p class="hint">${esc(t('ext.hint'))}</p>
    ${
      extMarkOn
        ? `<label>${esc(t('ext.domains'))}<input data-pref-extdom value="${esc([...extDomainsExtra].join(', '))}" placeholder="example.com, partner.com"></label>
           <p class="hint">${esc(t('ext.domainsHint', { own: [...extDomains].filter((d) => !extDomainsExtra.includes(d)).join(', ') || '–' }))}</p>`
        : ''
    }
  </div>`;
}

let extDomainsExtra: string[] = [];
window.api.settings
  .get()
  .then((s) => (extDomainsExtra = s.internalDomains ?? []))
  .catch(() => {});

const LANG_NAMES: Record<string, string> = { de: 'Deutsch', en: 'English', fr: 'Français', it: 'Italiano', es: 'Español' };

el('#settings-body').addEventListener('click', async (e) => {
  const al = (e.target as HTMLElement).closest<HTMLElement>('[data-pref-acclabel]')?.dataset.prefAcclabel as 'name' | 'email' | undefined;
  if (al && al !== accLabelMode) {
    accLabelMode = al;
    renderSettings();
    renderAccounts();
    renderList();
    markActive();
    await window.api.settings.savePrefs({ accountLabel: al }).catch(() => {});
    return;
  }
  const v = (e.target as HTMLElement).closest<HTMLElement>('[data-pref-scale]')?.dataset.prefScale as typeof prefs.uiScale | undefined;
  if (!v || v === prefs.uiScale) return;
  prefs.uiScale = v;
  renderSettings();
  await window.api.settings.savePrefs({ uiScale: v }).catch((err) => (el('#settings-error').textContent = errMsg(err)));
});

el('#settings-body').addEventListener('change', async (e) => {
  const tgt = e.target as HTMLSelectElement;
  if (tgt.dataset.prefLang !== undefined) {
    prefs.language = tgt.value;
    const res = await window.api.settings.savePrefs({ language: tgt.value }).catch(() => ({ restartNeeded: false }));
    if (res.restartNeeded && confirm(t('settings.restartConfirm'))) window.api.settings.relaunch();
    else if (res.restartNeeded) el('#settings-error').textContent = t('settings.restartLater');
  } else if (tgt.dataset.prefCompose !== undefined) {
    prefs.composeMode = tgt.value === 'popup' ? 'popup' : 'window';
    await window.api.settings.savePrefs({ composeMode: prefs.composeMode }).catch(() => {});
  } else if (tgt.dataset.prefRead !== undefined) {
    readDelay = Number(tgt.value); // renderer.ts – applies right away
    await window.api.settings.savePrefs({ readDelay }).catch(() => {});
  } else if (tgt.dataset.prefDelay !== undefined) {
    prefs.sendDelay = Number(tgt.value);
    await window.api.settings.savePrefs({ sendDelay: prefs.sendDelay }).catch(() => {});
  } else if (tgt.dataset.prefExt !== undefined) {
    const on = (tgt as unknown as HTMLInputElement).checked;
    await window.api.settings.savePrefs({ externalMark: on }).catch(() => {});
    setExternalPrefs(on, extDomainsExtra);
    renderSettings();
    renderList();
  } else if (tgt.dataset.prefExtdom !== undefined) {
    extDomainsExtra = tgt.value.split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
    await window.api.settings.savePrefs({ internalDomains: extDomainsExtra }).catch(() => {});
    const s = await window.api.settings.get().catch(() => null);
    if (s) extDomainsExtra = s.internalDomains ?? [];
    setExternalPrefs(extMarkOn, extDomainsExtra);
    renderSettings();
    renderList();
  } else if (tgt.dataset.prefWeek !== undefined) {
    prefs.weekStart = Number(tgt.value);
    await window.api.settings.savePrefs({ weekStart: prefs.weekStart }).catch(() => {});
    WEEK_START = prefs.weekStart;
    applyWeekStart();
  }
});

// Categories
const CAT_COLORS = ['#2BA89F', '#7FA6CF', '#E0574B', '#E0A458', '#B48EAD', '#4DB37A', '#D9C35B', '#969993'];

function labelsHtml(): string {
  const rows = editLabels
    .map(
      (l, i) => `<div class="cat-row">
        <span class="lbl" style="--lc:${readable(l.color)}">${esc(l.name || '…')}</span>
        <input data-cat-name="${i}" value="${esc(l.name)}" maxlength="40" placeholder="${esc(t('labels.namePh'))}">
        <span class="cat-colors">${CAT_COLORS.map((c) => `<button type="button" class="swatch sm${c === l.color ? ' on' : ''}" data-cat-color="${i}|${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}</span>
        <button type="button" class="link danger" data-cat-rm="${i}">${esc(t('common.remove'))}</button>
      </div>`,
    )
    .join('');
  return `<p class="hint">${esc(t('labels.settingsHint'))}</p>
    <div class="set-card cat-list">${rows || `<p class="hint">${esc(t('settings.noneYet'))}</p>`}</div>
    <div><button type="button" class="btn ghost sm" data-cat-add>${esc(t('labels.new'))}</button></div>`;
}

el('#settings-body').addEventListener('input', (e) => {
  const tgt = e.target as HTMLInputElement;
  if (tgt.dataset.prefDelay !== undefined) {
    const n = Number(tgt.value);
    tgt.parentElement!.querySelector('.delay-val')!.textContent = n ? t('settings.seconds', { n }) : t('settings.delayOff');
    return;
  }
  const i = tgt.dataset.catName;
  if (i === undefined) return;
  editLabels[Number(i)].name = tgt.value;
  const pill = tgt.parentElement?.querySelector<HTMLElement>('.lbl');
  if (pill) pill.textContent = tgt.value || '…';
});

el('#settings-body').addEventListener('click', (e) => {
  const tgt = e.target as HTMLElement;
  const col = tgt.closest<HTMLElement>('[data-cat-color]')?.dataset.catColor;
  const rm = tgt.closest<HTMLElement>('[data-cat-rm]')?.dataset.catRm;
  if (col) {
    const [i, c] = col.split('|');
    editLabels[Number(i)].color = c;
  } else if (rm !== undefined) {
    editLabels.splice(Number(rm), 1);
  } else if (tgt.closest('[data-cat-add]')) {
    editLabels.push({ id: '', name: '', color: CAT_COLORS[editLabels.length % CAT_COLORS.length] });
  } else return;
  renderSettings();
  if (tgt.closest('[data-cat-add]')) el('#settings-body').querySelector<HTMLInputElement>(`[data-cat-name="${editLabels.length - 1}"]`)?.focus();
});

el('#settings-body').addEventListener('click', async (e) => {
  const opt = (e.target as HTMLElement).closest<HTMLElement>('[data-theme-opt]');
  if (!opt) return;
  curTheme = opt.dataset.themeOpt as ThemeChoice;
  renderSettings();
  try {
    await window.api.settings.setTheme(curTheme);
  } catch (err) {
    el('#settings-error').textContent = errMsg(err);
  }
});

// Accounts
function accountsHtml(): string {
  const line = (kind: string, id: string, color: string, title: string, sub: string) => `
    <div class="acc-line">
      <span class="dot" style="background:${color}"></span>
      <span class="acc-text"><b>${esc(title)}</b><span>${esc(sub)}</span></span>
      <button type="button" class="link" data-edit-acc="${kind}|${esc(id)}">${esc(t('settings.edit'))}</button>
      <button type="button" class="link danger" data-rm-acc="${kind}|${esc(id)}">${esc(t('common.remove'))}</button>
    </div>`;
  const section = (title: string, lines: string, kind: string, addLabel: string) => `
    <section class="set-acc">
      <div class="set-acc-head"><b>${esc(title)}</b><button type="button" class="link" data-add-acc="${kind}">${esc(addLabel)}</button></div>
      <div class="set-card acc-lines">${lines || `<p class="hint">${esc(t('settings.noneYet'))}</p>`}</div>
    </section>`;
  return [
    section(
      t('settings.mailAccounts'),
      accounts.map((a) => line('mail', a.id, a.color, a.name && a.name !== a.email ? `${a.name} · ${a.email}` : a.email, `${a.protocol === 'pop3' ? 'POP3' : 'IMAP'} ${a.host}:${a.port} · SMTP ${a.smtpHost}:${a.smtpPort}`)).join(''),
      'mail',
      t('settings.addMailAccount'),
    ),
    section(t('settings.calAccounts'), calAccs.map((a) => line('cal', a.id, '#7FA6CF', a.name, a.serverUrl === 'local:' ? t('dav.localLine') : [a.serverUrl, a.username].filter(Boolean).join(' · '))).join(''), 'cal', t('cal.addAccount')),
    section(t('settings.cardAccounts'), cardAccs.map((a) => line('card', a.id, '#C1C8BE', a.name, a.serverUrl === 'local:' ? t('dav.localLine') : [a.serverUrl, a.username].filter(Boolean).join(' · '))).join(''), 'card', t('contacts.addAccount')),
    section(t('settings.rssAccounts'), rssAccs.map((f) => line('rss', f.id, feedColor(f.id), f.name, [f.url, f.username].filter(Boolean).join(' · '))).join(''), 'rss', t('rss.addAccount')),
  ].join('');
}

async function removeAccountFromSettings(ref: string): Promise<void> {
  const [kind, id] = ref.split('|');
  el('#settings-error').textContent = '';
  try {
    if (kind === 'mail') {
      const acc = accounts.find((a) => a.id === id);
      if (!acc || !confirm(t('account.confirmRemove', { email: acc.email }))) return;
      await window.api.removeAccount(id);
      if (currentAccount === id) {
        currentAccount = null;
        currentFolder = 'INBOX';
      }
      folderCache.delete(id);
      editIdentities = editIdentities.filter((i) => i.accountId !== id);
      clearReader();
      await loadAccounts();
      loadMails();
    } else if (kind === 'cal') {
      const acc = calAccs.find((a) => a.id === id);
      if (!acc || !confirm(t('cal.confirmRemoveAccount', { name: acc.name }))) return;
      await window.api.cal.removeAccount(id);
      if (calLoaded) loadCalendars();
    } else if (kind === 'card') {
      const acc = cardAccs.find((a) => a.id === id);
      if (!acc || !confirm(t('contacts.confirmRemoveAccount', { name: acc.name }))) return;
      await window.api.contacts.removeAccount(id);
      currentBook = null;
      if (contactsLoaded) loadContacts();
    } else if (kind === 'rss') {
      const feed = rssAccs.find((f) => f.id === id);
      if (!feed || !confirm(t('rss.confirmRemove', { name: feed.name }))) return;
      await removeFeedById(id);
    }
    await loadAccountLists();
    renderSettings();
  } catch (err) {
    el('#settings-error').textContent = errMsg(err);
  }
}

// After "Add account": refresh the list and senders (unsaved changes are kept)
async function refreshAfterAccountDialog(): Promise<void> {
  if (!setDlg.open) return;
  await new Promise((r) => setTimeout(r, 50)); // let the dialog finish saving
  await loadAccountLists();
  try {
    const fresh = await window.api.settings.get();
    const known = new Set(editIdentities.map((i) => i.id));
    for (const idn of fresh.identities) if (!known.has(idn.id)) editIdentities.push({ ...idn });
  } catch {
    /* senders stay as they are */
  }
  renderSettings();
}

['#dlg-add', '#dlg-cal-add', '#dlg-card-add', '#dlg-rss-add'].forEach((sel) => el(sel).addEventListener('close', refreshAfterAccountDialog));

// Signature: text or HTML (load file, edit directly, source)
const sigModes = new WeakMap<Identity, 'text' | 'html'>();
const sigModeOf = (idn: Identity) => sigModes.get(idn) ?? (idn.signatureHtml ? 'html' : 'text');

function signatureBlock(idn: Identity, i: number, acc: Account): string {
  const mode = sigModeOf(idn);
  const head = `<div class="sig-head"><span>${esc(t('settings.signature'))}</span>
    <div class="seg mini">
      <button type="button" data-sigmode="text" data-i="${i}" class="${mode === 'text' ? 'on' : ''}">${esc(t('settings.sigText'))}</button>
      <button type="button" data-sigmode="html" data-i="${i}" class="${mode === 'html' ? 'on' : ''}">HTML</button>
    </div></div>`;
  if (mode === 'text') {
    return `${head}<textarea data-list="id" data-i="${i}" data-k="signature" rows="4" placeholder="${esc(t('settings.signaturePh'))}&#10;${esc(acc.name)}">${esc(idn.signature)}</textarea>`;
  }
  const html = idn.signatureHtml ?? '';
  return `${head}
    <div class="sig-preview" contenteditable="true" data-sig-edit="${i}" aria-label="${esc(t('settings.signature'))}">${sanitizeHtml(html)}</div>
    <textarea class="sig-src" data-sig-src="${i}" rows="7" spellcheck="false" hidden>${esc(html)}</textarea>
    <div class="sig-actions">
      <button type="button" class="btn ghost sm" data-sig-file="${i}">${esc(t('settings.sigLoadFile'))}</button>
      <button type="button" class="link" data-sig-srctoggle="${i}">${esc(t('settings.sigSource'))}</button>
      <span class="hint">${esc(t('settings.sigHtmlHint'))}</span>
    </div>`;
}

// Many senders stay manageable: one line per sender (name, address, start of the signature),
// only one opened for editing at a time; accounts can be folded, a filter finds a sender quickly
let openIdn: Identity | null = null;
const foldedSigAccs = new Set<string>();
let idnFilter = '';

function sigPlain(idn: Identity): string {
  const text = idn.signatureHtml ? new DOMParser().parseFromString(idn.signatureHtml, 'text/html').body.textContent ?? '' : idn.signature;
  return text.replace(/\s+/g, ' ').trim();
}

function identityCard(idn: Identity, i: number, acc: Account): string {
  const open = openIdn === idn;
  const sig = sigPlain(idn);
  const head = `<button type="button" class="idn-head" data-idn-toggle="${i}" aria-expanded="${open}">
      <span class="tw${open ? ' open' : ''}">›</span>
      <span class="idn-who"><b>${esc(idn.name || acc.name)}</b><span>${esc(idn.email || '–')}</span></span>
      <span class="idn-sig${sig ? '' : ' none'}">${esc(sig || t('settings.noSignature'))}</span>
      ${idn.signatureHtml ? '<span class="idn-tag">HTML</span>' : ''}
      <span class="idn-tag${idn.primary ? ' main' : ''}">${esc(idn.primary ? t('settings.mainTag') : t('identity.alias'))}</span>
    </button>`;
  if (!open) return `<div class="set-card idn-card" data-idn="${i}">${head}</div>`;
  return `<div class="set-card idn-card open" data-idn="${i}">${head}
      <div class="row">
        <label class="grow">${esc(t('account.displayName'))}<input data-list="id" data-i="${i}" data-k="name" value="${esc(idn.name)}" placeholder="${esc(acc.name)}"></label>
        <label class="grow">${esc(t('settings.senderAddress'))}<input data-list="id" data-i="${i}" data-k="email" value="${esc(idn.email)}" ${idn.primary ? 'disabled' : 'placeholder="info@example.com"'}></label>
      </div>
      ${signatureBlock(idn, i, acc)}
      <div class="set-card-foot">${
        idn.primary
          ? `<span class="hint">${esc(t('settings.primary'))}</span>`
          : `<span class="hint">${esc(t('identity.alias'))}</span><button type="button" class="link danger" data-rm-alias="${i}">${esc(t('settings.removeAlias'))}</button>`
      }</div>
    </div>`;
}

function identitiesHtml(): string {
  if (!accounts.length) return `<p class="hint">${esc(t('settings.addMailAccountFirst'))}</p>`;
  const sections = accounts.map((acc) => {
    const mine = editIdentities.map((idn, i) => ({ idn, i })).filter(({ idn }) => idn.accountId === acc.id);
    const folded = foldedSigAccs.has(acc.id) && !idnFilter;
    return `<section class="set-acc" data-idn-acc="${esc(acc.id)}">
      <div class="set-acc-head">
        <button type="button" class="idn-acc-toggle" data-sigacc-toggle="${esc(acc.id)}" aria-expanded="${!folded}"><span class="tw${folded ? '' : ' open'}">›</span><span class="dot" style="background:${acc.color}"></span><b>${esc(acc.email)}</b><span class="n">${mine.length}</span></button>
        <button type="button" class="link" data-add-alias="${acc.id}">+ ${esc(t('identity.alias'))}</button>
      </div>
      ${folded ? '' : mine.map(({ idn, i }) => identityCard(idn, i, acc)).join('')}
    </section>`;
  });
  const filter =
    editIdentities.length > 4
      ? `<input type="search" class="idn-filter" data-idn-filter value="${esc(idnFilter)}" placeholder="${esc(t('settings.idnFilter'))}" aria-label="${esc(t('settings.idnFilter'))}">`
      : '';
  const general = `<h3 class="set-sub">${esc(t('settings.sendRead'))}</h3>
    <div class="set-card">
      <span class="mono">${esc(t('settings.sendDelay').toUpperCase())}</span>
      <div class="sound-row"><span class="sound-acc">${esc(t('settings.sendDelayHint'))}</span><input type="range" min="0" max="5" step="1" value="${prefs.sendDelay}" data-pref-delay><b class="delay-val">${prefs.sendDelay ? t('settings.seconds', { n: prefs.sendDelay }) : t('settings.delayOff')}</b></div>
    </div>
    <div class="set-card">
      <span class="mono">${esc(t('settings.readDelay').toUpperCase())}</span>
      <div class="sound-row"><span class="sound-acc">${esc(t('settings.readDelayHint'))}</span><select data-pref-read>${[0, 1, 3, 5, 10, -1]
        .map((n) => `<option value="${n}"${n === readDelay ? ' selected' : ''}>${esc(n === 0 ? t('settings.readNow') : n < 0 ? t('settings.readManual') : t('settings.readAfter', { n }))}</option>`)
        .join('')}</select></div>
    </div>`;
  return `${filter}${sections.join('')}<p class="hint">${esc(t('settings.aliasHint'))}</p>${general}`;
}

// Filter without re-rendering (keeps the focus in the field)
function applyIdnFilter(): void {
  const q = idnFilter.trim().toLowerCase();
  const body = el('#settings-body');
  body.querySelectorAll<HTMLElement>('[data-idn]').forEach((card) => {
    const idn = editIdentities[Number(card.dataset.idn)];
    card.hidden = !!q && !`${idn.name} ${idn.email} ${sigPlain(idn)}`.toLowerCase().includes(q);
  });
  body.querySelectorAll<HTMLElement>('[data-idn-acc]').forEach((sec) => {
    sec.hidden = !!q && !sec.querySelector('[data-idn]:not([hidden])');
  });
  const none = body.querySelector<HTMLElement>('.idn-none');
  const empty = !!q && !body.querySelector('[data-idn]:not([hidden])');
  if (empty && !none) body.querySelector('.idn-filter')?.insertAdjacentHTML('afterend', `<p class="hint idn-none">${esc(t('mail.noHits'))}</p>`);
  if (!empty) none?.remove();
}

function templatesHtml(): string {
  const cards = editTemplates
    .map(
      (tpl, i) => `<div class="set-card">
        <div class="row">
          <label class="grow">${esc(t('field.name'))}<input data-list="tpl" data-i="${i}" data-k="name" value="${esc(tpl.name)}" placeholder="${esc(t('settings.templateNamePh'))}"></label>
          <label class="grow">${esc(t('compose.subject'))}<input data-list="tpl" data-i="${i}" data-k="subject" value="${esc(tpl.subject)}"></label>
        </div>
        <label>${esc(t('settings.text'))}<textarea data-list="tpl" data-i="${i}" data-k="body" rows="6">${esc(tpl.body)}</textarea></label>
        ${tpl.html ? `<span class="hint">${esc(t('settings.formattedHint'))}</span>` : ''}
        <div class="set-card-foot"><span></span><button type="button" class="link danger" data-rm-tpl="${i}">${esc(t('settings.deleteTemplate'))}</button></div>
      </div>`,
    )
    .join('');
  return `<p class="hint">${esc(t('settings.placeholderHint'))}</p>
    ${cards || `<p class="hint">${esc(t('settings.noTemplates'))}</p>`}
    <button type="button" class="btn ghost" id="btn-add-tpl">+ ${esc(t('settings.newTemplate'))}</button>`;
}

// apply input directly to the working copy
el('#settings-body').addEventListener('input', (e) => {
  const tgt = e.target as HTMLInputElement;
  if (tgt.dataset.idnFilter !== undefined) {
    const wasEmpty = !idnFilter;
    idnFilter = tgt.value;
    // folded accounts open while filtering → render once, then filter in place
    if (wasEmpty !== !idnFilter && foldedSigAccs.size) {
      renderSettings();
      const f = el('#settings-body').querySelector<HTMLInputElement>('[data-idn-filter]');
      f?.focus();
      f?.setSelectionRange(f.value.length, f.value.length);
    }
    return applyIdnFilter();
  }
  // HTML signature: edited directly in the preview or in the source
  if (tgt.dataset.sigEdit !== undefined) {
    const i = Number(tgt.dataset.sigEdit);
    editIdentities[i].signatureHtml = sanitizeHtml(tgt.innerHTML);
    const src = el('#settings-body').querySelector<HTMLTextAreaElement>(`[data-sig-src="${i}"]`);
    if (src) src.value = editIdentities[i].signatureHtml!;
    return;
  }
  if (tgt.dataset.sigSrc !== undefined) {
    const i = Number(tgt.dataset.sigSrc);
    editIdentities[i].signatureHtml = tgt.value; // the main process embeds external images when saving
    const prev = el('#settings-body').querySelector<HTMLElement>(`[data-sig-edit="${i}"]`);
    if (prev) prev.innerHTML = sanitizeHtml(tgt.value);
    return;
  }
  const i = Number(tgt.dataset.i);
  const k = tgt.dataset.k;
  if (!k || Number.isNaN(i)) return;
  if (tgt.dataset.list === 'id') (editIdentities[i] as unknown as Record<string, string>)[k] = tgt.value;
  else {
    (editTemplates[i] as unknown as Record<string, string>)[k] = tgt.value;
    if (k === 'body') delete editTemplates[i].html; // text changed → formatting discarded
  }
});

el('#settings-body').addEventListener('click', (e) => {
  const tgt = e.target as HTMLElement;
  const add = tgt.closest<HTMLElement>('[data-add-alias]')?.dataset.addAlias;
  const rmAlias = tgt.closest<HTMLElement>('[data-rm-alias]')?.dataset.rmAlias;
  const rmTpl = tgt.closest<HTMLElement>('[data-rm-tpl]')?.dataset.rmTpl;
  const addAcc = tgt.closest<HTMLElement>('[data-add-acc]')?.dataset.addAcc;
  const rmAcc = tgt.closest<HTMLElement>('[data-rm-acc]')?.dataset.rmAcc;
  const editAcc = tgt.closest<HTMLElement>('[data-edit-acc]')?.dataset.editAcc;
  if (editAcc) {
    const [kind, id] = editAcc.split('|');
    if (kind === 'mail') return openEditMailAccount(id);
    if (kind === 'rss') {
      const feed = rssAccs.find((f) => f.id === id);
      return feed ? openEditFeed(feed) : undefined;
    }
    const list = kind === 'cal' ? calAccs : cardAccs;
    const acc = list.find((a) => a.id === id);
    if (acc) return kind === 'cal' ? openEditCalAccount(acc) : openEditCardAccount(acc);
    return;
  }
  const idnToggle = tgt.closest<HTMLElement>('[data-idn-toggle]')?.dataset.idnToggle;
  if (idnToggle !== undefined) {
    const idn = editIdentities[Number(idnToggle)];
    openIdn = openIdn === idn ? null : idn;
    renderSettings();
    el('#settings-body').querySelector(`[data-idn="${idnToggle}"]`)?.scrollIntoView({ block: 'nearest' });
    return;
  }
  const accToggle = tgt.closest<HTMLElement>('[data-sigacc-toggle]')?.dataset.sigaccToggle;
  if (accToggle !== undefined) {
    if (foldedSigAccs.has(accToggle)) foldedSigAccs.delete(accToggle);
    else foldedSigAccs.add(accToggle);
    return renderSettings();
  }
  const sigMode = tgt.closest<HTMLElement>('[data-sigmode]');
  if (sigMode) {
    const idn = editIdentities[Number(sigMode.dataset.i)];
    const mode = sigMode.dataset.sigmode as 'text' | 'html';
    if (mode === 'html' && !idn.signatureHtml?.trim() && idn.signature.trim()) idn.signatureHtml = textToHtml(idn.signature);
    if (mode === 'text') delete idn.signatureHtml; // discard HTML → the text signature applies
    sigModes.set(idn, mode);
    return renderSettings();
  }
  const sigFile = tgt.closest<HTMLElement>('[data-sig-file]')?.dataset.sigFile;
  if (sigFile !== undefined) {
    window.api.settings
      .signatureFile()
      .then((html) => {
        if (html === null) return;
        editIdentities[Number(sigFile)].signatureHtml = sanitizeHtml(html);
        renderSettings();
      })
      .catch((err) => (el('#settings-error').textContent = errMsg(err)));
    return;
  }
  const srcToggle = tgt.closest<HTMLElement>('[data-sig-srctoggle]')?.dataset.sigSrctoggle;
  if (srcToggle !== undefined) {
    const src = el('#settings-body').querySelector<HTMLTextAreaElement>(`[data-sig-src="${srcToggle}"]`);
    if (src) src.hidden = !src.hidden;
    return;
  }
  if (addAcc === 'mail') return openAddMailAccount();
  if (addAcc === 'cal') return openAddCalAccount();
  if (addAcc === 'card') return openAddCardAccount();
  if (addAcc === 'rss') return openAddFeed();
  if (rmAcc) return void removeAccountFromSettings(rmAcc);
  if (add) {
    const acc = accounts.find((a) => a.id === add);
    const idn: Identity = { id: '', accountId: add, name: acc?.name ?? '', email: '', signature: '', primary: false };
    editIdentities.push(idn);
    openIdn = idn; // new sender: open right away for editing
    foldedSigAccs.delete(add);
  } else if (rmAlias !== undefined) {
    editIdentities.splice(Number(rmAlias), 1);
  } else if (rmTpl !== undefined) {
    editTemplates.splice(Number(rmTpl), 1);
  } else if (tgt.closest('#btn-add-tpl')) {
    editTemplates.push({ id: '', name: '', subject: '', body: '' });
  } else return;
  renderSettings();
});

setDlg.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    setTab = b.dataset.tab as SettingsTab;
    renderSettings();
  }),
);

el('#btn-settings-close').addEventListener('click', () => setDlg.close());

el('#btn-settings-save').addEventListener('click', async () => {
  const btn = el<HTMLButtonElement>('#btn-settings-save');
  btn.disabled = true;
  el('#settings-error').textContent = '';
  try {
    if (editTemplates.some((tpl) => !tpl.name.trim() && (tpl.subject || tpl.body))) throw new Error(t('settings.templateNeedsName'));
    editIdentities = (await window.api.settings.saveIdentities(editIdentities)).map((i) => ({ ...i }));
    editTemplates = (await window.api.settings.saveTemplates(editTemplates)).map((t) => ({ ...t }));
    if (setTab === 'rules') {
      editRules = JSON.parse(JSON.stringify(await window.api.settings.saveRules(editRules)));
    }
    if (setTab === 'labels') {
      const names = editLabels.map((l) => l.name.trim().toLowerCase()).filter(Boolean);
      if (new Set(names).size !== names.length) throw new Error(t('labels.duplicate'));
      labels = await window.api.settings.saveLabels(editLabels.filter((l) => l.name.trim()));
      editLabels = labels.map((l) => ({ ...l }));
      mailLabels = (await window.api.settings.get()).mailLabels ?? {};
      if (labelView && !labels.some((l) => l.id === labelView)) labelView = null;
      renderAccounts();
      renderList();
    }
    renderSettings();
    el('#settings-error').textContent = t('status.saved');
  } catch (err) {
    el('#settings-error').textContent = errMsg(err);
  } finally {
    btn.disabled = false;
  }
});

// Gear at the top right: list of sections
const setMenu = document.createElement('div');
setMenu.className = 'ctx-menu set-menu';
setMenu.hidden = true;
setMenu.setAttribute('role', 'menu');
document.body.appendChild(setMenu);

const SET_TABS: [SettingsTab, string, string][] = [
  ['accounts', 'settings.tabAccounts', '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'],
  ['identities', 'settings.tabIdentities', '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'],
  ['templates', 'settings.tabTemplates', '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'],
  ['rules', 'settings.tabRules', '<path d="M4 6h10M4 12h7M4 18h4"/><path d="m15 15 3 3 4-6"/>'],
  ['labels', 'settings.tabLabels', '<path d="M3 12V4h8l10 10-8 8Z"/><circle cx="7.5" cy="8" r="1.5"/>'],
  ['sounds', 'settings.tabSounds', '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>'],
  ['appearance', 'settings.tabAppearance', '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor"/>'],
];

el('#btn-settings').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!setMenu.hidden) return void (setMenu.hidden = true);
  setMenu.innerHTML =
    SET_TABS.map(([tab, key, ico]) => `<button type="button" role="menuitem" data-set-tab="${tab}">${svgIco(ico)}<span>${esc(t(key))}</span></button>`).join('') +
    `<hr><button type="button" role="menuitem" data-about>${svgIco('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>')}<span>${esc(t('about.menu'))}</span></button>`;
  setMenu.hidden = false;
  const r = el('#btn-settings').getBoundingClientRect();
  setMenu.style.top = `${r.bottom + 4}px`;
  setMenu.style.left = `${Math.min(r.right - setMenu.offsetWidth, innerWidth - setMenu.offsetWidth - 6)}px`;
  setMenu.querySelector<HTMLElement>('button')?.focus();
});
setMenu.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-about]')) {
    setMenu.hidden = true;
    return void openAbout();
  }
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-set-tab]')?.dataset.setTab as SettingsTab | undefined;
  if (!tab) return;
  setMenu.hidden = true;
  openSettings(tab);
});
document.addEventListener('mousedown', (e) => {
  if (!setMenu.hidden && !setMenu.contains(e.target as Node) && !el('#btn-settings').contains(e.target as Node)) setMenu.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setMenu.hidden = true;
});
window.addEventListener('blur', () => (setMenu.hidden = true));

// About
const REPO = 'https://github.com/ciegolink/agenoras';

async function openAbout(): Promise<void> {
  const info = await window.api.appInfo().catch(() => null);
  const link = (href: string, label: string, ico: string) => `<a class="about-link" href="${href}" target="_blank" rel="noopener">${svgIco(ico)}<span>${esc(label)}</span></a>`;
  el('#about-body').innerHTML = `
    <div class="about-head">
      <img class="about-logo" alt="">
      <div>
        <h2>Agenoras<span class="dot">.</span></h2>
        <div class="about-ver">${esc(t('about.version', { v: info?.version ?? '–' }))}</div>
      </div>
    </div>
    <p class="about-tag">${esc(t('about.tagline'))}</p>
    <div class="about-links">
      ${link(REPO, 'GitHub', '<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>')}
      ${link(REPO + '/wiki', t('about.wiki'), '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5Z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>')}
      ${link(REPO + '/issues', t('about.issues'), '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>')}
      ${link('https://ciegolink.com', 'ciegolink.com', '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>')}
    </div>
    <dl class="about-sys">
      <dt>Electron</dt><dd>${esc(info?.electron ?? '–')}</dd>
      <dt>Chromium</dt><dd>${esc(info?.chrome ?? '–')}</dd>
      <dt>Node.js</dt><dd>${esc(info?.node ?? '–')}</dd>
      <dt>${esc(t('about.system'))}</dt><dd>${esc(info?.platform ?? '–')}</dd>
    </dl>
    <p class="about-credits">${esc(t('about.credits'))} Electron, ImapFlow, Nodemailer, mailparser, tsdav, ical.js, node-llama-cpp.</p>
    <p class="about-credits">${esc(t('about.aiModel'))} <a href="https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512" target="_blank" rel="noopener">Ministral 3 3B Instruct</a> © Mistral AI, <a href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noopener">Apache License 2.0</a>, ${esc(t('about.aiQuant'))} <a href="https://huggingface.co/bartowski/mistralai_Ministral-3-3B-Instruct-2512-GGUF" target="_blank" rel="noopener">bartowski</a>.</p>
    <p class="about-license"><a href="${REPO}/blob/main/LICENSE" target="_blank" rel="noopener">MIT License</a> · © 2026 CiegoLink GmbH</p>`;
  // Own logo (build/logo.png) if present, otherwise the app icon
  const img = el<HTMLImageElement>('#about-body .about-logo');
  img.addEventListener('error', () => (img.src = '../../build/icon.png'), { once: true });
  img.src = '../../build/logo.png';
  el<HTMLDialogElement>('#dlg-about').showModal();
}
el('#btn-about-close').addEventListener('click', () => el<HTMLDialogElement>('#dlg-about').close());

// Mail rules
const RULE_FIELDS: RuleCondition['field'][] = ['from', 'to', 'subject', 'any'];
const RULE_OPS: RuleCondition['op'][] = ['contains', 'equals', 'startsWith', 'endsWith'];

function newRule(partial: Partial<MailRule> = {}): MailRule {
  return { id: '', name: '', enabled: true, accountId: '', match: 'all', conditions: [{ field: 'from', op: 'contains', value: '' }], hasAttachment: false, actions: {}, stop: false, ...partial };
}

function rulesHtml(): string {
  const opt = (v: string, label: string, sel: string) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(label)}</option>`;
  const cards = editRules
    .map((r, i) => {
      const folders = (r.accountId ? ruleFolders[r.accountId] ?? [] : []).filter((f) => f.selectable && f.path !== 'INBOX');
      const conds = r.conditions
        .map(
          (c, j) => `<div class="rule-cond">
            <select data-cond="${i}|${j}|field">${RULE_FIELDS.map((f) => opt(f, t(`rules.field.${f}`), c.field)).join('')}</select>
            <select data-cond="${i}|${j}|op">${RULE_OPS.map((o) => opt(o, t(`rules.op.${o}`), c.op)).join('')}</select>
            <input data-cond="${i}|${j}|value" value="${esc(c.value)}" placeholder="${esc(t('rules.valuePh'))}">
            <button type="button" class="link danger" data-cond-rm="${i}|${j}" aria-label="${esc(t('common.remove'))}">×</button>
          </div>`,
        )
        .join('');
      const a = r.actions;
      const chk = (k: string, on: boolean, label: string, extra = '') => `<label class="rule-act"><input type="checkbox" data-act="${i}|${k}"${on ? ' checked' : ''}> ${esc(label)}${extra}</label>`;
      return `<div class="set-card rule-card${r.enabled ? '' : ' off'}">
        <div class="rule-head">
          <label class="rule-on" title="${esc(t('rules.enabled'))}"><input type="checkbox" data-rule="${i}|enabled"${r.enabled ? ' checked' : ''}></label>
          <input class="rule-name" data-rule="${i}|name" value="${esc(r.name)}" placeholder="${esc(t('rules.namePh'))}">
          <select data-rule="${i}|accountId">${opt('', t('rules.allAccounts'), r.accountId)}${accounts.map((acc) => opt(acc.id, acc.email, r.accountId)).join('')}</select>
          <button type="button" class="link danger" data-rule-rm="${i}">${esc(t('common.remove'))}</button>
        </div>
        <div class="rule-sub">${esc(t('rules.if'))}
          <select data-rule="${i}|match">${opt('all', t('rules.matchAll'), r.match)}${opt('any', t('rules.matchAny'), r.match)}</select>
          ${esc(t('rules.ifEnd'))}</div>
        ${conds}
        <div class="rule-row">
          <button type="button" class="link" data-cond-add="${i}">+ ${esc(t('rules.addCondition'))}</button>
          <label class="rule-act"><input type="checkbox" data-rule="${i}|hasAttachment"${r.hasAttachment ? ' checked' : ''}> ${esc(t('rules.hasAttachment'))}</label>
        </div>
        <div class="rule-sub">${esc(t('rules.then'))}</div>
        <div class="rule-acts">
          ${chk('move', !!a.move, t('rules.actMove'), ` <select data-act-move="${i}"${r.accountId ? '' : ' disabled'}>${r.accountId ? opt('', '…', a.move ?? '') + folders.map((f) => opt(f.path, `${'  '.repeat(f.depth)}${specialName(f.specialUse) || f.name}`, a.move ?? '')).join('') : opt('', t('rules.moveNeedsAccount'), '')}</select>`)}
          ${chk('read', !!a.read, t('rules.actRead'))}
          ${chk('flag', !!a.flag, t('rules.actFlag'))}
          ${chk('label', !!a.label, t('rules.actLabel'), ` <select data-act-label="${i}">${opt('', '…', a.label ?? '')}${labels.map((l) => opt(l.id, l.name, a.label ?? '')).join('')}</select>`)}
          ${chk('spam', !!a.spam, t('rules.actSpam'))}
          ${chk('delete', !!a.delete, t('rules.actDelete'))}
          <label class="rule-act"><input type="checkbox" data-rule="${i}|stop"${r.stop ? ' checked' : ''}> ${esc(t('rules.stop'))}</label>
        </div>
      </div>`;
    })
    .join('');
  return `<p class="hint">${esc(t('rules.hint'))}</p>${cards || `<p class="hint">${esc(t('settings.noneYet'))}</p>`}
    <div class="rule-foot"><button type="button" class="btn ghost sm" data-rule-add>+ ${esc(t('rules.new'))}</button>
    <button type="button" class="btn ghost sm" data-rule-run>${esc(t('rules.runNow'))}</button></div>`;
}

function ruleInput(tgt: HTMLInputElement | HTMLSelectElement): boolean {
  const r = tgt.dataset.rule;
  const c = tgt.dataset.cond;
  if (r) {
    const [i, k] = r.split('|');
    const rule = editRules[Number(i)];
    if (k === 'enabled' || k === 'hasAttachment' || k === 'stop') (rule as unknown as Record<string, boolean>)[k] = (tgt as HTMLInputElement).checked;
    else if (k === 'accountId') {
      rule.accountId = tgt.value;
      delete rule.actions.move; // folders belong to an account
      return true; // redraw (folder list)
    } else (rule as unknown as Record<string, string>)[k] = tgt.value;
    return k === 'enabled';
  }
  if (c) {
    const [i, j, k] = c.split('|');
    (editRules[Number(i)].conditions[Number(j)] as unknown as Record<string, string>)[k] = tgt.value;
    return false;
  }
  const act = tgt.dataset.act;
  if (act) {
    const [i, k] = act.split('|');
    const a = editRules[Number(i)].actions as Record<string, unknown>;
    const on = (tgt as HTMLInputElement).checked;
    if (k === 'move') on ? (a.move = (setDlg.querySelector<HTMLSelectElement>(`[data-act-move="${i}"]`)?.value || '')) : delete a.move;
    else if (k === 'label') on ? (a.label = setDlg.querySelector<HTMLSelectElement>(`[data-act-label="${i}"]`)?.value || labels[0]?.id || '') : delete a.label;
    else on ? (a[k] = true) : delete a[k];
    if (k === 'delete' && on) delete a.spam;
    if (k === 'spam' && on) delete a.delete;
    return k === 'delete' || k === 'spam' || k === 'label';
  }
  if (tgt.dataset.actMove !== undefined) {
    const a = editRules[Number(tgt.dataset.actMove)].actions;
    if (tgt.value) a.move = tgt.value;
    else delete a.move;
    return true;
  }
  if (tgt.dataset.actLabel !== undefined) {
    const a = editRules[Number(tgt.dataset.actLabel)].actions;
    if (tgt.value) a.label = tgt.value;
    else delete a.label;
    return true;
  }
  return false;
}

el('#settings-body').addEventListener('input', (e) => {
  const tgt = e.target as HTMLInputElement;
  if (setTab === 'rules' && tgt.type !== 'checkbox' && tgt.tagName === 'INPUT') ruleInput(tgt);
});
el('#settings-body').addEventListener('change', (e) => {
  if (setTab !== 'rules') return;
  const tgt = e.target as HTMLInputElement | HTMLSelectElement;
  if (ruleInput(tgt)) renderSettings();
});
el('#settings-body').addEventListener('click', async (e) => {
  if (setTab !== 'rules') return;
  const tgt = e.target as HTMLElement;
  const add = tgt.closest<HTMLElement>('[data-cond-add]')?.dataset.condAdd;
  const rmc = tgt.closest<HTMLElement>('[data-cond-rm]')?.dataset.condRm;
  const rmr = tgt.closest<HTMLElement>('[data-rule-rm]')?.dataset.ruleRm;
  if (add !== undefined) editRules[Number(add)].conditions.push({ field: 'subject', op: 'contains', value: '' });
  else if (rmc) {
    const [i, j] = rmc.split('|').map(Number);
    editRules[i].conditions.splice(j, 1);
  } else if (rmr !== undefined) {
    if (!confirm(t('rules.confirmDelete', { name: editRules[Number(rmr)].name || t('rules.unnamed') }))) return;
    editRules.splice(Number(rmr), 1);
  } else if (tgt.closest('[data-rule-add]')) editRules.push(newRule({ accountId: accounts.length === 1 ? accounts[0].id : '' }));
  else if (tgt.closest('[data-rule-run]')) {
    const btn = tgt.closest<HTMLButtonElement>('[data-rule-run]')!;
    btn.disabled = true;
    el('#settings-error').textContent = '';
    try {
      editRules = JSON.parse(JSON.stringify(await window.api.settings.saveRules(editRules)));
      const res = await window.api.settings.runRules(null);
      el('#settings-error').textContent = t('rules.ran', { matched: res.matched, moved: res.moved });
      loadMails();
    } catch (err) {
      el('#settings-error').textContent = errMsg(err);
    } finally {
      btn.disabled = false;
    }
    return;
  } else return;
  renderSettings();
});

// From a mail: prepare a rule with the sender
async function openRuleFromMail(m: MailSummary): Promise<void> {
  await openSettings('rules');
  editRules.push(newRule({ name: t('rules.fromName', { name: m.from || m.fromAddress }), accountId: m.accountId, conditions: [{ field: 'from', op: 'contains', value: m.fromAddress }] }));
  renderSettings();
  const cards = el('#settings-body').querySelectorAll<HTMLElement>('.rule-card');
  cards[cards.length - 1]?.scrollIntoView({ block: 'center' });
}
