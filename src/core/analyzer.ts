import { getGenerativeModel, InferenceMode, type GenerativeModel } from 'firebase/ai';
import { initFirebase, loadSettings, type AppSettings } from './firebase.ts';
import { chunkText, groundQuote, dedupeFindings, redactPII, buildFlaggedExcerpts } from './text.ts';
import type { Category, DeepReport, DeepScope, Finding, ScanProgress, ScanResult, Severity, Source } from './types.ts';

export type DeviceStatus = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';

interface LanguageModelStatic {
  availability(opts?: unknown): Promise<string>;
}

/** Ask Chrome directly whether Gemini Nano can run here (before any Firebase call). */
export async function deviceModelStatus(): Promise<DeviceStatus> {
  const lm = (globalThis as unknown as { LanguageModel?: LanguageModelStatic }).LanguageModel;
  if (!lm) return 'unsupported';
  try {
    const s = await lm.availability({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });
    if (s === 'available' || s === 'downloadable' || s === 'downloading' || s === 'unavailable') return s;
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function scanInstruction(categories: Category[]): string {
  return [
    'You are Fine Print, a consumer-protection assistant.',
    'You read ONE fragment of terms and conditions: an insurance policy, a loan or credit agreement, or a subscription contract.',
    'Find clauses that can cost the reader money, rights, coverage or privacy.',
    'For each risky clause return:',
    '- "quote": an EXACT copy of the clause text from the fragment, 40 to 180 characters, copied word for word.',
    '- "category": one id from the list below.',
    '- "severity": "high" (likely to cost money or deny a claim), "medium" (notable restriction) or "low" (worth knowing).',
    '- "explanation": one plain-English sentence of at most 20 words, written to the reader in the second person, saying what it could cost them.',
    'Pay special attention to exclusions (what is NOT covered), fees, deadlines, automatic charges, data sharing, arbitration and limits on what the provider pays.',
    'Only flag clauses that are really in the fragment. Ignore headings, navigation, contact details and marketing text.',
    'If nothing is risky, return an empty "findings" list.',
    'Categories:',
    ...categories.map((c) => `- ${c.id}: ${c.hint}`),
  ].join('\n');
}

function scanSchema(categories: Category[]) {
  return {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            quote: { type: 'string' },
            category: { type: 'string', enum: categories.map((c) => c.id) },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            explanation: { type: 'string' },
          },
          required: ['quote', 'category', 'severity', 'explanation'],
        },
      },
    },
    required: ['findings'],
  };
}

const deepSchema = {
  type: 'object',
  properties: {
    riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
    summary: { type: 'string' },
    topConcerns: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, why: { type: 'string' }, quote: { type: 'string' } },
        required: ['title', 'why', 'quote'],
      },
    },
    questionsToAsk: { type: 'array', maxItems: 6, items: { type: 'string' } },
    missingProtections: { type: 'array', maxItems: 5, items: { type: 'string' } },
    negotiationTips: { type: 'array', maxItems: 5, items: { type: 'string' } },
  },
  required: ['riskLevel', 'summary', 'topConcerns', 'questionsToAsk', 'missingProtections', 'negotiationTips'],
};

const DEEP_INSTRUCTION = [
  'You are Fine Print, a senior consumer advocate who reviews insurance policies, loan agreements and subscription terms.',
  'You receive either the full document or only the clauses that an on-device model already flagged, with surrounding context.',
  'Personal data has been replaced with tokens like [EMAIL] or [REFERENCE]; ignore them.',
  'Write for a regular person, not a lawyer. Be concrete and short.',
  'riskLevel: overall risk of signing as-is.',
  'summary: 3 to 4 sentences: what this document commits the reader to and the biggest catch.',
  'topConcerns: the most important problems, each with a short title, why it matters in money or rights, and the exact quote it is based on.',
  'questionsToAsk: questions the reader should ask the provider before signing.',
  'missingProtections: standard consumer protections that seem to be absent (say "may be missing" when only excerpts were provided).',
  'negotiationTips: practical things the reader can ask to change, or alternatives to look for.',
  'Do not give legal advice disclaimers; the app shows its own.',
].join('\n');

let scanModel: GenerativeModel | null = null;
let deepModel: GenerativeModel | null = null;
let deepFallbackModel: GenerativeModel | null = null;

const TRANSIENT = /\b(429|500|503)\b|high demand|overloaded|unavailable|RESOURCE_EXHAUSTED/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Cloud models can be briefly overloaded: retry once, then fall back to a lighter model. */
async function withCloudRetry<T>(primary: () => Promise<T>, fallback?: () => Promise<T>): Promise<T> {
  try {
    return await primary();
  } catch (e) {
    if (!TRANSIENT.test(String((e as Error)?.message ?? e))) throw e;
    await sleep(1500);
    try {
      return await primary();
    } catch (e2) {
      if (!fallback || !TRANSIENT.test(String((e2 as Error)?.message ?? e2))) throw e2;
      console.warn('[FinePrint] primary cloud model busy, using fallback model');
      return await fallback();
    }
  }
}
let currentSettings: AppSettings | null = null;

