// Mini-KI in the compose window: sparkle next to the subject (three suggestions), "Write with AI"
// (draft from a short description; when replying it knows the original mail) and "Proofread".
// They only show up when the AI is switched on and its model is downloaded (Settings → AI).
// Uses el, t, editor and setInfo from common.ts / compose.ts.

const subjectInput = () => cfield('subject');
const aiProgress = (s: string) => (el('#send-progress').textContent = s);

// The output language (Swiss German, English …) is set in Settings → AI
let aiNow: AiState | null = null;
function paintAi(state: AiState): void {
  el('#btn-ai-subject').hidden = !state.ready;
  el('#btn-ai-proof').hidden = !state.ready;
  el('#btn-ai-write').hidden = !state.ready;
  el('#btn-ai-translate').hidden = !state.ready;
  aiNow = state;
  // tooltip names the target language
  const tip = t('tr.composeTip', { lang: trLangName(translateTarget(state)) });
  el('#btn-ai-translate').title = tip;
  el('#btn-ai-translate').setAttribute('aria-label', tip);
  if (!state.ready) el('#ai-write').hidden = true;
}
window.api.ai.state().then(paintAi).catch(() => {});
window.api.ai.onState(paintAi);

// Only what the user wrote: without signature and quoted mail
function ownText(): string {
  const copy = editor.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[data-sig],[data-quote]').forEach((n) => n.remove());
  return (copy.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- Subject suggestions ----------

const subjBox = el<HTMLUListElement>('#ai-subjects');

el('#btn-ai-subject').addEventListener('click', async () => {
  const btn = el<HTMLButtonElement>('#btn-ai-subject');
  const text = ownText();
  if (text.length < 20) return setInfo(t('ai.writeFirst'));
  btn.disabled = true;
  btn.classList.add('busy');
  aiProgress(t('ai.thinking'));
  try {
    const list = await window.api.ai.subjects(text);
    subjBox.innerHTML = list.map((s, i) => `<li role="option" data-subject="${i}">${esc(s)}</li>`).join('');
    subjBox.dataset.list = JSON.stringify(list);
    subjBox.hidden = !list.length;
    setInfo('');
  } catch (err) {
    setInfo(errMsg(err));
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
    aiProgress('');
  }
});

subjBox.addEventListener('mousedown', (e) => {
  const i = (e.target as HTMLElement).closest<HTMLElement>('[data-subject]')?.dataset.subject;
  if (i === undefined) return;
  e.preventDefault();
  subjectInput().value = (JSON.parse(subjBox.dataset.list || '[]') as string[])[Number(i)] ?? subjectInput().value;
  subjectInput().dispatchEvent(new Event('input', { bubbles: true }));
  subjBox.hidden = true;
});
document.addEventListener('mousedown', (e) => {
  if (!(e.target as HTMLElement).closest('#ai-subjects, #btn-ai-subject')) subjBox.hidden = true;
});

// ---------- Proofreading ----------
// Works on text pieces in place: formatting stays, and every change goes through the editor's
// undo history (Ctrl+Z). With a selection only the selection is checked.

function ownTextNodes(): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      (n.parentElement?.closest('[data-sig],[data-quote]') ? NodeFilter.FILTER_REJECT : /\p{L}{2,}.*\s.*\p{L}{2,}/su.test(n.textContent ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

// A small model can drift (reorder or rewrite words). Only accept real corrections: same words in
// the same order, each changed at most a little (typos, case, punctuation). A missing/extra short
// word (e.g. a comma word like "es") is allowed once.
// Edit distance where swapped neighbours ("tets" → "test") count as one typo
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function plausible(before: string, after: string): boolean {
  if (!after || after === before) return false;
  const words = (s: string) => s.toLowerCase().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  const a = words(before);
  const b = words(after);
  let i = 0;
  let j = 0;
  let skips = 0;
  while (i < a.length && j < b.length) {
    const close = editDistance(a[i], b[j]) <= Math.max(1, Math.floor(a[i].length / 3));
    if (close) {
      i++;
      j++;
    } else if (++skips > 1) return false;
    else if (b.length > a.length && b[j].length <= 4) j++; // one inserted short word
    else if (a.length > b.length && a[i].length <= 4) i++; // one dropped short word
    else return false;
  }
  return a.length - i + (b.length - j) + skips <= 1;
}

// Several lines → real paragraphs/line breaks; one line → plain text (keeps the formatting around it)
function replaceRange(range: Range, text: string): void {
  const sel = getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  if (!text.includes('\n')) return void document.execCommand('insertText', false, text);
  const html = text
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  document.execCommand('insertHTML', false, html);
}

el('#btn-ai-proof').addEventListener('click', async () => {
  const btn = el<HTMLButtonElement>('#btn-ai-proof');
  const sel = getSelection();
  const inEditor = sel && sel.rangeCount && !sel.isCollapsed && editor.contains(sel.getRangeAt(0).commonAncestorContainer);
  btn.disabled = true;
  setInfo('');
  let changed = 0;
  try {
    if (inEditor) {
      const range = sel!.getRangeAt(0).cloneRange();
      // Selection.toString keeps the line breaks between paragraphs, Range.toString does not
      const before = sel!.toString();
      aiProgress(t('ai.proofreading', { i: 1, n: 1 }));
      const after = await window.api.ai.proofread(before);
      if (plausible(before, after)) {
        replaceRange(range, after);
        changed++;
      }
    } else {
      const nodes = ownTextNodes();
      for (let i = 0; i < nodes.length; i++) {
        aiProgress(t('ai.proofreading', { i: i + 1, n: nodes.length }));
        const node = nodes[i];
        const before = node.textContent ?? '';
        // keep leading/trailing spaces exactly – the model tends to trim them
        const lead = before.match(/^\s*/)![0];
        const trail = before.match(/\s*$/)![0];
        const core = before.trim();
        const after = (await window.api.ai.proofread(core)).trim();
        if (!node.isConnected || !plausible(core, after)) continue;
        const range = document.createRange();
        range.setStart(node, lead.length);
        range.setEnd(node, before.length - trail.length);
        replaceRange(range, after);
        changed++;
      }
    }
    setInfo(changed ? t('ai.proofDone', { n: changed }) : t('ai.proofNone'));
  } catch (err) {
    setInfo(errMsg(err));
  } finally {
    btn.disabled = false;
    aiProgress('');
  }
});

// ---------- Translate the selection ----------
// Replaces the selected text with its translation into the default language (Ctrl+Z undoes it).

let trRange: Range | null = null;
let trSource = ''; // the selected text with its line breaks
el('#btn-ai-translate').addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
// One click: into the default language from Settings → AI
el('#btn-ai-translate').addEventListener('click', () => {
  const sel = getSelection();
  const ok = sel && sel.rangeCount && !sel.isCollapsed && editor.contains(sel.getRangeAt(0).commonAncestorContainer) && sel.toString().trim().length > 1;
  if (!ok) return void setInfo(t('tr.selectFirst'));
  trRange = sel!.getRangeAt(0).cloneRange();
  trSource = sel!.toString();
  translateSelection(translateTarget(aiNow));
});

async function translateSelection(lang: string): Promise<void> {
  const range = trRange;
  if (!range) return;
  const btn = el<HTMLButtonElement>('#btn-ai-translate');
  btn.disabled = true;
  setInfo('');
  aiProgress(t('tr.working'));
  try {
    const out = await window.api.ai.translate(trSource, lang);
    if (!out || !range.startContainer.isConnected) return;
    replaceRange(range, out);
    setInfo(t('tr.done'));
  } catch (err) {
    setInfo(errMsg(err));
  } finally {
    btn.disabled = false;
    aiProgress('');
  }
}

// ---------- Write with AI ----------
// Instruction → draft (shown first, nothing is changed yet) → insert at the cursor or above the
// signature. When replying/forwarding, the quoted mail is passed as context.

const writeBox = el('#ai-write');
const writeInput = el<HTMLTextAreaElement>('#ai-write-input');
const draftBox = el('#ai-draft');
let draft = '';
let savedRange: Range | null = null; // where the cursor was in the editor before the panel took the focus

// Only the quoted mail: the "Am … schrieb …" line is in the UI language and would mislead the language detection
// (reply: the mail is in the blockquote; forward: everything after the "From/Date/Subject" paragraph)
function quotedText(): string {
  const quote = editor.querySelector<HTMLElement>('[data-quote]');
  if (!quote) return '';
  const inner = quote.querySelector<HTMLElement>('blockquote');
  if (inner) return inner.innerText.trim();
  const full = quote.innerText;
  const head = quote.firstElementChild?.tagName === 'P' ? (quote.firstElementChild as HTMLElement).innerText : '';
  return (head && full.startsWith(head) ? full.slice(head.length) : full).trim();
}

el('#btn-ai-write').addEventListener('click', () => {
  const sel = getSelection();
  savedRange = sel && sel.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer) ? sel.getRangeAt(0).cloneRange() : null;
  writeBox.hidden = !writeBox.hidden;
  if (writeBox.hidden) return;
  el('#ai-write-ctx').textContent = t(quotedText() ? 'ai.writeCtxReply' : 'ai.writeCtxNew');
  writeInput.focus();
});
function showDraft(on: boolean): void {
  draftBox.hidden = el('#ai-draft-label').hidden = el('#ai-draft-actions').hidden = !on;
}
el('#btn-ai-write-close').addEventListener('click', () => {
  writeBox.hidden = true;
  showDraft(false);
});

async function generate(): Promise<void> {
  const instruction = writeInput.value.trim();
  if (!instruction) return void setInfo(t('ai.describeFirst'));
  const go = el<HTMLButtonElement>('#btn-ai-write-go');
  const redo = el<HTMLButtonElement>('#btn-ai-redo');
  go.disabled = redo.disabled = true;
  setInfo('');
  showDraft(false);
  el('#ai-busy').hidden = false; // clearly visible while the model generates
  aiProgress(t('ai.writing'));
  try {
    draft = await window.api.ai.write(instruction, { original: quotedText() || undefined, subject: subjectInput().value.trim() || undefined });
    draftBox.textContent = draft;
    showDraft(!!draft);
    if (draft) draftBox.scrollIntoView({ block: 'nearest' });
  } catch (err) {
    setInfo(errMsg(err));
  } finally {
    go.disabled = redo.disabled = false;
    el('#ai-busy').hidden = true;
    aiProgress('');
  }
}

el('#btn-ai-write-go').addEventListener('click', generate);
el('#btn-ai-redo').addEventListener('click', generate);
writeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    e.stopPropagation(); // stays in the panel – never reaches the compose form
    generate();
  }
});

