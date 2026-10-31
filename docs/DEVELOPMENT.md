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

## 8. Build installers

| Platform | Command | Output in `release/` |
|---|---|---|
| Linux | `npm run dist:linux` | `Agenoras-x86_64.AppImage`, `agenoras_amd64.deb` |
| Windows | `npm run dist:win` (run on Windows) | `Agenoras-Setup.exe`, `Agenoras-Portable.exe` |
| macOS | `npm run dist:mac` (run on a Mac) | `Agenoras.dmg`, `Agenoras-mac.zip` (universal) |

Building the Windows installer on Linux requires Wine. The simpler way is GitHub Actions: push a tag (`npm version patch && git push --follow-tags`) and the workflow builds all three platforms and attaches the files to a draft release. Review the draft under **Releases** and publish it.

The macOS build in GitHub Actions is signed with a Developer ID certificate and notarized by Apple. It needs five repository secrets (Settings → Secrets and variables → Actions):

| Secret | Content |
|---|---|
| `CSC_LINK` | the Developer ID Application certificate as `.p12`, base64-encoded |
| `CSC_KEY_PASSWORD` | password of the `.p12` |
| `APPLE_ID` | Apple ID of the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | team ID from developer.apple.com → Membership |

Only the macOS job gets these secrets. Entitlements for the hardened runtime are in `build/entitlements.mac.plist`. A local `npm run dist:mac` without a certificate in the keychain builds an unsigned app; on first start right-click it → **Open** (or `xattr -cr /Applications/Agenoras.app`).

### OAuth (Microsoft and Google)

The **Sign in with Microsoft / Google** buttons in the account dialog only appear when a client ID is set in `src/main/oauth.ts` (`MICROSOFT_CLIENT_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`). Desktop apps are public clients, so these values are not secret and ship with the app. For a quick test, set `AGENORAS_MS_CLIENT_ID`, `AGENORAS_GOOGLE_CLIENT_ID` and `AGENORAS_GOOGLE_CLIENT_SECRET` instead.

**Microsoft** ([entra.microsoft.com](https://entra.microsoft.com) → App registrations → New registration)
- Supported account types: *Accounts in any organizational directory and personal Microsoft accounts*
- Redirect URI: platform *Public client/native (mobile & desktop)*, `http://localhost`
- API permissions: `IMAP.AccessAsUser.All`, `SMTP.Send` (Office 365 Exchange Online), `offline_access`, `openid`, `email`, `profile`
- Copy the **Application (client) ID**. No client secret.

**Google** ([console.cloud.google.com](https://console.cloud.google.com))
- Enable the Gmail API, set up the OAuth consent screen (*External*)
- Credentials → OAuth client ID → *Desktop app*; copy client ID and client secret
- The scope `https://mail.google.com/` is restricted: in testing mode only listed test users can sign in and the sign-in expires after 7 days. Publishing for everyone needs Google's verification including a yearly security assessment (CASA).

Sign-in flow: authorization code with PKCE, redirect to a short-lived local port (`http://localhost:<port>` / `http://127.0.0.1:<port>`). The refresh token is stored encrypted like a password; access tokens are kept in memory and renewed automatically.

Install on Ubuntu: `sudo apt install ./release/agenoras_amd64.deb`. The AppImage runs directly after `chmod +x`.

## 9. Troubleshooting

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
| Microsoft 365 | Sign in with Microsoft needs a client ID in `src/main/oauth.ts`, see [OAuth](#oauth-microsoft-and-google) |
