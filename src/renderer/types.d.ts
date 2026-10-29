interface Account {
  id: string;
  name: string;
  email: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  color: string;
  private?: boolean; // protected by a PIN
  autoLockMin?: number;
  protocol?: 'imap' | 'pop3'; // incoming mail (missing = IMAP)
  leaveOnServer?: boolean; // POP3: keep a copy on the server
  deleteAfterDays?: number; // POP3: delete the server copy after N days (0 = never)
}

interface AiState {
  enabled: boolean;
  model: string;
  lang: string; // output language: auto | de-CH | de-DE | en | fr | it
  translateLang: string; // default translation target, '' = app language
  ready: boolean; // enabled and the active model is downloaded
  models: { id: string; name: string; size: number; downloaded: boolean }[];
  download: { id: string; received: number; total: number } | null;
}

interface LogEntry {
  id: number;
  time: string;
  level: 'error' | 'warn';
  source: string;
  account: string;
  message: string;
  count: number;
}

interface LogState {
  total: number;
  unseen: number;
}

interface PrivacyState {
  locked: number; // private accounts currently locked
  unlocked: number; // private accounts currently open
}

interface NewAccountInput {
  name: string;
  email: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  pass: string;
  color?: string;
  pin?: string;
  autoLockMin?: number;
  protocol?: 'imap' | 'pop3';
  leaveOnServer?: boolean;
  deleteAfterDays?: number;
}

interface OutgoingMail {
  identityId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  files?: string[];
  html?: string;
  priority?: Priority;
  forward?: { accountId: string; folder: string; uid: number; indexes: number[] };
  extraAttachments?: { filename: string; content: string; contentType: string }[];
  individual?: { to: string; subject: string; text: string; html?: string }[];
}

interface SendResult {
  sent: number;
  failed: { to: string; message: string }[];
}

interface Identity {
  id: string;
  accountId: string;
  name: string;
  email: string;
  signature: string;
  signatureHtml?: string;
  primary: boolean;
}

interface Template {
  id: string;
  name: string;
  subject: string;
  body: string;
  html?: string;
}

interface FolderInfo {
  path: string;
  name: string;
  depth: number;
  specialUse: string;
  unseen: number;
  selectable: boolean;
}

interface PickedFile {
  path: string;
  name: string;
  size: number;
}

// What the main window passes to the compose window
interface ComposeOpts {
  accountId?: string;
  matchAddresses?: string[]; // addresses of the original mail → pick the matching sender (alias)
  to?: string | string[];
  cc?: string | string[];
  subject?: string;
  quoteHtml?: string; // quoted/forwarded part, goes below the signature
  inReplyTo?: string;
  references?: string[];
  mode?: 'new' | 'reply' | 'replyAll' | 'forward';
  sendMode?: 'all' | 'each'; // preselect "Individually to each"
  forward?: { accountId: string; folder: string; uid: number; attachments: { filename: string; size: number }[] };
  files?: PickedFile[];
  attachData?: { filename: string; content: string; contentType: string }[]; // e.g. an event as .ics
}

interface MailSummary {
  accountId: string;
  folder: string;
  uid: number;
  from: string;
  fromAddress: string;
  toName?: string;
  subject: string;
  date: string;
  seen: boolean;
  hasAttachments: boolean;
  priority?: Priority;
  messageId?: string;
  inReplyTo?: string;
  flagged?: boolean;
  toAddress?: string;
}

interface RuleCondition {
  field: 'from' | 'to' | 'subject' | 'any';
  op: 'contains' | 'equals' | 'startsWith' | 'endsWith';
  value: string;
}

interface MailRule {
  id: string;
  name: string;
  enabled: boolean;
  accountId: string;
  match: 'all' | 'any';
  conditions: RuleCondition[];
  hasAttachment: boolean;
  actions: { move?: string; read?: boolean; flag?: boolean; label?: string; delete?: boolean; spam?: boolean };
  stop: boolean;
}

interface MailLabel {
  id: string;
  name: string;
  color: string;
}

