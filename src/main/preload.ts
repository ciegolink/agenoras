import { contextBridge, ipcRenderer, webUtils } from 'electron';

// Strings of the selected language (lang/<code>.json), once on load
contextBridge.exposeInMainWorld('i18n', ipcRenderer.sendSync('i18n:get'));

contextBridge.exposeInMainWorld('api', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  platform: process.platform,
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    onState: (cb: (maximized: boolean) => void) => {
      ipcRenderer.on('win:state', (_e, maximized: boolean) => cb(maximized));
    },
  },
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  addAccount: (input: unknown) => ipcRenderer.invoke('accounts:add', input),
  removeAccount: (id: string) => ipcRenderer.invoke('accounts:remove', id),
  updateAccount: (id: string, input: unknown) => ipcRenderer.invoke('accounts:update', id, input),
  setAccountColor: (id: string, color: string) => ipcRenderer.invoke('accounts:color', id, color),
  ai: {
    state: () => ipcRenderer.invoke('ai:state'),
    enable: (on: boolean) => ipcRenderer.invoke('ai:enable', on),
    setModel: (id: string) => ipcRenderer.invoke('ai:model', id),
    setLang: (lang: string) => ipcRenderer.invoke('ai:lang', lang),
    setTranslateLang: (lang: string) => ipcRenderer.invoke('ai:translateLang', lang),
    download: (id: string) => ipcRenderer.invoke('ai:download', id),
    cancel: () => ipcRenderer.invoke('ai:cancel'),
    remove: (id: string) => ipcRenderer.invoke('ai:delete', id),
    subjects: (text: string) => ipcRenderer.invoke('ai:subjects', text),
    proofread: (text: string) => ipcRenderer.invoke('ai:proofread', text),
    write: (instruction: string, ctx?: unknown) => ipcRenderer.invoke('ai:write', instruction, ctx),
    translate: (text: string, target: string) => ipcRenderer.invoke('ai:translate', text, target),
    onState: (cb: (state: unknown) => void) => {
      ipcRenderer.on('ai:state', (_e, s) => cb(s));
    },
  },
  log: {
    state: () => ipcRenderer.invoke('log:state'),
    list: () => ipcRenderer.invoke('log:list'),
    seen: () => ipcRenderer.invoke('log:seen'),
    clear: () => ipcRenderer.invoke('log:clear'),
    onChanged: (cb: (state: unknown) => void) => {
      ipcRenderer.on('log:changed', (_e, state) => cb(state));
    },
  },
  privacy: {
    state: () => ipcRenderer.invoke('privacy:state'),
    unlock: (pin: string) => ipcRenderer.invoke('privacy:unlock', pin),
    lock: () => ipcRenderer.invoke('privacy:lock'),
    set: (id: string, pin: string | null, autoLockMin?: number) => ipcRenderer.invoke('privacy:set', id, pin, autoLockMin),
    activity: () => ipcRenderer.invoke('privacy:activity'),
    onChanged: (cb: (state: unknown) => void) => {
      ipcRenderer.on('privacy:changed', (_e, state) => cb(state));
    },
  },
  listFolders: (accountId: string) => ipcRenderer.invoke('mail:folders', accountId),
  cachedFolders: (accountId: string) => ipcRenderer.invoke('mail:folders:cached', accountId),
  cachedMail: (accountId: string | null, folder?: string) => ipcRenderer.invoke('mail:cached', accountId, folder),
  listMail: (accountId: string | null, folder?: string) => ipcRenderer.invoke('mail:list', accountId, folder),
  getMail: (accountId: string, folder: string, uid: number, loadImages?: boolean, markRead = true) => ipcRenderer.invoke('mail:get', accountId, folder, uid, !!loadImages, markRead),
  setSeen: (accountId: string, folder: string, uids: number[], seen: boolean) => ipcRenderer.invoke('mail:seen', accountId, folder, uids, seen),
  setFlagged: (accountId: string, folder: string, uids: number[], flagged: boolean) => ipcRenderer.invoke('mail:flag', accountId, folder, uids, flagged),
  flaggedMails: () => ipcRenderer.invoke('mail:flagged'),
  cachedFlagged: () => ipcRenderer.invoke('mail:flagged:cached'),
  mailsByMessageIds: (ids: string[]) => ipcRenderer.invoke('mail:byMessageIds', ids),
  knownAddresses: () => ipcRenderer.invoke('addresses:list'),
  searchMail: (accountId: string | null, folder: string | null, query: string) => ipcRenderer.invoke('mail:search', accountId, folder, query),
  searchCachedMail: (accountId: string | null, folder: string | null, query: string) => ipcRenderer.invoke('mail:search:cached', accountId, folder, query),
  avatars: (emails: string[]) => ipcRenderer.invoke('avatars:get', emails),
  invite: {
    respond: (accountId: string, folder: string, uid: number, partstat: string, calendarId: string | null) => ipcRenderer.invoke('invite:respond', accountId, folder, uid, partstat, calendarId),
    apply: (accountId: string, folder: string, uid: number) => ipcRenderer.invoke('invite:apply', accountId, folder, uid),
  },
  mailview: {
    open: (ref: unknown) => ipcRenderer.invoke('mailview:open', ref),
    init: () => ipcRenderer.invoke('mailview:init'),
  },
  moveMails: (accountId: string, folder: string, uids: number[], target: string) => ipcRenderer.invoke('mail:move', accountId, folder, uids, target),
  deleteMails: (accountId: string, folder: string, uids: number[]) => ipcRenderer.invoke('mail:delete', accountId, folder, uids),
  emptyTrash: (accountId: string) => ipcRenderer.invoke('mail:emptyTrash', accountId),
  markFolderSeen: (accountId: string, folder: string) => ipcRenderer.invoke('mail:markFolderSeen', accountId, folder),
  react: (accountId: string, folder: string, uid: number, emoji: string) => ipcRenderer.invoke('mail:react', accountId, folder, uid, emoji),
  junkToTrash: (accountId: string) => ipcRenderer.invoke('mail:junkToTrash', accountId),
  sendMail: (mail: unknown) => ipcRenderer.invoke('mail:send', mail),
  saveAttachment: (accountId: string, folder: string, uid: number, index: number) => ipcRenderer.invoke('mail:attachment:save', accountId, folder, uid, index),
  openAttachment: (accountId: string, folder: string, uid: number, index: number) => ipcRenderer.invoke('mail:attachment:open', accountId, folder, uid, index),
  files: {
    pick: () => ipcRenderer.invoke('files:pick'),
    // Only real dropped files have a path
    dropped: (file: File) => {
      const p = webUtils.getPathForFile(file);
      return p ? ipcRenderer.invoke('files:dropped', p) : Promise.reject(new Error('no path'));
    },
  },
  cal: {
    listAccounts: () => ipcRenderer.invoke('cal:accounts:list'),
    addAccount: (input: unknown) => ipcRenderer.invoke('cal:accounts:add', input),
    addLocalAccount: (name: string) => ipcRenderer.invoke('cal:accounts:addLocal', name),
    removeAccount: (id: string) => ipcRenderer.invoke('cal:accounts:remove', id),
    updateAccount: (id: string, input: unknown) => ipcRenderer.invoke('cal:accounts:update', id, input),
    cached: (calendarIds: string[], start: string) => ipcRenderer.invoke('cal:cached', calendarIds, start),
    listCalendars: () => ipcRenderer.invoke('cal:calendars'),
    listEvents: (calendarIds: string[], start: string, end: string) => ipcRenderer.invoke('cal:events', calendarIds, start, end),
    saveEvent: (input: unknown, invite?: unknown) => ipcRenderer.invoke('cal:save', input, invite),
    ics: (url: string) => ipcRenderer.invoke('cal:ics', url),
    search: (query: string, calendarIds: string[]) => ipcRenderer.invoke('cal:search', query, calendarIds),
    deleteEvent: (url: string, occurrence?: string, cancel?: unknown) => ipcRenderer.invoke('cal:delete', url, occurrence, cancel),
  },
  tasks: {
    cached: () => ipcRenderer.invoke('tasks:cached'),
    list: () => ipcRenderer.invoke('tasks:list'),
    save: (input: unknown) => ipcRenderer.invoke('tasks:save', input),
    delete: (id: string) => ipcRenderer.invoke('tasks:delete', id),
  },
  rss: {
    feeds: () => ipcRenderer.invoke('rss:feeds'),
    add: (input: unknown) => ipcRenderer.invoke('rss:add', input),
    update: (id: string, input: unknown) => ipcRenderer.invoke('rss:update', id, input),
    remove: (id: string) => ipcRenderer.invoke('rss:remove', id),
    cached: () => ipcRenderer.invoke('rss:cached'),
    list: () => ipcRenderer.invoke('rss:list'),
    article: (key: string) => ipcRenderer.invoke('rss:article', key),
    search: (query: string) => ipcRenderer.invoke('rss:search', query),
    setRead: (keys: string[], read: boolean) => ipcRenderer.invoke('rss:read', keys, read),
  },
  contacts: {
    listAccounts: () => ipcRenderer.invoke('contacts:accounts:list'),
    addAccount: (input: unknown) => ipcRenderer.invoke('contacts:accounts:add', input),
    addLocalAccount: (name: string) => ipcRenderer.invoke('contacts:accounts:addLocal', name),
    removeAccount: (id: string) => ipcRenderer.invoke('contacts:accounts:remove', id),
    updateAccount: (id: string, input: unknown) => ipcRenderer.invoke('contacts:accounts:update', id, input),
    cached: () => ipcRenderer.invoke('contacts:cached'),
    list: () => ipcRenderer.invoke('contacts:list'),
    save: (input: unknown) => ipcRenderer.invoke('contacts:save', input),
    delete: (url: string) => ipcRenderer.invoke('contacts:delete', url),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    saveIdentities: (list: unknown) => ipcRenderer.invoke('settings:identities', list),
    saveTemplates: (list: unknown) => ipcRenderer.invoke('settings:templates', list),
    setTheme: (theme: string) => ipcRenderer.invoke('settings:theme', theme),
    signatureFile: () => ipcRenderer.invoke('settings:signatureFile'),
    trustSender: (email: string) => ipcRenderer.invoke('settings:trustSender', email),
    saveNotify: (n: unknown) => ipcRenderer.invoke('settings:notify', n),
    saveLabels: (list: unknown) => ipcRenderer.invoke('labels:save', list),
    savePrefs: (p: unknown) => ipcRenderer.invoke('settings:prefs', p),
    saveRules: (list: unknown) => ipcRenderer.invoke('rules:save', list),
    runRules: (accountId: string | null) => ipcRenderer.invoke('rules:run', accountId),
    languages: () => ipcRenderer.invoke('settings:languages'),
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
    setMailLabel: (keys: string[], labelId: string, on: boolean) => ipcRenderer.invoke('labels:set', keys, labelId, on),
  },
  compose: {
    open: (opts: unknown) => ipcRenderer.invoke('compose:open', opts),
    init: () => ipcRenderer.invoke('compose:init'),
    done: (status: string) => ipcRenderer.invoke('compose:done', status),
    sent: () => ipcRenderer.invoke('compose:sent'),
    focusPopup: () => ipcRenderer.invoke('compose:focusPopup'),
    onDim: (cb: (on: boolean) => void) => {
      ipcRenderer.on('compose:dim', (_e, on: boolean) => cb(on));
    },
  },
  onStatus: (cb: (text: string) => void) => {
    ipcRenderer.on('mail:status', (_e, text: string) => cb(text));
  },
  onSendProgress: (cb: (done: number, total: number) => void) => {
    ipcRenderer.removeAllListeners('mail:progress');
    ipcRenderer.on('mail:progress', (_e, done: number, total: number) => cb(done, total));
  },
  onNewMail: (cb: (accountId: string, grew: boolean) => void) => {
    ipcRenderer.on('mail:new', (_e, accountId: string, grew: boolean) => cb(accountId, !!grew));
  },
  onMailSent: (cb: () => void) => {
    ipcRenderer.on('mail:sent', () => cb());
  },
  onOpenMail: (cb: (ref: { accountId: string; folder: string; uid: number }) => void) => {
    ipcRenderer.on('mail:open', (_e, ref) => cb(ref));
  },
  sounds: {
    list: () => ipcRenderer.invoke('sounds:list'),
    data: (id: string) => ipcRenderer.invoke('sounds:data', id),
    openFolder: () => ipcRenderer.invoke('sounds:openFolder'),
  },
});
