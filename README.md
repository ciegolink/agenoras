# Agenoras

Desktop mail, calendar, contacts and tasks in one app, built by [CiegoLink](https://ciegolink.com).

Agenoras is an Electron + TypeScript client for standard protocols: IMAP/SMTP for mail, CalDAV for calendars and tasks, CardDAV for contacts. It works with Nextcloud, iCloud, Gmail (app password), Dovecot/Postfix hosting and most other providers. The user interface is available in German and English.

[User manual](docs/USER_MANUAL.md) · [Wiki](https://github.com/ciegolink/agenoras/wiki) · [Issues](https://github.com/ciegolink/agenoras/issues) · [ciegolink.com](https://ciegolink.com)

## Download

[![Latest release](https://img.shields.io/github/v/release/ciegolink/agenoras?label=release)](https://github.com/ciegolink/agenoras/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-2BA89F)](LICENSE)

| Platform | Download |
|---|---|
| Windows | [Installer (.exe)](https://github.com/ciegolink/agenoras/releases/latest/download/Agenoras-Setup.exe) · [Portable (.exe)](https://github.com/ciegolink/agenoras/releases/latest/download/Agenoras-Portable.exe) |
| Linux | [Debian/Ubuntu (.deb)](https://github.com/ciegolink/agenoras/releases/latest/download/agenoras_amd64.deb) · [AppImage](https://github.com/ciegolink/agenoras/releases/latest/download/Agenoras-x86_64.AppImage) |
| macOS | [Disk image (.dmg)](https://github.com/ciegolink/agenoras/releases/latest/download/Agenoras.dmg) · [Zip](https://github.com/ciegolink/agenoras/releases/latest/download/Agenoras-mac.zip) (Intel + Apple Silicon) |

All versions and release notes: [Releases](https://github.com/ciegolink/agenoras/releases).

- **Windows:** run the installer; SmartScreen may warn about an unknown publisher → **More info → Run anyway**.
- **Ubuntu/Debian:** `sudo apt install ./agenoras_amd64.deb`
- **AppImage:** `chmod +x Agenoras-x86_64.AppImage`, then start it.
- **macOS:** open the `.dmg` and drag Agenoras to Applications. The app is not signed: on first start right-click it → **Open**, or run `xattr -cr /Applications/Agenoras.app`.

## Features

**Mail**
- Multiple IMAP/SMTP accounts with a unified inbox and live updates (IDLE)
- Folder tree per account with unread counts; expand/collapse state is remembered
- Server-side full-text search (current folder or everywhere), filters for unread, attachments and starred mail
- Star (`\Flagged`), categories (colored labels), spam/not spam, archive, delete, drag and drop onto folders
- Multi-select (Ctrl/Shift+click, Ctrl+A), context menu, open a mail in its own window
- Rules: conditions on sender, recipient or subject; actions move, mark read, star, categorize, spam, delete. Rules also run for mail that arrived while the app was closed
- External images blocked by default, with per-mail and per-sender approval
- Optional marking of external senders (outside your own domains)
- Sender pictures from contact photos or website favicons, initials as fallback
- Desktop notifications, notification sounds per account, tray icon with background mode

**Compose**
- WYSIWYG editor with sanitized paste, inline images, links and plain-text alternative
- Multiple recipients in To/Cc/Bcc with suggestions from contacts and previous correspondents
- Send to all or individually to each recipient, with placeholders such as `{{FirstName}}`
- Sender identities and aliases per account, each with a text or HTML signature
- Templates, priority, attachments by drag and drop, adjustable undo delay (0–5 s)

**Calendar and tasks**
- CalDAV week view with month overview, drag to move or resize, drag on an empty slot to create
- Recurring events with series/occurrence editing, exceptions and time zones
- Attendees and invitations by mail (iMIP): send, accept, decline, apply replies and cancellations
- Move events between calendars, send events as `.ics`, event search
- CalDAV tasks (VTODO) with due dates, priority, lists per account and a "My day" sidebar

**Contacts**
- CardDAV address books with photo upload, create contacts directly from a mail

**General**
- Local SQLite cache for fast startup and offline reading
- Light and dark theme, three font sizes, configurable week start
- Window size, position and column widths are remembered
- About dialog with version info and links (gear menu → About Agenoras)

## Getting started

Requirements: Node.js 22 or newer.

```bash
npm install
npm start
```

On first start, add an account via **Settings → Accounts**.

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for a full setup guide (Ubuntu and Windows), VS Code integration, debugging and troubleshooting.

### Scripts

| Command | Description |
|---|---|
| `npm start` | Compile and start the app |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run watch` | Compile on every save |
| `npm run icons` | Generate app and tray icons from `build/logo.png` |
| `npm run dist:linux` | Build Linux packages (AppImage, .deb) into `release/` |
| `npm run dist:win` | Build Windows installer and portable `.exe` into `release/` |
| `npm run dist:mac` | Build macOS `.dmg` and `.zip` (universal: Intel + Apple Silicon), run on a Mac |

### Releases

Pushing a version tag builds Linux, Windows and macOS packages with GitHub Actions and attaches them to a draft release:

```bash
npm version patch        # or minor / major
git push --follow-tags
```

The workflow can also be started manually under **Actions → Build → Run workflow**; the packages are then available as run artifacts.

## Configuration

**Server addresses**

| Provider | Settings |
|---|---|
| Gmail | `imap.gmail.com` / `smtp.gmail.com`, use an app password |
| Nextcloud | CalDAV and CardDAV: `https://<host>/remote.php/dav` |
| iCloud | CalDAV `https://caldav.icloud.com`, CardDAV `https://contacts.icloud.com`, app password |

Microsoft 365 and Google Calendar require OAuth2, which is not supported yet.

**Logo**

Place your own logo at `build/logo.png`. It appears in the title bar, as the window icon and in the tray. Run `npm run icons` to generate the full icon set (`build/icon.png`, `build/icons/`, `build/icon.ico`, `build/tray*.png`).

**Sounds**

Notification sounds go into `sounds/`. See [sounds/README.md](sounds/README.md).

**Environment variables**

| Variable | Effect |
|---|---|
| `AGENORAS_LANG=en` | Force a UI language |
| `AGENORAS_WAYLAND=1` | Use native Wayland instead of XWayland (Linux) |
| `AGENORAS_GPU=1` | Enable hardware acceleration (disabled by default on Linux) |

## Data and security

User data is stored in `~/.config/agenoras/` (Linux), `%APPDATA%\agenoras\` (Windows) or `~/Library/Application Support/agenoras/` (macOS):

- `accounts.json`, `calendars.json`, `contacts.json`: accounts; passwords are encrypted with the OS keychain via Electron `safeStorage`
- `settings.json`: identities, signatures, templates, rules, preferences
- `cache.db`: local cache, safe to delete at any time

Data from earlier versions (folder `ciegolink-mail`) is copied over automatically on first start; the old folder can be deleted afterwards.

HTML mail is rendered in a sandboxed frame without scripts under a strict Content Security Policy. Remote content is fetched only by the main process and only on request.

## Project structure

```
├─ lang/                 UI strings (de.json, en.json; English is the fallback)
├─ build/                App and tray icons
├─ scripts/make-icons.js Icon generator
├─ sounds/               Notification sounds
└─ src/
   ├─ main/              Electron main process
   │  ├─ main.ts         Windows, tray, notifications, IPC
   │  ├─ preload.ts      window.api bridge for the renderer
   │  ├─ imap.ts         IMAP connection, IDLE, folders, mail operations
   │  ├─ smtp.ts         Sending, attachments, individual sending
   │  ├─ caldav.ts       Calendars, events, recurrence (ical.js)
   │  ├─ invites.ts      Meeting invitations (iMIP)
   │  ├─ tasks.ts        CalDAV tasks (VTODO)
   │  ├─ carddav.ts      Address books, vCards
   │  ├─ rules.ts        Mail rules
   │  ├─ cache.ts        SQLite cache (node:sqlite)
   │  ├─ remote.ts       Favicons, external images, HTML signatures
   │  ├─ settings.ts     Identities, signatures, templates, preferences
   │  ├─ accounts.ts     Mail accounts
   │  ├─ davaccounts.ts  CalDAV/CardDAV accounts
   │  ├─ sounds.ts       Notification sounds
   │  ├─ winstate.ts     Window state
   │  └─ i18n.ts         Language selection
   └─ renderer/          UI (no Node access)
      ├─ index.html      Main window
      ├─ compose.html    Compose window
      ├─ mailview.html   Mail in its own window
      ├─ styles.css
      ├─ common.ts       Shared helpers, i18n, HTML sanitizer
      ├─ renderer.ts     Mail view
      ├─ reader.ts       Mail display (reading pane and mail window)
      ├─ compose.ts      Editor, recipients, attachments, sending
      ├─ calendar.ts     Calendar view
      ├─ tasks.ts        Task view
      ├─ contacts.ts     Contacts view
      ├─ agenda.ts       "My day" sidebar
      ├─ labels.ts       Categories
      ├─ settings.ts     Settings dialog
      └─ types.d.ts
```

## Translations

UI strings live in `lang/<code>.json`. The app uses the system language if a file exists for it, otherwise English. To add a language, copy `lang/en.json` (for example to `lang/fr.json`) and translate it; missing keys fall back to English. Template placeholders work in both languages (`{{Vorname}}` = `{{FirstName}}`).

## Tech stack

[Electron](https://www.electronjs.org/), TypeScript, [ImapFlow](https://github.com/postalsys/imapflow), [Nodemailer](https://nodemailer.com/), [mailparser](https://github.com/nodemailer/mailparser), [tsdav](https://github.com/natelindev/tsdav), [ical.js](https://github.com/kewisch/ical.js), `node:sqlite`.

## License

[MIT](LICENSE) © 2026 CiegoLink GmbH