type Priority = 'high' | 'normal' | 'low';
interface NotifySettings {
  enabled: boolean;
  sound: string; // 'builtin' | 'none' | sound ID
  volume: number;
  perAccount: Record<string, string>; // '' or missing = default
  desktop?: boolean;
  desktopOff?: string[];
  background?: boolean;
  sentSound?: string;
}
type MailRef = { accountId: string; folder: string; uid: number };

interface MailDetail {
  accountId: string;
  folder: string;
  uid: number;
  subject: string;
  fromName: string;
  fromAddress: string;
  to: string;
  toList: string[];
  ccList: string[];
  replyTo: string;
  messageId: string;
  references: string[];
  date: string;
  html: string | null;
  text: string;
  priority?: Priority;
  remoteImages?: boolean; // HTML contains external images
  imagesLoaded?: boolean; // … and they were loaded
  invite?: InviteInfo | null;
  attachments: { filename: string; size: number; contentType: string }[];
}

interface CalAccount {
  id: string;
  name: string;
  serverUrl: string;
  username: string;
}

interface CalendarInfo {
  id: string;
  accountId: string;
  accountName: string;
  name: string;
  color: string;
}

interface CalEvent {
  id: string;
  calendarId: string;
  url: string;
  title: string;
  location: string;
  description: string;
  start: string;
  end: string;
  allDay: boolean;
  recurring: boolean;
  occurrence?: string;
  rrule?: RRuleInfo | null;
  organizer?: Person | null;
  attendees?: Person[];
  uid?: string;
}

interface Person {
  email: string;
  name: string;
  partstat?: string;
}

interface InviteInfo {
  method: string;
  uid: string;
  sequence: number;
  summary: string;
  location: string;
  description: string;
  start: string;
  end: string;
  allDay: boolean;
  recurring: boolean;
  organizer: Person | null;
  attendees: Person[];
}

interface RRuleInfo {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  byday: string[];
  until?: string;
  count?: number;
  custom?: boolean;
}

interface EventInput {
  calendarId: string;
  url?: string;
  title: string;
  location: string;
  description: string;
  start: string;
  end: string;
  allDay: boolean;
  rrule?: RRuleInfo | null;
  scope?: 'series' | 'occurrence';
  occurrence?: string;
  origStart?: string;
  attendees?: { email: string; name?: string }[];
  organizer?: { email: string; name?: string };
  moveTo?: string;
}

interface TaskList {
  id: string;
  accountId: string;
  accountName: string;
  name: string;
  color: string;
}

interface Task {
  id: string;
  listId: string;
  title: string;
  notes: string;
  due: string;
  done: boolean;
  completed: string;
  priority: Priority;
  created: string;
}

interface TaskInput {
  listId: string;
  id?: string;
  title: string;
  notes: string;
  due: string;
  done: boolean;
  priority: Priority;
}

interface AddressBookInfo {
  id: string;
  accountId: string;
  accountName: string;
  name: string;
}

interface Labeled {
  type: string;
  value: string;
}

interface Contact {
  id: string;
  bookId: string;
  accountId: string;
  name: string;
  firstName: string;
  lastName: string;
  org: string;
  title: string;
  emails: Labeled[];
  phones: Labeled[];
  note: string;
  birthday: string;
  photo?: string;
}

interface ContactInput {
  bookId: string;
  url?: string;
  firstName: string;
  lastName: string;
  org: string;
  title: string;
  emails: string[];
  phones: string[];
  note: string;
  photo?: string | null;
}

interface DavAccountInput {
  name: string;
  serverUrl: string;
  username: string;
  password: string;
}

