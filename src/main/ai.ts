// Mini-KI (offline): model download with progress + SHA-256 check, model versions, and a queue
// in front of the worker process (aiworker.ts). The model is loaded on the first request and the
// worker is ended after IDLE_MS without requests, which frees the RAM.
import { app, BrowserWindow, utilityProcess, UtilityProcess } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { t } from './i18n';
import { log } from './log';

export interface AiModel {
  id: string;
  name: string;
  file: string;
  url: string;
  size: number; // bytes
  sha256: string;
}

// Ministral 3 3B Instruct by Mistral AI (Paris), Apache-2.0. Chosen after testing against Qwen2.5
// (0.5B/1.5B) and EuroLLM 1.7B: clearly the best German and English drafts, subjects and corrections.
// IQ4_XS (imatrix quant by bartowski), not Mistral's Q4_K_M: llama.cpp repacks Q4_K weights into one
// 1.4 GB buffer, and inside Electron (PartitionAlloc) any aligned allocation over 1 GiB kills the
// process. IQ4_XS is not repacked – the weights stay memory-mapped. Checksum = Hugging Face LFS object ID.
export const AI_MODELS: AiModel[] = [
  {
    id: 'ministral-3-3b-iq4xs',
    name: 'Ministral 3 3B',
    file: 'mistralai_Ministral-3-3B-Instruct-2512-IQ4_XS.gguf',
    url: 'https://huggingface.co/bartowski/mistralai_Ministral-3-3B-Instruct-2512-GGUF/resolve/main/mistralai_Ministral-3-3B-Instruct-2512-IQ4_XS.gguf',
    size: 1_959_278_560,
    sha256: '0b5576e556c54bccdf253d5019a5a4d7a7fb755fe50c052c6f59c7d06e03b7e4',
  },
];

// Output language of the AI (write, subjects), independent of the UI language
export const AI_LANGS = ['auto', 'de-CH', 'de-DE', 'en', 'fr', 'it'];
// Translation targets: every language Ministral 3 supports, without regional variants
export const TR_LANGS = ['de', 'en', 'fr', 'it', 'es', 'pt', 'nl', 'zh', 'ja', 'ko', 'ar'];

const IDLE_MS = 5 * 60_000;
const dir = () => path.join(app.getPath('userData'), 'ai-models');
const cfgFile = () => path.join(app.getPath('userData'), 'ai.json');
const modelFile = (m: AiModel) => path.join(dir(), m.file);

interface AiConfig {
  enabled: boolean;
  model: string;
  lang: string; // see AI_LANGS
  translateLang: string; // default target of "Translate" ('' = app language)
}

function readCfg(): AiConfig {
  try {
    const c = JSON.parse(fs.readFileSync(cfgFile(), 'utf8'));
    return {
      enabled: c.enabled === true,
      model: AI_MODELS.some((m) => m.id === c.model) ? c.model : AI_MODELS[0].id,
      lang: AI_LANGS.includes(c.lang) ? c.lang : 'auto',
      // earlier versions stored "de-CH" etc. → the plain language
      translateLang: TR_LANGS.includes(String(c.translateLang).slice(0, 2)) ? String(c.translateLang).slice(0, 2) : '',
    };
  } catch {
    return { enabled: false, model: AI_MODELS[0].id, lang: 'auto', translateLang: '' };
  }
}

function writeCfg(c: AiConfig): void {
  fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 2), 'utf8');
}

export interface AiState {
  enabled: boolean;
  model: string; // active model ID
  lang: string; // output language (AI_LANGS)
  translateLang: string; // default translation target, '' = app language
  ready: boolean; // enabled and the active model is on disk
  models: { id: string; name: string; size: number; downloaded: boolean }[];
  download: { id: string; received: number; total: number } | null;
}

let download: { id: string; received: number; total: number; abort: () => void } | null = null;

// Models the app no longer offers (earlier versions) only take up space → remove them once
let cleaned = false;
function removeOldModels(): void {
  if (cleaned) return;
  cleaned = true;
  try {
    const known = new Set(AI_MODELS.map((m) => m.file));
    for (const f of fs.readdirSync(dir())) if (/\.gguf(\.part)?$/.test(f) && !known.has(f.replace(/\.part$/, ''))) fs.rmSync(path.join(dir(), f), { force: true });
  } catch {
    /* no model folder yet */
  }
}

export function aiState(): AiState {
  removeOldModels();
  const cfg = readCfg();
  const models = AI_MODELS.map((m) => ({ id: m.id, name: m.name, size: m.size, downloaded: fs.existsSync(modelFile(m)) }));
  return {
    enabled: cfg.enabled,
    model: cfg.model,
    lang: cfg.lang,
    translateLang: cfg.translateLang,
    ready: cfg.enabled && !!models.find((m) => m.id === cfg.model)?.downloaded,
    models,
    download: download && { id: download.id, received: download.received, total: download.total },
  };
}

const broadcast = () => {
  const s = aiState();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ai:state', s);
};

export function setAiEnabled(on: boolean): AiState {
  writeCfg({ ...readCfg(), enabled: !!on });
  if (!on) stopWorker();
  broadcast();
  return aiState();
}

export function setAiModel(id: string): AiState {
  if (!AI_MODELS.some((m) => m.id === id)) throw new Error('Unknown model');
  writeCfg({ ...readCfg(), model: id });
  stopWorker(); // the next request loads the new one
  broadcast();
  return aiState();
}

export function setAiLang(lang: string): AiState {
  if (!AI_LANGS.includes(lang)) throw new Error('Unknown language');
  writeCfg({ ...readCfg(), lang });
  broadcast();
  return aiState();
}

