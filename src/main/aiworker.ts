// Mini-KI worker: runs in its own process (Electron utilityProcess), so the UI never blocks.
// Loads the GGUF model with node-llama-cpp on the first request; the main process ends this
// process after a few idle minutes, which frees the RAM again. Everything runs offline.
/* eslint-disable @typescript-eslint/no-explicit-any */

type Job = { id: number; kind: 'subjects' | 'proofread' | 'write' | 'translate'; text: string; modelPath: string; lang: string; ctx?: { original?: string; subject?: string } };

// node-llama-cpp is an ES module; tsc turns import() into require() for CommonJS → keep a real import
const esmImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

let lib: any = null;
let llama: any = null;
let model: any = null;
let modelPath = '';
let context: any = null;

async function ensureModel(path: string): Promise<void> {
  if (model && modelPath === path) return;
  lib ??= await esmImport('node-llama-cpp');
  // Mac: Metal (Apple GPU) where available; elsewhere the CPU – the installer ships no CUDA/Vulkan builds
  llama ??= await lib.getLlama({ gpu: process.platform === 'darwin' ? 'auto' : false });
  if (model) await model.dispose();
  model = await llama.loadModel({ modelPath: path });
  context = await model.createContext({ contextSize: 4096 });
  modelPath = path;
}

// Output language – chosen in the app, independent of the UI language
const LANG_RULE: Record<string, string> = {
  auto: 'Use the same language as the e-mail.',
  'de-CH': 'Write in Swiss Standard German (de-CH), the written standard language – not Swiss dialect (no "Hoi", "Grüezi"): never use the letter "ß", always "ss" (e.g. "Grüsse", "gross", "Strasse").',
  'de-DE': 'Write in German as used in Germany (standard spelling with "ß").',
  de: 'Write in German.',
  en: 'Write in English.',
  fr: 'Write in French.',
  it: 'Write in Italian.',
  es: 'Write in Spanish.',
  pt: 'Write in Portuguese.',
  nl: 'Write in Dutch.',
  zh: 'Write in Simplified Chinese.',
  ja: 'Write in Japanese.',
  ko: 'Write in Korean.',
  ar: 'Write in Arabic.',
};
const langRule = (lang: string) => LANG_RULE[lang] ?? LANG_RULE.auto;
const LANG_NAME: Record<string, string> = {
  'de-CH': 'Swiss Standard German (no "ß")',
  'de-DE': 'German',
  de: 'German',
  en: 'English',
  fr: 'French',
  it: 'Italian',
  es: 'Spanish',
  pt: 'Portuguese',
  nl: 'Dutch',
  zh: 'Simplified Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  ar: 'Arabic',
};
// Small models follow the language of the instruction text – so the target language is repeated
// right where they read it last
const langReminder = (lang: string) => (LANG_NAME[lang] ? `\n\nWrite the e-mail in ${LANG_NAME[lang]}, even if the instruction or the original e-mail is in another language.` : '');

// Which language a text is in – by frequent short words. Small models answer in the language of the
// instruction, so a German instruction to an English mail gave a German reply; the detected language
// is passed on explicitly instead.
const STOPWORDS: Record<string, string[]> = {
  de: 'und der die das ist nicht ich du sie wir mit für auf ein eine einen zu den dem es bitte danke hallo gruss grüsse liebe lieber wie was wenn aber auch noch schon bei von sind haben wird kann mir dir uns euch'.split(' '),
  en: 'the and is are you to of for with that this it not we be have will can please thanks thank hi hello dear best regards would could your our my me from at on in'.split(' '),
  fr: 'le la les et est vous pour avec une des que pas nous je merci bonjour cordialement salut votre notre sur dans au aux'.split(' '),
  it: 'il la le è per con che non sono una ciao grazie buongiorno saluti cordiali vostro nostro della delle gli anche'.split(' '),
};
function detectLang(text: string | undefined): string | null {
  const words = (text ?? '').toLowerCase().match(/\p{L}+/gu) ?? [];
  const score = Object.entries(STOPWORDS).map(([lang, list]) => [lang, words.filter((w) => list.includes(w)).length] as const).sort((a, b) => b[1] - a[1]);
  const [best, second] = score;
  return best[1] >= 2 && best[1] >= second[1] * 1.5 ? best[0] : null;
}

// Replies always use the language of the mail; for German the chosen spelling (CH/DE) applies.
// New mails use the setting, with "auto" the language of the instruction.
function writeLang(job: Job): string {
  const mail = detectLang(job.ctx?.original);
  const german = job.lang === 'de-CH' || job.lang === 'de-DE' ? job.lang : 'de';
  if (mail) return mail === 'de' ? german : mail;
  if (job.lang !== 'auto') return job.lang;
  const own = detectLang(job.text);
  return own === 'de' ? german : (own ?? 'auto');
}

const subjectSystem = (lang: string) =>
  'You write e-mail subject lines: short noun phrases that summarise the topic. ' +
  langRule(lang) +
  ' Never copy sentences or greetings from the e-mail. Examples:\n' +
  'E-mail: "Hallo Peter, kannst du mir bis Freitag die Folien für die Kundenpräsentation schicken? Danke, Lea" → ' +
  '["Folien für Kundenpräsentation bis Freitag", "Bitte um Präsentationsfolien", "Kundenpräsentation: Folien benötigt"]\n' +
  'E-mail: "Dear all, the office will be closed on Monday due to maintenance work. Best, Tom" → ' +
  '["Office closed on Monday", "Maintenance work: office closure Monday", "No office access on Monday"]';