interface Window {
  i18n: { lang: string; locale: string; strings: Record<string, string>; weekStart?: number };
  api: {
      appInfo(): Promise<{ version: string; electron: string; chrome: string; node: string; platform: string }>;
    platform: string;
    win: {
      minimize(): Promise<void>;
      toggleMaximize(): Promise<void>;
      close(): Promise<void>;
      isMaximized(): Promise<boolean>;
      onState(cb: (maximized: boolean) => void): void;
    };
    listAccounts(): Promise<Account[]>;
    addAccount(input: NewAccountInput): Promise<Account>;
    removeAccount(id: string): Promise<void>;
    updateAccount(id: string, input: Omit<NewAccountInput, 'pass'> & { pass?: string }): Promise<Account>;
    setAccountColor(id: string, color: string): Promise<Account>;
    ai: {
      state(): Promise<AiState>;
      enable(on: boolean): Promise<AiState>;
      setModel(id: string): Promise<AiState>;
      setLang(lang: string): Promise<AiState>;
      setTranslateLang(lang: string): Promise<AiState>;
      download(id: string): Promise<AiState>;
      cancel(): Promise<void>;
      remove(id: string): Promise<AiState>;
      subjects(text: string): Promise<string[]>;
      proofread(text: string): Promise<string>;
      write(instruction: string, ctx?: { original?: string; subject?: string }): Promise<string>;
      translate(text: string, target: string): Promise<string>;
      onState(cb: (state: AiState) => void): void;
    };
    log: {
      state(): Promise<LogState>;
      list(): Promise<LogEntry[]>;
      seen(): Promise<LogState>;
      clear(): Promise<LogState>;
      onChanged(cb: (state: LogState) => void): void;
    };
    privacy: {
      state(): Promise<PrivacyState>;
      unlock(pin: string): Promise<number>;
      lock(): Promise<void>;
      set(id: string, pin: string | null, autoLockMin?: number): Promise<Account>;
      activity(): Promise<void>;
      onChanged(cb: (state: PrivacyState) => void): void;
    };
    listFolders(accountId: string): Promise<FolderInfo[]>;
    cachedFolders(accountId: string): Promise<FolderInfo[]>;
    moveMails(accountId: string, folder: string, uids: number[], target: string): Promise<void>;
    deleteMails(accountId: string, folder: string, uids: number[]): Promise<'trash' | 'deleted'>;
    emptyTrash(accountId: string): Promise<number>;
    markFolderSeen(accountId: string, folder: string): Promise<number>;
    react(accountId: string, folder: string, uid: number, emoji: string): Promise<string>;
    junkToTrash(accountId: string): Promise<number>;
    cachedMail(accountId: string | null, folder?: string): Promise<MailSummary[]>;
    listMail(accountId: string | null, folder?: string): Promise<{ mails: MailSummary[]; errors: { accountId: string; message: string }[] }>;
    getMail(accountId: string, folder: string, uid: number, loadImages?: boolean, markRead?: boolean): Promise<MailDetail>;
    setSeen(accountId: string, folder: string, uids: number[], seen: boolean): Promise<void>;
    setFlagged(accountId: string, folder: string, uids: number[], flagged: boolean): Promise<void>;
    flaggedMails(): Promise<{ mails: MailSummary[]; errors: { accountId: string; message: string }[] }>;
    cachedFlagged(): Promise<MailSummary[]>;
    mailsByMessageIds(ids: string[]): Promise<MailSummary[]>;
    knownAddresses(): Promise<{ name: string; address: string }[]>;
    searchMail(accountId: string | null, folder: string | null, query: string): Promise<{ mails: MailSummary[]; errors: { accountId: string; message: string }[] }>;
    searchCachedMail(accountId: string | null, folder: string | null, query: string): Promise<MailSummary[]>;
    avatars(emails: string[]): Promise<Record<string, string | null>>;
    invite: {
      respond(accountId: string, folder: string, uid: number, partstat: 'ACCEPTED' | 'TENTATIVE' | 'DECLINED', calendarId: string | null): Promise<boolean>;
      apply(accountId: string, folder: string, uid: number): Promise<boolean>;
    };
    mailview: {
      open(ref: MailRef): Promise<void>;
      init(): Promise<MailRef | null>;
    };
    sendMail(mail: OutgoingMail): Promise<SendResult>;
    onSendProgress(cb: (done: number, total: number) => void): void;
    onStatus(cb: (text: string) => void): void;
    compose: {
      open(opts: ComposeOpts): Promise<void>;
      init(): Promise<ComposeOpts>;
      done(status: string): Promise<void>;
      sent(): Promise<void>;
      focusPopup(): Promise<void>;
      onDim(cb: (on: boolean) => void): void;
    };
    settings: {
      get(): Promise<{ identities: Identity[]; templates: Template[]; theme: 'dark' | 'light' | 'system'; notify?: NotifySettings; labels?: MailLabel[]; mailLabels?: Record<string, string[]>; uiScale?: 'small' | 'medium' | 'large'; language?: string; weekStart?: number; sendDelay?: number; readDelay?: number; composeMode?: 'window' | 'popup'; externalMark?: boolean; internalDomains?: string[]; accountLabel?: 'name' | 'email'; rules?: MailRule[] }>;
      saveLabels(list: MailLabel[]): Promise<MailLabel[]>;
      savePrefs(p: { uiScale?: 'small' | 'medium' | 'large'; language?: string; weekStart?: number; sendDelay?: number; readDelay?: number; composeMode?: 'window' | 'popup'; externalMark?: boolean; internalDomains?: string[]; accountLabel?: 'name' | 'email' }): Promise<{ restartNeeded: boolean }>;
      saveRules(list: MailRule[]): Promise<MailRule[]>;
      runRules(accountId: string | null): Promise<{ matched: number; moved: number }>;
      languages(): Promise<string[]>;
      relaunch(): Promise<void>;
      setMailLabel(keys: string[], labelId: string, on: boolean): Promise<Record<string, string[]>>;
      saveNotify(n: NotifySettings): Promise<NotifySettings>;
      setTheme(theme: 'dark' | 'light' | 'system'): Promise<string>;
      signatureFile(): Promise<string | null>;
      trustSender(email: string): Promise<void>;
      saveIdentities(list: Identity[]): Promise<Identity[]>;
      saveTemplates(list: Template[]): Promise<Template[]>;
    };
    saveAttachment(accountId: string, folder: string, uid: number, index: number): Promise<string | null>;
    openAttachment(accountId: string, folder: string, uid: number, index: number): Promise<void>;
    files: {
      pick(): Promise<PickedFile[]>;
      dropped(file: File): Promise<PickedFile>;
    };
    cal: {
      listAccounts(): Promise<CalAccount[]>;
      addAccount(input: DavAccountInput): Promise<CalAccount>;
      addLocalAccount(name: string): Promise<CalAccount>;
      removeAccount(id: string): Promise<void>;
      updateAccount(id: string, input: DavAccountInput): Promise<CalAccount>;
      cached(calendarIds: string[], start: string): Promise<{ calendars: CalendarInfo[]; events: CalEvent[] }>;
      listCalendars(): Promise<{ calendars: CalendarInfo[]; errors: { accountId: string; message: string }[] }>;
      listEvents(calendarIds: string[], start: string, end: string): Promise<{ events: CalEvent[]; errors: { calendarId: string; message: string }[] }>;
      saveEvent(input: EventInput, invite?: { identityId: string }): Promise<{ invited: number } | void>;
      ics(url: string): Promise<string | null>;
      search(query: string, calendarIds: string[]): Promise<CalEvent[]>;
      deleteEvent(url: string, occurrence?: string, cancel?: { identityId: string }): Promise<void>;
    };
    tasks: {
      cached(): Promise<{ lists: TaskList[]; tasks: Task[] }>;
      list(): Promise<{ lists: TaskList[]; tasks: Task[]; errors: { accountId: string; message: string }[] }>;
      save(input: TaskInput): Promise<void>;
      delete(id: string): Promise<void>;
    };
    contacts: {
      listAccounts(): Promise<CalAccount[]>;
      addAccount(input: DavAccountInput): Promise<CalAccount>;
      addLocalAccount(name: string): Promise<CalAccount>;
      removeAccount(id: string): Promise<void>;
      updateAccount(id: string, input: DavAccountInput): Promise<CalAccount>;
      cached(): Promise<{ books: AddressBookInfo[]; contacts: Contact[] }>;
      list(): Promise<{ books: AddressBookInfo[]; contacts: Contact[]; errors: { accountId: string; message: string }[] }>;
      save(input: ContactInput): Promise<void>;
      delete(url: string): Promise<void>;
    };
    onNewMail(cb: (accountId: string, grew: boolean) => void): void;
    onOpenMail(cb: (ref: MailRef) => void): void;
    onMailSent(cb: () => void): void;
    sounds: {
      list(): Promise<{ id: string; name: string }[]>;
      data(id: string): Promise<string | null>;
      openFolder(): Promise<void>;
    };
  };
}
