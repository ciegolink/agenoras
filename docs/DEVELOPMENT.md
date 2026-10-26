# Development guide

## 1. Install the tools

### Ubuntu

```bash
# Node.js LTS (the version in the Ubuntu repositories is too old)
sudo apt update
sudo apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs

# VS Code
sudo snap install code --classic
```

Check with `node -v`: it must show `v22` or newer.

### Windows

1. Install **Node.js LTS** from https://nodejs.org or with `winget install OpenJS.NodeJS.LTS`.
2. Install **VS Code** from https://code.visualstudio.com.
3. Restart VS Code and check `node -v` (`v22` or newer).

## 2. Get the code

```bash
git clone https://github.com/ciegolink/agenoras.git
cd agenoras
code .
```

When VS Code asks whether you trust the authors, choose **Yes**. The recommended extension *i18n Ally* is optional and helps with the language files.

## 3. Install dependencies

Open a terminal in VS Code (**Terminal → New Terminal**) and run:

```bash
npm install
```

This downloads Electron and the libraries (a few minutes, about 300 MB in `node_modules`).

> **Ubuntu 24.04 and newer:** Electron needs permissions for its sandbox once, otherwise it refuses to start
> ("SUID sandbox helper binary … not configured correctly"). Run after `npm install`:
> ```bash
> sudo chown root:root node_modules/electron/dist/chrome-sandbox
> sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
> ```
> Repeat this whenever `npm install` downloads Electron again.
>
> **Windows: "running scripts is disabled on this system"?** Run once in PowerShell:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then restart VS Code.

## 4. Run

**With the debugger (recommended):** press `F5`. The debug menu also offers "Start Agenoras (English)".

**From the terminal:**

```bash
npm start
```

On first start, add an account via **Settings → Accounts**.

## 5. Workflow

| Task | How |
|---|---|
| Compile on every save | `Ctrl+Shift+B` (keeps running in the background) |
| Reload UI changes (`src/renderer/…`) | `Ctrl+R` in the app window |
| Apply main-process changes (`src/main/…`) | Restart the app (`F5` or `Ctrl+Shift+F5`) |
| DevTools | `F12` in the app window (development only) |
| Breakpoints in the main process | Click next to a line number in `src/main/*.ts`, then `F5` |
| Breakpoints in the UI | `F12` → Sources → file under `src/renderer` |
| Show type errors | **Problems** panel (`Ctrl+Shift+M`) |

Where things live:

- `src/main/`: background work (IMAP, SMTP, CalDAV, CardDAV, cache, windows)
- `src/renderer/`: user interface (`index.html`, `compose.html`, `mailview.html`, `styles.css`)
- `lang/de.json`, `lang/en.json`: all UI strings; restart the app after changes

## 6. Test another language

The app uses the system language (German → `de.json`, otherwise English). To force English, pick the "(English)" debug configuration or run:

- PowerShell: `$env:AGENORAS_LANG="en"; npm start`
- macOS/Linux: `AGENORAS_LANG=en npm start`

The language can also be chosen in **Settings → Appearance** (takes effect after a restart).

## 7. User data

Linux: `~/.config/agenoras/` · Windows: `%APPDATA%\agenoras\`

Passwords are encrypted with the system keychain (GNOME Keyring / libsecret on Linux, DPAPI on Windows, Keychain on macOS).

- `accounts.json`, `calendars.json`, `contacts.json`: accounts (passwords encrypted)
- `settings.json`: identities, signatures, templates, rules, preferences
- `window-state.json`: window size and position
- `cache.db`: local cache, safe to delete
- `sounds/`: custom notification sounds

## 8. Troubleshooting

| Problem | Solution |
|---|---|
| `electron` not found | Run `npm install` again |
| Ubuntu: "SUID sandbox helper … not configured correctly" | Run the two `sudo` commands from step 3 |
| Ubuntu: `node -v` shows v18 or older | Install Node.js from NodeSource as in step 1 |
| Electron download fails (corporate proxy) | `npm config set proxy http://proxy:port` or allow `github.com` |
| White or empty window | Check the console with `F12`; run `npm run build` |
| A change has no effect | Is `Ctrl+Shift+B` running? Otherwise `npm run build`, then `Ctrl+R` |
| No title bar on Wayland | The app starts via XWayland by default; `AGENORAS_WAYLAND=1` forces native Wayland |
| Tray icon missing on Ubuntu | Requires the AppIndicator extension (preinstalled on Ubuntu) |
| Gmail login fails | Use an app password (Google account → Security → App passwords) |
| Microsoft 365 | Requires OAuth2, not supported yet |