export function setAiTranslateLang(lang: string): AiState {
  if (lang && !TR_LANGS.includes(lang)) throw new Error('Unknown language');
  writeCfg({ ...readCfg(), translateLang: lang });
  broadcast();
  return aiState();
}

export function deleteAiModel(id: string): AiState {
  const m = AI_MODELS.find((x) => x.id === id);
  if (!m) throw new Error('Unknown model');
  if (readCfg().model === id) stopWorker();
  fs.rmSync(modelFile(m), { force: true });
  broadcast();
  return aiState();
}

// HTTPS GET with redirects (Hugging Face sends the file from its CDN)
function get(url: string, signal: AbortSignal, hops = 0): Promise<import('node:http').IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { signal, headers: { 'User-Agent': 'Agenoras' } }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        if (hops > 5) return reject(new Error('Too many redirects'));
        return resolve(get(new URL(loc, url).toString(), signal, hops + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      resolve(res);
    });
    req.on('error', reject);
  });
}

// Download into a .part file, check SHA-256 on the fly, only then rename it into place
export async function downloadAiModel(id: string): Promise<AiState> {
  const m = AI_MODELS.find((x) => x.id === id);
  if (!m) throw new Error('Unknown model');
  if (download) throw new Error(t('ai.busyDownloading'));
  fs.mkdirSync(dir(), { recursive: true });
  const part = `${modelFile(m)}.part`;
  const ctrl = new AbortController();
  download = { id, received: 0, total: m.size, abort: () => ctrl.abort() };
  broadcast();
  let lastSent = 0;
  try {
    const res = await get(m.url, ctrl.signal);
    download.total = Number(res.headers['content-length']) || m.size;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    await new Promise<void>((resolve, reject) => {
      res.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        download!.received += chunk.length;
        if (Date.now() - lastSent > 250) {
          lastSent = Date.now();
          broadcast();
        }
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      res.pipe(out);
    });
    if (hash.digest('hex') !== m.sha256) throw new Error(t('ai.checksumFailed'));
    fs.renameSync(part, modelFile(m));
  } catch (err) {
    fs.rmSync(part, { force: true });
    const aborted = ctrl.signal.aborted;
    if (!aborted) log('error', 'KI', '', t('ai.downloadFailed', { msg: (err as Error).message }));
    throw new Error(aborted ? t('ai.downloadCancelled') : (err as Error).message);
  } finally {
    download = null;
    broadcast();
  }
  return aiState();
}

export function cancelAiDownload(): void {
  download?.abort();
}

// Worker process and queue
let worker: UtilityProcess | null = null;
let idleTimer: NodeJS.Timeout | undefined;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let queue: Promise<unknown> = Promise.resolve();

function startWorker(): UtilityProcess {
  if (worker) return worker;
  const w = utilityProcess.fork(path.join(__dirname, 'aiworker.js'), [], { serviceName: 'Agenoras KI', stdio: ['ignore', 'ignore', 'pipe'] });
  // keep the last lines of the worker's error output for the problem log
  let errTail = '';
  w.stderr?.on('data', (d: Buffer) => (errTail = (errTail + d.toString()).slice(-600)));
  w.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.ok) p?.resolve(msg.result);
    else p?.reject(new Error(msg.error || 'KI error'));
  });
  w.on('exit', (code) => {
    const crashed = worker === w && code !== 0; // stopWorker() clears `worker` first → an unload is no crash
    if (worker === w) worker = null;
    if (crashed) log('error', 'KI', '', t('ai.crashed', { code: String(code) }) + (errTail.trim() ? `\n${errTail.trim().split('\n').slice(-3).join('\n')}` : ''));
    for (const p of pending.values()) p.reject(new Error(t('ai.stopped')));
    pending.clear();
  });
  worker = w;
  return w;
}

export function stopWorker(): void {
  clearTimeout(idleTimer);
  worker?.kill();
  worker = null;
}

// Requests one after another; after IDLE_MS without a request the model leaves the RAM
function enqueue<T>(kind: 'subjects' | 'proofread' | 'write' | 'translate', text: string, ctx?: { original?: string; subject?: string }, lang?: string): Promise<T> {
  const cfg = readCfg();
  const m = AI_MODELS.find((x) => x.id === cfg.model)!;
  if (!cfg.enabled) throw new Error(t('ai.disabled'));
  if (!fs.existsSync(modelFile(m))) throw new Error(t('ai.notDownloaded'));
  const job = queue.then(
    () =>
      new Promise<T>((resolve, reject) => {
        clearTimeout(idleTimer);
        const id = nextId++;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        startWorker().postMessage({ id, kind, text, ctx, lang: lang ?? cfg.lang, modelPath: modelFile(m) });
      }),
  );
  queue = job.catch(() => {}).finally(() => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stopWorker, IDLE_MS);
  });
  return job;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export const suggestSubjects = (text: string) => enqueue<string[]>('subjects', clip(String(text ?? '').trim(), 4000));
export const proofread = (text: string) => enqueue<string>('proofread', clip(String(text ?? ''), 6000));
// Translate into a fixed target language (one of TR_LANGS)
export function translate(text: string, target: string): Promise<string> {
  if (!TR_LANGS.includes(target)) throw new Error('Unknown language');
  return enqueue<string>('translate', clip(String(text ?? '').trim(), 4000), undefined, target);
}
// Write a mail body from an instruction; when replying, the original mail is the context
export const writeText = (instruction: string, ctx?: { original?: string; subject?: string }) =>
  enqueue<string>('write', clip(String(instruction ?? '').trim(), 1000), {
    original: ctx?.original ? clip(String(ctx.original), 3000) : undefined,
    subject: ctx?.subject ? clip(String(ctx.subject), 200) : undefined,
  });
