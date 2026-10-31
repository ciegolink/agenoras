import { app, net, shell } from 'electron';
import http from 'node:http';
import crypto from 'node:crypto';
import { getPassword, setSecret } from './accounts';
import { t } from './i18n';

// Sign-in with Microsoft or Google (OAuth 2.0, authorization code + PKCE, loopback redirect).
// Desktop apps are public clients: the client IDs are not secret and ship with the app.

export type OAuthProvider = 'microsoft' | 'google';

// Client IDs from the app registrations (see docs/DEVELOPMENT.md). Empty = button not shown.
const MICROSOFT_CLIENT_ID = '53e5120c-f4b0-4ae7-b3f2-5d1175afec84';
const GOOGLE_CLIENT_ID = '';
const GOOGLE_CLIENT_SECRET = '';

interface ProviderConfig {
  clientId: string;
  clientSecret?: string; // Google "desktop app" clients have one; it is not confidential
  authUrl: string;
  tokenUrl: string;
  scope: string;
  redirectHost: string;
  extraAuth?: Record<string, string>;
  server: { host: string; port: number; secure: boolean; smtpHost: string; smtpPort: number; smtpSecure: boolean };
}

const PROVIDERS: Record<OAuthProvider, ProviderConfig> = {
  microsoft: {
    clientId: process.env.AGENORAS_MS_CLIENT_ID || MICROSOFT_CLIENT_ID,
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access openid email profile https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send',
    redirectHost: 'localhost', // registered as http://localhost, any port is accepted
    extraAuth: { prompt: 'select_account' },
    server: { host: 'outlook.office365.com', port: 993, secure: true, smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false },
  },
  google: {
    clientId: process.env.AGENORAS_GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID,
    clientSecret: process.env.AGENORAS_GOOGLE_CLIENT_SECRET || GOOGLE_CLIENT_SECRET,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://mail.google.com/ openid email profile',
    redirectHost: '127.0.0.1',
    extraAuth: { access_type: 'offline', prompt: 'consent select_account' },
    server: { host: 'imap.gmail.com', port: 993, secure: true, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
  },
};

export const isOAuthProvider = (p: unknown): p is OAuthProvider => p === 'microsoft' || p === 'google';

// Only providers with a client ID are offered in the account dialog
export function oauthProviders(): OAuthProvider[] {
  return (Object.keys(PROVIDERS) as OAuthProvider[]).filter((p) => PROVIDERS[p].clientId);
}

export const serverFor = (p: OAuthProvider) => PROVIDERS[p].server;

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(p: OAuthProvider, params: Record<string, string>): Promise<TokenResponse> {
  const cfg = PROVIDERS[p];
  const body = new URLSearchParams({ client_id: cfg.clientId, ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}), ...params });
  const res = await net.fetch(cfg.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    const err = new Error(data.error_description?.split('\r\n')[0] || data.error || `HTTP ${res.status}`) as Error & { oauthError?: string };
    err.oauthError = data.error;
    throw err;
  }
  return data;
}

// The ID token comes straight from the token endpoint over TLS, so reading it without checking the signature is fine
function idClaims(idToken?: string): { email: string; name: string } {
  try {
    const c = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return { email: String(c.email || c.preferred_username || ''), name: String(c.name || '') };
  } catch {
    return { email: '', name: '' };
  }
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>Agenoras</title><body style="font:15px system-ui,sans-serif;display:grid;place-items:center;height:90vh;background:#1F2126;color:#EAEAE2"><div style="text-align:center"><h2 style="font-weight:600">${title}</h2><p style="color:#969993">${text}</p></div>`;

let running: { cancel: () => void } | null = null;

export interface SignInResult {
  email: string;
  name: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
}

// Opens the sign-in page in the browser and waits (max. 5 min) for the redirect to a local port
export async function signIn(p: OAuthProvider, loginHint?: string): Promise<SignInResult> {
  const cfg = PROVIDERS[p];
  if (!cfg.clientId) throw new Error(t('oauth.notConfigured'));
  running?.cancel();
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  // "localhost" may resolve to ::1 in the browser, so listen there too (best effort)
  const server6 = http.createServer();
  server6.on('error', () => {});
  server6.listen(port, '::1');
  const redirectUri = `http://${cfg.redirectHost}:${port}/`;

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(t('oauth.timeout'))), 5 * 60_000);
    const finish = (err: Error | null, value = '') => {
      clearTimeout(timer);
      running = null;
      setTimeout(() => {
        server.close();
        server6.close();
      }, 1000); // let the browser receive the page first
      if (err) reject(err);
      else resolve(value);
    };
    running = { cancel: () => finish(new Error(t('oauth.cancelled'))) };
    const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== '/' || (!url.searchParams.has('code') && !url.searchParams.has('error'))) {
        res.writeHead(404).end();
        return;
      }
      const ok = url.searchParams.get('state') === state && url.searchParams.has('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ok ? PAGE(t('oauth.pageDone'), t('oauth.pageDoneText')) : PAGE(t('oauth.pageFailed'), url.searchParams.get('error_description') ?? ''));
      if (ok) finish(null, url.searchParams.get('code')!);
      else finish(new Error(url.searchParams.get('error_description') || url.searchParams.get('error') || t('oauth.cancelled')));
    };
    server.on('request', onRequest);
    server6.on('request', onRequest);

    const params = new URLSearchParams({
      client_id: cfg.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: cfg.scope,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...(loginHint ? { login_hint: loginHint } : {}),
      ...cfg.extraAuth,
    });
    shell.openExternal(`${cfg.authUrl}?${params}`).catch((err) => finish(err as Error));
  });

  const tok = await tokenRequest(p, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
  if (!tok.refresh_token) throw new Error(t('oauth.noRefresh'));
  const who = idClaims(tok.id_token);
  if (!who.email) throw new Error(t('oauth.noEmail'));
  return { ...who, refreshToken: tok.refresh_token, accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 };
}

export function cancelSignIn(): void {
  running?.cancel();
}

// Access tokens live about an hour; they are kept in memory only and renewed with the stored refresh token
const tokens = new Map<string, { token: string; expiresAt: number }>();
const refreshing = new Map<string, Promise<string>>();

export function rememberToken(accountId: string, token: string, expiresAt: number): void {
  tokens.set(accountId, { token, expiresAt });
}

export function forgetToken(accountId: string): void {
  tokens.delete(accountId);
}

export function accessToken(acc: { id: string; oauth?: OAuthProvider }): Promise<string> {
  const hit = tokens.get(acc.id);
  if (hit && hit.expiresAt - Date.now() > 120_000) return Promise.resolve(hit.token);
  let p = refreshing.get(acc.id);
  if (!p) {
    p = (async () => {
      if (!acc.oauth) throw new Error(t('err.accountNotFound'));
      let tok: TokenResponse;
      try {
        tok = await tokenRequest(acc.oauth, { grant_type: 'refresh_token', refresh_token: await getPassword(acc.id) });
      } catch (err) {
        // revoked, password changed or unused for too long: the user has to sign in again
        if ((err as { oauthError?: string }).oauthError === 'invalid_grant') throw new Error(t('oauth.reauth'));
        throw err;
      }
      if (tok.refresh_token) await setSecret(acc.id, tok.refresh_token); // Microsoft rotates them
      rememberToken(acc.id, tok.access_token, Date.now() + (tok.expires_in ?? 3600) * 1000);
      return tok.access_token;
    })().finally(() => refreshing.delete(acc.id));
    refreshing.set(acc.id, p);
  }
  return p;
}

app.on('before-quit', () => running?.cancel());
