# Agenoras User Manual

Agenoras brings mail, calendar, contacts, tasks and news feeds together in one desktop app for Windows, Linux and macOS. It uses open standards (IMAP, POP3, SMTP, CalDAV, CardDAV), so it works with Nextcloud, iCloud, Gmail, your own mail server and most other providers. Calendars, tasks and contacts can also be kept on your computer without a server, and an optional offline AI helps you write, proofread and translate emails without sending your texts anywhere.

This manual explains how to use the app. If you want to build or change Agenoras itself, see [DEVELOPMENT.md](DEVELOPMENT.md).

## Contents

1. [Installation](#1-installation)
2. [First start: adding accounts](#2-first-start-adding-accounts)
3. [The main window](#3-the-main-window)
4. [Mail](#4-mail)
5. [Writing emails](#5-writing-emails)
6. [Rules](#6-rules)
7. [Calendar](#7-calendar)
8. [Tasks](#8-tasks)
9. [Contacts](#9-contacts)
10. [Feeds](#10-feeds)
11. [Settings](#11-settings)
12. [Keyboard shortcuts](#12-keyboard-shortcuts)
13. [Your data and privacy](#13-your-data-and-privacy)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Installation

Download the right file for your system from the [latest release](https://github.com/ciegolink/agenoras/releases/latest).

| System | File | How to install |
|---|---|---|
| Windows | `Agenoras-Setup.exe` | Run the installer. If SmartScreen warns about an unknown publisher, click **More info → Run anyway**. |
| Windows (no install) | `Agenoras-Portable.exe` | Start the file directly. |
| Ubuntu / Debian | `agenoras_amd64.deb` | `sudo apt install ./agenoras_amd64.deb` |
| Other Linux | `Agenoras-x86_64.AppImage` | `chmod +x Agenoras-x86_64.AppImage`, then start it. |
| macOS | `Agenoras.dmg` | Open it and drag Agenoras to **Applications**. |

The macOS version runs on both Intel and Apple Silicon Macs.

## 2. First start: adding accounts

On first start, open **Settings → Accounts**. Agenoras has four kinds of accounts. Add only the ones you need.

### Email account (IMAP or POP3)

Click **+ Email account** and fill in:

- **Display name**: the name others see as the sender (e.g. your name or company)
- **Email** and **Password**
- **Incoming**: **IMAP** (recommended) or **POP3**, with server and port
- **SMTP server** with port
- **SSL/TLS**: on for port 465, off for STARTTLS on port 587
- **Colour**: pick one of the colours or a custom colour. The account is marked with it in the sidebar and the mail list.

Click **Connect →**. Agenoras checks the login right away and loads your folders.

**POP3** only fetches the inbox, every 2 minutes. Folders, read status, stars and sent mail then exist only on this computer. Choose whether to **Leave a copy on the server** and whether to delete the server copy after a number of days. If you also read your mail on other devices, use IMAP instead.

### Private account with a PIN

Tick **Private account – visible only with a PIN** and enter a PIN of 4–8 digits. While the account is locked it is invisible: no mails, no search hits, no notifications.

- Unlock it with **Unlock private** in the sidebar and your PIN; **Lock private** locks it again.
- **Lock automatically** locks it after a few minutes without use.
- After a restart every private account starts locked. Locking removes the mails stored on this computer; they are loaded again after unlocking.

### Calendar account (CalDAV)

Click **+ CalDAV account**, enter a name, the **Server URL**, your username and password. All calendars and task lists on that server appear automatically.

### Contacts account (CardDAV)

Click **+ CardDAV account** and fill in the same fields as for CalDAV.

### RSS feed

Click **+ RSS feed** and enter the address of a feed or simply of a website. See [Feeds](#10-feeds).

### Calendar, tasks and contacts without a server

Don't have a CalDAV or CardDAV server? Choose **Only on this computer (no server)** when adding the account. Events, tasks or contacts are then stored only on this computer (file `local.db`, see [Your data and privacy](#13-your-data-and-privacy)). They are not synced to other devices, so include the file in your backup.

### Server addresses for common providers

| Provider | Settings |
|---|---|
| Gmail | IMAP `imap.gmail.com`, SMTP `smtp.gmail.com`. Use an [app password](https://myaccount.google.com/apppasswords), not your normal password. |
| Nextcloud | CalDAV and CardDAV: `https://<your-server>/remote.php/dav` |
| iCloud | CalDAV `https://caldav.icloud.com`, CardDAV `https://contacts.icloud.com`. Use an app password from your Apple ID settings. |

> **Not supported yet:** Microsoft 365 / Outlook.com and Google Calendar/Contacts need OAuth2 sign-in, which Agenoras doesn't support yet.

To change an account later, click **Edit** next to it. Leave the password field empty to keep the current password.

## 3. The main window

The buttons at the bottom of the sidebar switch between **Mail**, **Calendar**, **Contacts**, **Tasks** and **Feed** (only shown once you have added a feed); they always stay in place, only the list above them scrolls. **Settings** are in the gear menu at the top right.

- **Columns** can be resized by dragging their edges. Double-click an edge to reset it. Agenoras remembers window size, position and column widths.
- **My day** is a side panel with a small month calendar, today's and tomorrow's events and your tasks. Open or close it with the panel button in the toolbar. Use **+ Event** and **+ Task for today** to add items quickly.
- **Tray icon**: if background mode is on (see [Notifications](#notifications)), closing the window keeps Agenoras running in the tray. Right-click the tray icon to open the app, write a new email or quit.
- **About**: gear menu → **About Agenoras** shows the version and links to the wiki and bug reports.
- **Search**: the field in the title bar searches everything, see [Search](#search) below.
- **Problems**: when a connection to a mail, calendar or contacts server fails, a warning sign appears in the title bar, with the number of new problems. Click it to see what went wrong. The log contains errors only; you can **Copy** it (e.g. for a bug report) or **Clear** it. See also [Troubleshooting](#14-troubleshooting).

### Search

The search field in the title bar searches everything: emails (full text on the server), appointments, contacts, tasks and feed articles. Press **Ctrl+K** or **Ctrl+F** to jump into it from anywhere. As soon as you type, the search page opens:

- **Results** (left): **All**, **Mails**, **Appointments**, **Contacts**, **Tasks** and **Feeds**, each with its number of hits. Click one to see only that kind.
- **Mails from** (left): all accounts or a single account. Emails are always searched in all folders.
- The hits are in the middle, an email opens in the preview on the right. Appointments, contacts, tasks and feed articles open in their own view; click into the search field again to get back to the hits.
- The **All**, **Unread**, attachment and star buttons above the hits filter the email results.

Click **×** in the search field or press **Esc** to close the search and return to where you were.

## 4. Mail

### Folders and inboxes

The sidebar shows **All inboxes** (a unified inbox for all accounts) and below it a folder tree for each account, with unread counts. Click the arrow next to a folder to expand or collapse it; Agenoras remembers your choice.

New mail arrives live without refreshing. To check manually, press **F5** or **Ctrl+R**.

Right-click a folder for:

- **Mark all as read** – every folder
- **Empty trash** – the trash folder, after you confirm; this deletes the mails permanently
- **Move all to trash** – the spam folder, after you confirm

### Reading mail

Click an email to show it in the reading pane. **Double-click** opens it in its own window.

An opened email counts as read after 3 seconds, so quickly clicking through the list doesn't mark everything as read. You can change this to **Immediately**, another delay or **Only by hand** under **Settings → Senders & signatures → Mark as read**.

Buttons in the email header: **Reply**, **Reply all**, **Forward**, a reaction button (😊), **Archive**, **Delete**.

### Right-click inside an email

Right-click anywhere in the text of an email for:

- **Reply** and **Reply all**
- **Reply only to** a single person in the conversation (sender, To or Cc)
- A row of **reactions** (👍 ❤️ 😂 😮 😢 🙏 🎉)
- With selected text: **Copy**, and **Translate → *language*** if the offline AI is on (see [Writing emails](#5-writing-emails))

The translation opens in a small panel next to the text, with a **Copy** button. The target language is set under **Settings → AI → Default translation**.

### Reactions

Hover over the 😊 button (or right-click in the email) and pick an emoji. Agenoras sends it right away as a short reply mail to the sender, with the original message quoted below, so it works with every mail program.

Click on a sender or recipient name for more options: write an email, copy the address or name, or **Add as contact**.

### Selecting several emails

- **Ctrl+click** (Cmd+click on macOS): add or remove single emails
- **Shift+click**: select a range
- **Ctrl+A**: select all emails in the list
- **Esc**: clear the selection

Selected emails are highlighted, unread ones too. You can then drag them onto a folder or category, or use the right-click menu.

### Right-click menu

Right-click an email (or a selection) to:

- Mark as read / unread
- **Mark as important** (star) or remove the star
- Assign or remove a **category**
- **Move to spam** or **Not spam – move to inbox**
- Archive, move or delete
- Open in a new window
- **Create rule …** from this email (see [Rules](#6-rules))

### Conversations

Click the conversation button in the list header (next to the filters) to group replies for the open account. The button is shown when a single account or folder is open and is switched on or off per account.

- A conversation shows as one row with its newest email and a counter. Click the counter to expand or collapse the older emails; an open conversation is lightly highlighted.
- The row is bold when its newest email is unread; unread older emails colour the counter instead.
- Dragging a collapsed conversation onto a folder moves all its emails.

Emails belong together when one answers another. Conversations are grouped per folder, so your own replies (in **Sent**) are not shown in the inbox. During a search and in **Important** and categories the list is not grouped.

### Deleting

**Delete** (or the **Del** key) moves emails to the trash. In the **Trash** folder, deleting removes them permanently after you confirm.

Deleted something by mistake? **Ctrl+Z** moves the emails back to the folder they came from. This also undoes moving, archiving and **Move to spam**, step by step for up to 20 steps, until you quit the app. Permanently deleted emails can't be restored.

### Filters and quick filter

The bar above the list filters the current folder:

- **All** or only **Unread** emails
- the paper clip: emails with an attachment; the star: **Important** (starred) emails
- **Filter …** narrows the list instantly by sender, recipient and subject. It only looks at the emails already loaded in this folder and doesn't search the message text. If nothing matches, click **Search everywhere for "…"** to run the full [search](#search); when there are matches, the link below the list does the same. **Esc** clears the field.

Contacts, tasks and feeds have the same filter bar.

### Categories

Categories are colored labels for your emails, such as "Customer" or "Invoice".

- Create and edit them under **Settings → Categories**.
- Assign one by right-clicking an email or dragging emails onto the category in the sidebar.
- A category appears in the sidebar under **All inboxes** as soon as it contains emails. Click it to see all emails in that category.

### Attachments

Click an attachment to open it, or use **Save** to store it. For your safety, executable files (such as `.exe`) are never opened directly; save them instead.

### External images

Images from the internet are blocked by default, because they can tell the sender that you opened the email. Click **Load images** to show them for this email, or **Always load from …** to trust this sender permanently.

### External senders

If you turn on **Mark external senders** (Settings → Appearance), emails from outside your own domains get an **External** tag in the list and a warning in the email. You can add more internal domains there.

## 5. Writing emails

Click **New email** in the sidebar. The compose window opens: by default as a separate window, or as a fixed popup over the main window (Settings → Appearance → **Compose**). The popup can't be moved; it stays in the middle of the main window, which is darkened behind it.

The toolbar shows icons only; hover over an icon to see what it does.

### Recipients

Type a name or address into **To**, **Cc** or **Bcc**. Agenoras suggests addresses from your contacts and people you have emailed before. Use the arrow keys and **Enter** or **Tab** to pick one. Separate several recipients with **Enter**, a comma or a semicolon. **Backspace** in an empty field removes the last recipient. Type the name of a [distribution list](#distribution-lists) to add all its recipients at once.

### Sender

Choose the sender address under **From**. When you reply, Agenoras automatically picks the address the email was sent to. Aliases are set up under **Settings → Senders & signatures**.

### Text and formatting

The editor works like a word processor: paragraph styles, **bold** (Ctrl+B), *italic* (Ctrl+I), underline (Ctrl+U), strikethrough, text color, lists, links (Ctrl+K) and **Clear formatting**. Text you paste from other programs is cleaned up automatically.

**Images** can be inserted with the image button or by dragging them onto the text (max. 5 MB each).

### Attachments

Click **Attach file** or simply drag files into the window. All attachments together can be up to 25 MB.

### Priority

Set the priority to **High**, **Normal** or **Low**. Recipients see high-priority emails marked as important.

### Templates

Click the template button to insert a saved template, or **Save as template** to save the current email for later. Templates are managed under **Settings → Templates**.

### Writing with the offline AI

If the offline AI is switched on (**Settings → AI**), the compose window has these extra buttons:

- **Generate text** (✦): describe in a few words what the email should say, e.g. "accept, Tuesday 10 am works, ask about parking", and press **Generate text** or **Ctrl+Enter**. The AI writes a draft that you can **Insert into mail** or **Regenerate**. When replying, it knows the email you are answering and writes in its language, even if your description is in another language. If a signature is in the email, the AI leaves out the closing and your name.
- **Suggest a subject** (✦ next to the subject): three suggestions based on your text.
- **Proofread**: corrects spelling, grammar and punctuation of your own text (not the signature or the quoted email). With a selection only the selection is checked. **Ctrl+Z** undoes the changes.
- **Translate**: select text and click the translate button. It is replaced by its translation into your default language (Settings → AI). **Ctrl+Z** undoes it.

Generating takes about 5–20 seconds. The AI is small and can make mistakes – always read the text before sending.

### Sending to many people individually: placeholders

You can write one email and send a personal copy to each recipient:

1. Add all recipients in **To**.
2. Insert placeholders with the placeholder button, for example `Hello {{FirstName}},`.
3. Click the arrow next to **Send** and choose **Send individually**.

Each recipient then gets their own email with the placeholders filled in from your contacts. Cc and Bcc are ignored in this mode.

| Placeholder | Is replaced by |
|---|---|
| `{{FirstName}}` | First name |
| `{{LastName}}` | Last name |
| `{{Name}}` | Full name |
| `{{Company}}` | Company |
| `{{Email}}` | Email address |
| `{{Date}}` | Today's date |

The German placeholders (`{{Vorname}}` etc.) work as well.

### Sending and undo

Click **Send →** or press **Ctrl+Shift+S**. If an undo delay is set (Settings → Senders & signatures → **Sending**, 0–5 seconds), you can click **Undo** (or press Esc / Ctrl+Z) during that time to stop the email and keep editing.

If you close the compose window without sending, Agenoras asks whether you want to discard the draft.

## 6. Rules

Rules sort incoming mail automatically. Open **Settings → Rules** and click **New rule**, or right-click an email and choose **Create rule …** to start with its sender already filled in.

A rule has:

- **Conditions**: *From*, *To*, *Subject* or *Anywhere* — *contains*, *is*, *starts with* or *ends with* a text. Optionally **only with attachment**.
- **If all / any** of the conditions match.
- **Actions**: **Move to** a folder, **Mark as read**, **Add star**, set a **Category**, **Move to spam** or **Delete**.
- **Stop processing more rules**: later rules are skipped for this email.
- The account the rule applies to, or **All accounts**.

Rules run from top to bottom for every new email in the inbox, including emails that arrived while Agenoras was closed. Use **Apply to inbox now** to run a rule on existing emails.

## 7. Calendar

The calendar shows a week view with a month overview. Use **Today**, **Previous week** and **Next week** to move around. Tick or untick calendars in the sidebar to show or hide them.

### Creating and changing events

- **New event**: click **New event**, or drag across an empty time slot.
- **Move**: drag the event to another time or day.
- **Change length**: drag the bottom edge of the event.
- **Edit**: click the event to open it. You can change title, time, location, notes, the calendar it belongs to, and set **All day**.

### Recurring events

Under **Repeat**, choose *Daily*, *Weekdays (Mon–Fri)*, *Weekly*, *Monthly* or *Yearly*, how often (**Every** …) and when it **Ends** (never, on a date, or after a number of times).

When you change, move or delete a recurring event, Agenoras asks whether this applies to **This event only** or the **Whole series**. Rules created in other apps that Agenoras can't edit are kept unchanged.

### Invitations

Add people under **Attendees** and turn on **Send invitations by email**. They receive a normal invitation that works with Outlook, Gmail, Apple Calendar and others. When you move or cancel the event, Agenoras offers to inform them.

When you receive an invitation, the email shows a card with **Accept**, **Maybe** and **Decline**. Your answer is sent to the organizer and the event is added to your calendar. Replies from your attendees can be applied with **Update calendar**.

### More

- **Search events** with the search field in the calendar.
- **Send by email** sends an event as an `.ics` file.

## 8. Tasks

Tasks are stored on your CalDAV server (e.g. Nextcloud Tasks or Apple Reminders lists), so they stay in sync with your other devices. Without a server, use a local account (see [First start](#2-first-start-adding-accounts)).

- Type into the quick field at the top and press **Enter** to add a task.
- Click a task to edit it: title, **List**, **Due** date and optional time, priority and notes.
- Click the checkbox to mark a task as done.
- The bar at the top switches between **Open** and **All** (including completed tasks). **Filter …** searches title and notes.
- Tasks are grouped into **Overdue**, **Today**, **Upcoming** and **No date**.

Today's tasks also appear in the **My day** side panel.

If no task list appears, your CalDAV server needs a calendar that supports tasks (VTODO).

## 9. Contacts

The contacts view lists all address books from your CardDAV accounts and local address books. The **Filter …** field above the list narrows it by name, company, email or phone.

- **New contact**: first and last name, company, job title, emails and phone numbers (one per line), birthday, note and address book.
- **Photo**: drop an image onto the photo area or click it. It is cropped to a square automatically. Contact photos are also shown next to emails from that person.
- **Write email** starts a new email to the contact. **Recent emails** shows your latest correspondence.
- To create a contact from an email, click the sender's name and choose **Add as contact**.

### Selecting several contacts

**Ctrl+click** adds or removes single contacts, **Shift+click** selects a range and **Ctrl+A** selects every contact shown. **Esc** clears the selection. With several contacts selected you can **Write email** to all of them or add them to a distribution list.

### Distribution lists

A distribution list is a named group of recipients for emails, such as "Newsletter" or "Team". Lists are stored only in Agenoras on this computer, not on your contacts server, and can also contain addresses that aren't contacts.

- **Create a list**: click **+** next to **Distribution lists** in the sidebar. Enter a name and add recipients: contacts are suggested as you type, and you can paste several addresses separated by commas.
- **Add contacts**: drag selected contacts onto a list in the sidebar, or onto **+** to start a new list with them. In a contact, **Add to list** shows all lists; a tick means the contact is already in it, and clicking again removes it. Contacts without an email address are skipped.
- **Use a list**: click it in the sidebar to see its recipients. **Email list** starts a new email to everyone on it; **Edit** changes the name and recipients; the **×** next to a recipient removes it.
- When writing an email, type the list's name into **To** and pick it from the suggestions.

When sending, choose **To all** or **Individually to each** on the send button. With **To all**, every recipient sees the other addresses, so for newsletters **Individually to each** is usually the better choice.

## 10. Feeds

Follow websites, blogs and news sites (RSS 2.0, RSS 1.0 and Atom) right next to your mail. The **Feed** button in the sidebar appears as soon as you have added a feed, and disappears again when you remove the last one.

### Adding a feed

In **Settings → Accounts → RSS feeds**, click **+ RSS feed** (or **Add feed** in the Feed view).

- **Feed or website address**: the feed's address, or simply the website's address – Agenoras finds the feed itself.
- **Name**: optional; if empty, the feed's own title is used.
- **Feed requires a login**: for protected feeds, enter username and password. The password is encrypted like your other passwords.

Use **Edit** and **Remove** next to a feed to change or delete it. Removing a feed also deletes its stored articles.

### Reading

- **Left**: your feeds with the number of unread articles; **All feeds** shows everything.
- **Middle**: the articles, newest first. The bar above them has **All** / **Unread** and a **Filter …** field that also searches the article text. The double-tick button marks all shown articles as read.
- **Right**: the article. Opening it marks it as read. **Open in browser** shows the original page, **Mark as unread** marks it unread again.

Feeds are refreshed when you open the view, with **F5** and every 30 minutes. Articles are stored on your computer (up to 300 per feed), so you can read them offline. Images in articles are loaded automatically; links open in your browser.

## 11. Settings

### Senders & signatures

For each account you can set the sender name, add **aliases** (other addresses you send from) and give each address its own **signature**, as plain text or HTML. Click **Load HTML file …** to import a ready-made HTML signature; images in it are embedded and sent along.

With many senders the list stays compact: only one signature is open for editing at a time, each account can be collapsed, and from five senders on a search field finds a sender or signature quickly.

Your mail server must allow you to send from an alias address. Also set here, under **Sending & reading**:

- **Sending**: delay for undo (0–5 seconds)
- **Mark as read**: when an opened email counts as read (immediately, after 1–10 seconds, or only by hand)

### Templates

Create, rename and delete email templates. A template saved from the compose window keeps its formatting; editing it here turns it into plain text.

### Accounts

Add, edit and remove email, CalDAV and CardDAV accounts and RSS feeds (see [First start](#2-first-start-adding-accounts)). Under **Edit** you can also change an account's colour and make it private with a PIN.

### Categories

Create categories, choose their colors, rename or delete them. Deleting a category keeps the emails.

### Rules

See [section 6](#6-rules).

### Notifications

- **Play a sound for new email**, with a default sound, volume and a sound per account
- **Sound when sent**
- **Desktop notification for new email** (when the window isn't in front), also per account
- **Keep running in the background when closed** (tray icon)

To use your own sounds, click **Open folder for your own sounds**, put `.ogg`, `.mp3` or `.wav` files into it and reopen the settings.

### Appearance

- **Colour scheme**: Dark, Light or Match system
- **Text size**: Small, Medium or Large
- **Language**: English, German or Match system (applies after a restart)
- **Week starts on**
- **Show mailboxes as** name or email address
- **Compose**: **Separate window** (default) or **Popup over the main window**
- **External emails**: mark external senders, additional internal domains

### AI

The optional offline AI writes email drafts, suggests subjects, proofreads and translates. It runs entirely on your computer – no cloud, your texts never leave the device.

- **Enable mini AI (offline)** and click **Download** next to the model. The model is [Ministral 3 3B](https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512) by Mistral AI (Apache 2.0), about 2 GB, downloaded once and checked with SHA-256. You can cancel the download or delete the model again here.
- While working it needs about 3 GB of RAM; after 5 minutes without use the memory is freed again.
- **AI language**: the language for generated texts and subject suggestions, independent of the app language – *Same as the mail*, German (Switzerland, with "ss"), German (Germany), English, French or Italian. Replies are always written in the language of the email you answer; for German, the spelling chosen here applies.
- **Default translation**: the target language for **Translate** (right-click in an email, translate button when writing). All languages the model supports are available: German, English, French, Italian, Spanish, Portuguese, Dutch, Chinese, Japanese, Korean and Arabic.

## 12. Keyboard shortcuts

On macOS, use **Cmd** instead of **Ctrl**.

| Where | Shortcut | Action |
|---|---|---|
| Everywhere | **Ctrl+K** / **Ctrl+F** | Jump into the search field |
| Mail | **F5** / **Ctrl+R** | Refresh |
| Mail | **Del** | Delete selected emails |
| Mail | **Ctrl+Z** | Undo the last delete or move |
| Mail | **Ctrl+A** | Select all emails in the list |
| Mail | **Ctrl+click** / **Shift+click** | Select single emails / a range |
| Mail | **Esc** | Clear selection, close menus |
| Contacts | **Ctrl+click** / **Shift+click** / **Ctrl+A** | Select single contacts / a range / all |
| Contacts | **Esc** | Clear the selection |
| Mail | Double-click | Open email in its own window |
| Search | **Enter** | Search right away |
| Search | **Esc** / **×** | Close the search and go back |
| Filter fields | **Esc** | Clear the filter |
| Compose | **Ctrl+Shift+S** | Send |
| Compose | **Ctrl+B / I / U** | Bold / italic / underline |
| Compose | **Ctrl+K** | Insert link |
| Compose | **Esc** / **Ctrl+Z** | Undo sending (during the delay) |
| Compose (Generate text) | **Ctrl+Enter** | Generate the text |
| Compose | **Ctrl+Z** | Undo proofreading or translation |
| Mail | Right-click in an email | Reply, reply to one person, reactions, copy, translate |
| Mail | Right-click on a folder | Mark all as read, empty trash, move spam to trash |
| Translation panel | **Esc** | Close |
| Mail window | **Esc** | Close window |

## 13. Your data and privacy

Agenoras talks only to your own mail, calendar and contacts servers. There is no Agenoras cloud and no tracking.

Your data is stored here:

| System | Folder |
|---|---|
| Linux | `~/.config/agenoras/` |
| Windows | `%APPDATA%\agenoras\` |
| macOS | `~/Library/Application Support/agenoras/` |

- **Passwords** are encrypted with your system's keychain. PINs of private accounts are stored only as a protected hash.
- `settings.json` contains signatures, templates, rules and preferences. Back it up if you want to keep them.
- `lists.json` holds your distribution lists. They exist only on this computer – back the file up.
- `rss.json` holds your feeds (addresses and encrypted passwords for protected feeds).
- `cache.db` is a local copy of your mail and feed articles for fast start and offline reading. You can delete it at any time; it is rebuilt from the server.
- `pop3.db` holds the mail of POP3 accounts. If the copy on the server is deleted, this is the only copy – back it up.
- `local.db` holds local calendars, tasks and address books (accounts without a server). This is the only copy – back it up.
- `ai.json` and the folder `ai-models` hold the AI settings and the downloaded model. Delete the model under **Settings → AI**.

HTML emails are shown in a protected area where scripts can't run. External content is only loaded when you allow it. Feed articles are shown in the same protected area; their images are loaded automatically.

The offline AI runs only on your computer. Your texts are never sent anywhere; its only internet access is the one-time download of the model file from Hugging Face.

## 14. Troubleshooting

**"Sign-in failed (check username/password)"**
Check the address and password. For Gmail and iCloud you need an app password. Some providers require you to enable IMAP access in their web settings first.

**"No calendars found" / "No address books found"**
Check the server URL. For Nextcloud it must end in `/remote.php/dav`.

**"The stored password can no longer be decrypted"**
This can happen after a system change or a new keyring. Enter the password again under **Settings → Accounts → Edit**.

**"The event/contact was changed elsewhere in the meantime"**
Someone or another device changed it at the same time. Refresh and make your change again.

**One email account keeps losing its connection**
Open **Settings → Accounts → Edit** and check the IMAP and SMTP server. Use the mail server your provider gives for mail programs, not your website's domain: the domain often points to the web server, not the mail server. Some providers also limit how many connections a mailbox may open at the same time. The warning sign in the title bar shows the exact error.

**"No RSS or Atom feed found at this address"**
The page doesn't link to a feed. Look for an RSS icon or a link like `/feed` or `/rss` on the website and enter that address.

**Something doesn't load, or a warning sign appears in the title bar**
Click the warning sign. The problem log shows which server failed and why (e.g. wrong password, server not reachable). **Copy** puts the log on the clipboard for a bug report.

**The AI buttons are missing in the compose window**
The AI is off or its model isn't downloaded yet. Open **Settings → AI**, turn it on and click **Download**.

**The AI is slow or the text is wrong**
The first request after a pause takes longer because the model is loaded first. The AI is small: check its texts before sending, and click **Regenerate** for another version.

**An email shows no images**
External images are blocked on purpose. Click **Load images**.

**The app looks blurry or doesn't start on Linux (Wayland)**
Start it with `AGENORAS_WAYLAND=1` to use native Wayland. `AGENORAS_GPU=1` turns on hardware acceleration, which is off by default on Linux.

**Mail list looks wrong or outdated**
Quit Agenoras, delete `cache.db` in your data folder (see [section 13](#13-your-data-and-privacy)) and start again.

**Still stuck?**
Check the [Wiki](https://github.com/ciegolink/agenoras/wiki) or [report a bug](https://github.com/ciegolink/agenoras/issues). Please include your Agenoras version (gear menu → **About Agenoras**) and your operating system.