// Proofreading never changes the language; only the Swiss/German spelling rule applies
const proofSystem = (lang: string) =>
  'You are a careful proofreader. Correct spelling, grammar and punctuation of the text in its own language. ' +
  'Keep the wording, tone, line breaks and meaning exactly; keep numbers, times and dates exactly as written (never "10" → "zehn"); ' +
  'do not add or remove content. Reply with the corrected text only.' +
  (lang === 'de-CH' || lang === 'de-DE' ? ` If the text is German: ${langRule(lang)}` : '');

const translateSystem = (lang: string) =>
  `You are a professional translator. Translate the text into ${LANG_NAME[lang] ?? 'English'}. ${langRule(lang)} ` +
  'Translate word for word in meaning: keep the tone and line breaks; translate weekdays and months literally ' +
  '(Tuesday = Dienstag = martes) and never change, add or calculate dates, times or numbers; keep names, e-mail addresses and links exactly. ' +
  'Do not add explanations, notes or quotation marks. Reply with the translation only.';

const writeSystem = (lang: string) =>
  'You write the body of an e-mail for the user, following the instruction. ' +
  (lang === 'auto' ? 'Use the language of the original e-mail when replying, otherwise the language of the instruction. ' : `${langRule(lang)} `) +
  'If replying, address the person the same way they address the user (first name and "du", or "Sie"). ' +
  'Start with a fitting greeting line, then the message: natural, polite, clear and short. Plain text, no Markdown. ' +
  'Do NOT add a closing formula, name or signature. ' +
  'Only say what the instruction asks for: do not invent facts, times, dates, prices, plans or promises that are not in the instruction ' +
  'or the original e-mail. Reply with the body text only.';

// Swiss spelling is enforced, not just asked for; Markdown (**bold**) never belongs in a mail.
// dialect = false for proofreading: the user's own "Hoi Peter" stays (and would make the check reject the whole correction)
function finish(text: string, lang: string, dialect = true): string {
  let out = text.replace(/\*\*(.+?)\*\*/gs, '$1').replace(/__(.+?)__/gs, '$1').replace(/^#{1,6}\s+/gm, '');
  if (lang === 'de-CH') out = out.replace(/ß/g, 'ss');
  // dialect greetings slip in for Swiss German – a mail uses the written standard
  if (dialect && lang.startsWith('de')) out = out.replace(/^(\s*)(?:Hoi|Sali)\b/gm, '$1Hallo').replace(/^(\s*)Grüezi\b/gm, '$1Guten Tag');
  return out;
}

// One fresh chat per job: no history leaks from one mail into the next
async function ask(system: string, prompt: string, opts: Record<string, unknown>): Promise<string> {
  const sequence = context.getSequence();
  try {
    const session = new lib.LlamaChatSession({ contextSequence: sequence, systemPrompt: system });
    return await session.prompt(prompt, opts);
  } finally {
    sequence.dispose();
  }
}

async function run(job: Job): Promise<unknown> {
  await ensureModel(job.modelPath);
  if (job.kind === 'subjects') {
    const grammar = await llama.createGrammarForJsonSchema({
      type: 'object',
      properties: { subjects: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 } },
    });
    const answer = await ask(subjectSystem(job.lang), `E-mail: "${job.text.replace(/\s+/g, ' ')}" →${LANG_NAME[job.lang] ? ` (subjects in ${LANG_NAME[job.lang]})` : ''}`, { grammar, maxTokens: 160, temperature: 0.3 });
    const subjects: string[] = grammar.parse(answer).subjects ?? [];
    const words = (x: string) => x.split(/\s+/).filter(Boolean).length;
    const body = job.text.toLowerCase();
    return subjects
      .map((x) => finish(x, job.lang).replace(/^["'„“]+|["'“”.]+$/g, '').trim())
      // a subject is short and not a sentence copied from the mail
      .filter((x) => x && words(x) <= 10 && !(words(x) > 3 && body.includes(x.toLowerCase())))
      .slice(0, 3);
  }
  if (job.kind === 'write') {
    const parts: string[] = [];
    if (job.ctx?.original) parts.push(`You are replying to this e-mail${job.ctx.subject ? ` (subject: ${job.ctx.subject})` : ''}:\n----\n${job.ctx.original}\n----`);
    else if (job.ctx?.subject) parts.push(`Subject of the new e-mail: ${job.ctx.subject}`);
    parts.push(`Instruction: ${job.text}`);
    const lang = writeLang(job);
    const answer = await ask(writeSystem(lang), parts.join('\n\n') + langReminder(lang), { maxTokens: 450, temperature: 0.3 });
    return finish(answer.replace(/^(subject|betreff):.*\n+/i, ''), lang).trim();
  }
  if (job.kind === 'translate') {
    const answer = await ask(translateSystem(job.lang), job.text, { maxTokens: Math.min(2048, Math.ceil(job.text.length / 2) + 128), temperature: 0 });
    return finish(answer, job.lang).trim();
  }
  const answer = await ask(proofSystem(job.lang), job.text, { maxTokens: Math.min(2048, Math.ceil(job.text.length / 2) + 64), temperature: 0 });
  return finish(answer, job.lang, false).trim();
}

// Jobs arrive one after another (the main process queues them)
const port = (process as any).parentPort;
port.on('message', async (e: { data: Job }) => {
  const job = e.data;
  try {
    port.postMessage({ id: job.id, ok: true, result: await run(job) });
  } catch (err) {
    port.postMessage({ id: job.id, ok: false, error: (err as Error)?.message ?? String(err) });
  }
});