async function ensureModels(debugToken?: string): Promise<AppSettings> {
  const { ai } = initFirebase({ debugToken });
  const settings = await loadSettings();
  if (!scanModel || currentSettings !== settings) {
    const schema = scanSchema(settings.categories);
    const instruction = scanInstruction(settings.categories);
    // Hybrid: prefer Gemini Nano on the device; if it is missing or still downloading,
    // the SDK transparently falls back to Gemini in the cloud with the same contract.
    scanModel = getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_ON_DEVICE,
      onDeviceParams: {
        createOptions: {
          expectedInputs: [{ type: 'text', languages: ['en'] }],
          expectedOutputs: [{ type: 'text', languages: ['en'] }],
          initialPrompts: [{ role: 'system', content: [{ type: 'text', value: instruction }] }],
        },
        promptOptions: { responseConstraint: schema },
      },
      inCloudParams: {
        model: settings.scanCloudModel,
        systemInstruction: instruction,
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, temperature: 0.1 },
      },
    });
    // Deep analysis is cloud-only by design and runs only after explicit consent.
    deepModel = getGenerativeModel(ai, {
      mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: {
        model: settings.deepModel,
        systemInstruction: DEEP_INSTRUCTION,
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: deepSchema, temperature: 0.3 },
      },
    });
    deepFallbackModel = getGenerativeModel(ai, {
      mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: {
        model: settings.scanCloudModel,
        systemInstruction: DEEP_INSTRUCTION,
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: deepSchema, temperature: 0.3 },
      },
    });
    currentSettings = settings;
  }
  return settings;
}

/** Must be called from a user gesture (button click) so Chrome is allowed to download Gemini Nano. */
export async function prepareDeviceModel(onProgress: (p: number) => void, debugToken?: string): Promise<void> {
  await ensureModels(debugToken);
  try {
    await scanModel!.initializeDeviceModel(onProgress);
  } catch (e) {
    console.warn('[FinePrint] on-device model init failed, cloud fallback will be used', e);
  }
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      return null;
    }
  }
}

interface RawFinding {
  quote?: string;
  category?: string;
  severity?: string;
  explanation?: string;
}

export interface ScanOptions {
  onProgress?: (p: ScanProgress, partial: Finding[]) => void;
  signal?: AbortSignal;
  debugToken?: string;
}

export async function scanDocument(text: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const started = performance.now();
  const settings = await ensureModels(opts.debugToken);
  const allChunks = chunkText(text, settings.chunkChars);
  const chunks = allChunks.slice(0, settings.maxChunks);
  const validCategories = new Set(settings.categories.map((c) => c.id));
  const progress: ScanProgress = { done: 0, total: chunks.length, onDevice: 0, inCloud: 0 };
  let findings: Finding[] = [];
  let dropped = 0;

  for (let i = 0; i < chunks.length; i++) {
    if (opts.signal?.aborted) break;
    const chunk = chunks[i];
    let source: Source = 'on_device';
    let raw: RawFinding[] = [];
    try {
      const prompt = `Fragment ${i + 1} of ${chunks.length}:\n"""\n${chunk}\n"""`;
      const res = await withCloudRetry(() => scanModel!.generateContent(prompt));
      source = (res.response.inferenceSource as Source) ?? 'in_cloud';
      const parsed = parseJson<{ findings?: RawFinding[] }>(res.response.text());
      raw = parsed?.findings ?? [];
    } catch (e) {
      console.warn(`[FinePrint] chunk ${i + 1} failed`, e);
    }
    if (source === 'on_device') progress.onDevice++;
    else progress.inCloud++;

    for (const r of raw) {
      if (!r.quote || !r.explanation) continue;
      const grounded = groundQuote(r.quote, chunk);
      if (!grounded) {
        dropped++;
        continue;
      }
      const severity: Severity = r.severity === 'high' || r.severity === 'medium' ? r.severity : 'low';
      findings.push({
        id: `f${i}-${findings.length}`,
        quote: grounded,
        category: r.category && validCategories.has(r.category) ? r.category : 'unilateral_change',
        severity,
        explanation: r.explanation.trim(),
        chunkIndex: i,
        source,
      });
    }
    findings = dedupeFindings(findings);
    progress.done = i + 1;
    opts.onProgress?.({ ...progress }, findings);
  }

  return {
    findings,
    chunks: chunks.length,
    analyzedChars: chunks.reduce((s, c) => s + c.length, 0),
    truncated: allChunks.length > chunks.length,
    onDeviceChunks: progress.onDevice,
    cloudChunks: progress.inCloud,
    droppedUngrounded: dropped,
    ms: Math.round(performance.now() - started),
  };
}

export interface DeepOptions {
  scope: DeepScope;
  redact: boolean;
  debugToken?: string;
}

export async function deepAnalysis(text: string, findings: Finding[], opts: DeepOptions): Promise<DeepReport> {
  await ensureModels(opts.debugToken);
  let payload =
    opts.scope === 'full'
      ? text.slice(0, 60000)
      : buildFlaggedExcerpts(text, findings) || text.slice(0, 6000);
  let redactions = 0;
  if (opts.redact) {
    const r = redactPII(payload);
    payload = r.text;
    redactions = r.count;
  }
  const header =
    opts.scope === 'full'
      ? 'FULL DOCUMENT:'
      : `FLAGGED CLAUSES ONLY (${findings.length} found on-device; the rest of the document was not shared):`;
  const prompt = `${header}\n"""\n${payload}\n"""`;
  const res = await withCloudRetry(
    () => deepModel!.generateContent(prompt),
    () => deepFallbackModel!.generateContent(prompt),
  );
  const parsed = parseJson<Omit<DeepReport, 'source' | 'sentChars' | 'redactions'>>(res.response.text());
  if (!parsed) throw new Error('The cloud model returned an unreadable answer. Please try again.');
  return {
    riskLevel: parsed.riskLevel ?? 'medium',
    summary: parsed.summary ?? '',
    topConcerns: parsed.topConcerns ?? [],
    questionsToAsk: parsed.questionsToAsk ?? [],
    missingProtections: parsed.missingProtections ?? [],
    negotiationTips: parsed.negotiationTips ?? [],
    source: (res.response.inferenceSource as Source) ?? 'in_cloud',
    sentChars: payload.length,
    redactions,
  };
}

export async function getCategories(): Promise<Category[]> {
  return (await loadSettings()).categories;
}