// The model likes to end with "Kind regards / Name". With a signature in the mail, closing and
// name are removed (the signature does that); without one they stay. "[Name]" placeholders always go.
const CLOSING = /^(mit )?(freundlichen|herzlichen|lieben|besten|vielen|liebe|beste|viele|freundliche|herzliche)\s+gr(ü|ue)(ß|ss)(e|en)\b|^(kind |best |warm )?regards\b|^best( wishes)?\b|^cheers\b|^sincerely\b|^(yours )?(truly|faithfully)\b|^gru(ß|ss)\b|^lg\b|^mfg\b/i;

function tidyClosing(text: string): string {
  const lines = text
    .replace(/\s+$/, '')
    .split('\n')
    .filter((l) => !/^\s*\[[^\]]*\]\s*$/.test(l)); // "[Name]" placeholders never stay
  const from = Math.max(0, lines.length - 5);
  const at = lines.findIndex((l, i) => i >= from && CLOSING.test(l.trim()));
  // A signature is in the mail → it does the closing: no "Liebe Grüsse", no name from the AI
  const hasSig = !!editor.querySelector<HTMLElement>('[data-sig]')?.innerText.trim();
  if (at < 0 || !hasSig) return lines.join('\n').trimEnd();
  return lines.slice(0, at).join('\n').trimEnd();
}

// Insert as normal text (undo with Ctrl+Z): at the saved cursor, otherwise into the empty
// lines at the top – signature and quote stay below
el('#btn-ai-insert').addEventListener('click', () => {
  if (!draft) return;
  editor.focus();
  let range = savedRange && savedRange.startContainer.isConnected && !(savedRange.startContainer as Element).parentElement?.closest?.('[data-sig],[data-quote]') ? savedRange : null;
  if (!range) {
    range = document.createRange();
    const first = editor.firstElementChild;
    if (first && !first.matches('[data-sig],[data-quote]') && !(first.textContent ?? '').trim()) range.setStart(first, 0);
    else range.setStart(editor, 0);
    range.collapse(true);
  }
  const sel = getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  const html = tidyClosing(draft)
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  document.execCommand('insertHTML', false, html);
  writeBox.hidden = true;
  showDraft(false);
  writeInput.value = '';
  draft = '';
});
