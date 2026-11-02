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

// Subject suggestions
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

// Proofreading
// Works on text pieces in place: formatting stays, and every change goes through the editor's
// undo history (Ctrl+Z). Without a selection: all own text above the signature (also one-word lines,
// e.g. a greeting); with a selection only the selection.

function ownTextNodes(): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      (n.parentElement?.closest('[data-sig],[data-quote]') ? NodeFilter.FILTER_REJECT : /\p{L}{3,}/u.test(n.textContent ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

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

// Take the model's corrections word by word. Words are aligned (longest common sequence, a word may
// differ a little: typo, case, ä/ae, punctuation); an aligned word is taken from the correction, every
// other word stays as the user wrote it. Reordered, added or rewritten parts are ignored, the rest counts.
const core = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const similar = (a: string, b: string) => a === b || (!!a && !!b && editDistance(a, b) <= Math.max(1, Math.floor(a.length / 3)));
// Letters from the correction; brackets and quotes as the user had them; a comma or sentence end from the
// correction, or the user's sentence end if the correction lost it (e.g. a moved word took it along)
function takeWord(orig: string, fixed: string): string {
  const lead = orig.match(/^[^\p{L}\p{N}]*/u)![0];
  const body = fixed.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
  const oTrail = orig.match(/[^\p{L}\p{N}]*$/u)![0];
  const fTrail = fixed.match(/[^\p{L}\p{N}]*$/u)![0].replace(/[^,.;:!?]/g, '');
  const trail = /[^,.;:!?]/.test(oTrail) ? oTrail : fTrail || (/[.!?]/.test(oTrail) ? oTrail : '');
  return lead + (body || orig) + trail;
}

function mergeCorrections(before: string, after: string): { tok: string[]; out: string[] } {
  const tok = before.match(/\s+|\S+/g) ?? [];
  const bw = tok.map((t, i) => [t, i] as const).filter(([t]) => /\S/.test(t));
  const aw = after.split(/\s+/).filter(Boolean);
  const n = bw.length;
  const m = aw.length;
  if (!n || !m) return { tok, out: [...tok] };
  // dp[i][j]: best number of aligned words for bw[i..] and aw[j..]
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1], similar(core(bw[i][0]), core(aw[j])) ? dp[i + 1][j + 1] + 1 : 0);
  const out = [...tok];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (similar(core(bw[i][0]), core(aw[j])) && dp[i][j] === dp[i + 1][j + 1] + 1) {
      out[bw[i][1]] = takeWord(bw[i][0], aw[j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return { tok, out };
}

// Swiss region (also with an English interface): no "ß" unless the user wrote one (the model likes to "correct" weiss → weiß)
const swissSpelling = (before: string, text: string) => (/-(CH|LI)$/i.test(LOCALE) && !before.includes('ß') ? text.replace(/ß/g, 'ss') : text);

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

// Proofreading runs in a panel above the text: progress first, then every correction to check.
// The small model goes sentence by sentence (it drifts less on short pieces), the bigger one takes whole
// paragraphs (more context, fewer requests); afterwards the
// spell checker (Settings → Writing & reading) flags words that are still unknown. Nothing changes in
// the mail until "Apply"; AI corrections start ticked, dictionary suggestions unticked (names, jargon).
interface ProofJob {
  range: Range;
  before: string;
  tok: string[]; // the text in words and spaces
  ai: string[]; // the same with the AI's corrections
}
interface ProofItem {
  job: number;
  kind: 'ai' | 'spell';
  at?: number; // spell: token index
  word?: string; // spell: replacement
  html: string;
  on: boolean;
}
let proofJobs: ProofJob[] = [];
let proofItems: ProofItem[] = [];
let proofRun = 0; // a new run or "Cancel" makes the running one stop

const proofPanel = el('#ai-proof');
const norm = (s: string) => s.replace(/\s+/g, '');
const WORD = /[\p{L}\p{N}](?:[\p{L}\p{N}'’-]*[\p{L}\p{N}])?/u;

function paintProof(state: 'busy' | 'done', step = ''): void {
  proofPanel.hidden = false;
  el('#ai-proof-busy').hidden = state !== 'busy';
  el('#ai-proof-step').textContent = step;
  el('#ai-proof-actions').hidden = state !== 'done';
  const n = proofItems.length;
  el('#ai-proof-count').textContent = state === 'done' ? (n ? t('ai.proofFound', { n }) : t('ai.proofNone')) : '';
  el('#btn-ai-proof-apply').hidden = !n;
  el('#btn-ai-proof-discard').textContent = t(n ? 'ai.proofDiscard' : 'btn.close');
  el('#ai-proof-list').innerHTML = proofItems
    .map(
      (f, i) =>
        `<label class="ai-fix${f.kind === 'spell' ? ' spell' : ''}"><input type="checkbox" data-fix="${i}"${f.on ? ' checked' : ''}><span>${f.kind === 'spell' ? `<small>${esc(t('ai.proofSpell'))}</small> ` : ''}${f.html}</span></label>`,
    )
    .join('');
}

function closeProof(): void {
  proofRun++;
  proofJobs = [];
  proofItems = [];
  proofPanel.hidden = true;
  el('#ai-proof-list').innerHTML = '';
}

// Sentences as token ranges [from, to): a sentence ends after . ! ? : or at a line break
function sentences(tok: string[]): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  tok.forEach((w, i) => {
    const end = /\n/.test(w) || (/\S/.test(w) && /[.!?:]["“”»)]*$/.test(w));
    if (end || i === tok.length - 1) {
      out.push([from, i + 1]);
      from = i + 1;
    }
  });
  return out;
}

// Preview of one paragraph: old words struck through, new ones highlighted
const diffHtml = (tok: string[], fixed: string[]) => tok.map((o, i) => (fixed[i] === o ? esc(o) : `<del>${esc(o)}</del><ins>${esc(fixed[i])}</ins>`)).join('');

// Dictionary suggestion for one word: a few words around it as context
function spellHtml(tok: string[], at: number, word: string): string {
  const words = tok.map((w, i) => [w, i] as const).filter(([w]) => /\S/.test(w));
  const k = words.findIndex(([, i]) => i === at);
  const ctx = (list: (readonly [string, number])[]) => list.map(([w]) => esc(w)).join(' ');
  return `${k > 3 ? '… ' : ''}${ctx(words.slice(Math.max(0, k - 3), k))} <del>${esc(tok[at])}</del><ins>${esc(word)}</ins> ${ctx(words.slice(k + 1, k + 4))}${k + 4 < words.length ? ' …' : ''}`;
}

el('#btn-ai-proof').addEventListener('click', async () => {
  const btn = el<HTMLButtonElement>('#btn-ai-proof');
  const sel = getSelection();
  const inEditor = sel && sel.rangeCount && !sel.isCollapsed && editor.contains(sel.getRangeAt(0).commonAncestorContainer);
  const run = ++proofRun;
  proofJobs = [];
  proofItems = [];
  btn.disabled = true;
  setInfo('');
  try {
    // what to check: the selection, or every own text piece above the signature
    const pieces: { range: Range; before: string }[] = [];
    if (inEditor) {
      // Selection.toString keeps the line breaks between paragraphs, Range.toString does not
      pieces.push({ range: sel!.getRangeAt(0).cloneRange(), before: sel!.toString() });
    } else {
      for (const node of ownTextNodes()) {
        const all = node.textContent ?? '';
        // keep leading/trailing spaces exactly – the model tends to trim them
        const lead = all.match(/^\s*/)![0].length;
        const trail = all.match(/\s*$/)![0].length;
        const range = document.createRange();
        range.setStart(node, lead);
        range.setEnd(node, all.length - trail);
        pieces.push({ range, before: all.trim() });
      }
    }
    if (!pieces.length) return void setInfo(t('ai.proofEmpty'));
    proofJobs = pieces.map(({ range, before }) => {
      const tok = before.match(/\s+|\S+/g) ?? [];
      return { range, before, tok, ai: [...tok] };
    });
    const bySentence = aiNow?.proofBySentence ?? true;
    const todo = proofJobs.flatMap((job, j) => (bySentence ? sentences(job.tok) : [[0, job.tok.length] as [number, number]]).map(([from, to]) => ({ j, from, to })));
    let done = 0;
    for (const { j, from, to } of todo) {
      paintProof('busy', t('ai.proofreading', { i: ++done, n: todo.length }));
      const job = proofJobs[j];
      const text = job.tok.slice(from, to).join('').trim();
      if (!/\p{L}{3,}/u.test(text)) continue;
      const res = mergeCorrections(text, (await window.api.ai.proofread(text)).trim());
      if (run !== proofRun) return; // cancelled
      // the sentence's words in the paragraph (leading spaces of the slice are skipped by trim)
      let k = from;
      while (k < to && !/\S/.test(job.tok[k])) k++;
      res.out.forEach((w, i) => (job.ai[k + i] = swissSpelling(job.before, w)));
    }
    // AI corrections: one item per paragraph
    proofJobs.forEach((job, j) => {
      if (job.ai.join('') !== job.before) proofItems.push({ job: j, kind: 'ai', html: diffHtml(job.tok, job.ai), on: true });
    });
    // Dictionary: words that are still unknown after the AI (off when spell check is off)
    const spots = proofJobs.flatMap((job, j) => job.ai.map((w, at) => ({ j, at, word: w.match(WORD)?.[0] ?? '' })))
      .filter(({ word }) => word.length >= 3 && !/\d/.test(word) && word !== word.toUpperCase());
    const wrong = new Map(window.api.spell.check([...new Set(spots.map((x) => x.word))]).filter((x) => x.suggestions.length).map((x) => [x.word, x.suggestions[0]]));
    for (const { j, at, word } of spots) {
      const sugg = wrong.get(word);
      if (!sugg) continue;
      const job = proofJobs[j];
      const fixed = job.ai[at].replace(word, sugg);
      proofItems.push({ job: j, kind: 'spell', at, word: sugg, html: spellHtml(job.ai, at, fixed), on: false });
    }
    paintProof('done');
  } catch (err) {
    if (run === proofRun) {
      closeProof();
      setInfo(errMsg(err));
    }
  } finally {
    if (run === proofRun) btn.disabled = false;
  }
});

el('#ai-proof-list').addEventListener('change', (e) => {
  const box = (e.target as HTMLElement).closest<HTMLInputElement>('[data-fix]');
  if (box) proofItems[Number(box.dataset.fix)].on = box.checked;
});

// Apply the ticked corrections per paragraph; a piece the user changed in the meantime is left alone
el('#btn-ai-proof-apply').addEventListener('click', () => {
  editor.focus(); // the edits go through the editor (and its undo history)
  let n = 0;
  for (let j = proofJobs.length - 1; j >= 0; j--) {
    const job = proofJobs[j];
    const mine = proofItems.filter((f) => f.job === j && f.on);
    if (!mine.length || !editor.contains(job.range.commonAncestorContainer) || norm(job.range.toString()) !== norm(job.before)) continue;
    const final = mine.some((f) => f.kind === 'ai') ? [...job.ai] : [...job.tok];
    for (const f of mine) if (f.kind === 'spell') final[f.at!] = final[f.at!].replace(WORD, f.word!);
    const text = final.join('');
    if (text === job.before) continue;
    replaceRange(job.range, text);
    n += mine.length;
  }
  closeProof();
  setInfo(n ? t('ai.proofDone', { n }) : '');
});
el('#btn-ai-proof-discard').addEventListener('click', closeProof);
el('#btn-ai-proof-stop').addEventListener('click', () => {
  closeProof();
  el<HTMLButtonElement>('#btn-ai-proof').disabled = false;
});

// Translate the selection
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

// Write with AI
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
