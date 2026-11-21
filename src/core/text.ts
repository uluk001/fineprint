import type { Finding, Severity } from './types.ts';

/** Collapse whitespace and normalize quotes so model output can be matched to source text. */
export function normalize(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Split text into chunks of at most `maxChars`, preferring paragraph, then sentence boundaries.
 * Gemini Nano has a small context window, so every chunk must fit in one prompt.
 */
export function chunkText(text: string, maxChars = 2800): string[] {
  const clean = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = '';

  const pushPiece = (piece: string) => {
    if (!piece.trim()) return;
    if ((current + '\n\n' + piece).length <= maxChars) {
      current = current ? current + '\n\n' + piece : piece;
      return;
    }
    if (current) chunks.push(current);
    current = '';
    if (piece.length <= maxChars) {
      current = piece;
      return;
    }
    // Paragraph is too long: split by sentences, then hard-wrap as a last resort.
    const sentences = piece.match(/[^.!?;]+[.!?;]+["')\]]*\s*|[^.!?;]+$/g) ?? [piece];
    for (const s of sentences) {
      if ((current + s).length <= maxChars) {
        current += s;
      } else {
        if (current) chunks.push(current.trim());
        if (s.length <= maxChars) {
          current = s;
        } else {
          for (let i = 0; i < s.length; i += maxChars) chunks.push(s.slice(i, i + maxChars));
          current = '';
        }
      }
    }
  };

  for (const p of paragraphs) pushPiece(p.trim());
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Small models sometimes paraphrase instead of quoting. A finding is kept only if its quote
 * can be found in the chunk it came from, so every highlight points at real text.
 * Returns the exact substring from the source when found, otherwise null.
 */
export function groundQuote(quote: string, chunk: string): string | null {
  const q = normalize(quote).replace(/^["'.\s]+|["'.\s]+$/g, '');
  if (q.length < 12) return null;
  const hay = normalize(chunk);
  if (hay.includes(q)) return exactSlice(chunk, q) ?? quote.trim();
  // Fall back to the longest prefix of at least 40 chars (the model may have truncated or drifted).
  for (let len = Math.min(q.length, 160); len >= 40; len -= 10) {
    const prefix = q.slice(0, len);
    if (hay.includes(prefix)) return exactSlice(chunk, prefix) ?? prefix;
  }
  return null;
}

/** Map a normalized needle back to the exact original substring (keeps original casing). */
function exactSlice(source: string, normalizedNeedle: string): string | null {
  // Build normalized string with index map back to source.
  const map: number[] = [];
  let norm = '';
  let lastSpace = true;
  for (let i = 0; i < source.length; i++) {
    let ch = source[i];
    if (/\s/.test(ch)) {
      if (lastSpace) continue;
      ch = ' ';
      lastSpace = true;
    } else {
      lastSpace = false;
      ch = normalize(ch) || ch.toLowerCase();
    }
    norm += ch;
    map.push(i);
  }
  const at = norm.indexOf(normalizedNeedle);
  if (at < 0) return null;
  const start = map[at];
  const end = map[Math.min(at + normalizedNeedle.length - 1, map.length - 1)] + 1;
  return source.slice(start, end);
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Remove near-duplicate findings (same clause flagged from overlapping wording) and sort by severity. */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const out: Finding[] = [];
  for (const f of findings) {
    const key = normalize(f.quote).slice(0, 60);
    const dup = out.find((o) => {
      const ok = normalize(o.quote).slice(0, 60);
      return ok === key || ok.includes(key) || key.includes(ok);
    });
    if (!dup) {
      out.push(f);
    } else if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[dup.severity]) {
      Object.assign(dup, { severity: f.severity, explanation: f.explanation, category: f.category });
    }
  }
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.chunkIndex - b.chunkIndex);
}

/** 0-100 score: weighted by severity, saturating so long contracts do not always max out. */
export function riskScore(findings: Finding[]): number {
  const raw = findings.reduce((s, f) => s + (f.severity === 'high' ? 12 : f.severity === 'medium' ? 6 : 2), 0);
  return Math.round(100 * (1 - Math.exp(-raw / 45)));
}

export interface RedactionResult {
  text: string;
  count: number;
}

/**
 * Redact obvious personal data before anything is sent to the cloud:
 * emails, phone numbers, card-like numbers, IBANs, policy/contract numbers.
 */
export function redactPII(text: string): RedactionResult {
  let count = 0;
  const rules: [RegExp, string][] = [
    [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]'],
    [/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/g, '[IBAN]'],
    [/\b(?:\d[ -]?){13,19}\b/g, '[CARD]'],
    [/(?:\+\d{1,3}[\s-]?)?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2,4}(?:[\s-]?\d{2})?\b/g, '[PHONE]'],
    [/\b(?:policy|contract|account|agreement|member)\s*(?:no\.?|number|#|id)\s*[:#]?\s*[A-Z0-9-]{4,}\b/gi, '[REFERENCE]'],
  ];
  let out = text;
  for (const [re, token] of rules) {
    out = out.replace(re, () => {
      count++;
      return token;
    });
  }
  return { text: out, count };
}

/** Build the minimal excerpt set for a "flagged clauses only" cloud request. */
export function buildFlaggedExcerpts(fullText: string, findings: Finding[], context = 280): string {
  const parts: string[] = [];
  const normFull = fullText;
  for (const f of findings) {
    const idx = normFull.indexOf(f.quote);
    if (idx < 0) {
      parts.push(`[${f.category} | ${f.severity}] "${f.quote}"`);
      continue;
    }
    const start = Math.max(0, idx - context);
    const end = Math.min(normFull.length, idx + f.quote.length + context);
    parts.push(`[${f.category} | ${f.severity}] ...${normFull.slice(start, end).replace(/\s+/g, ' ').trim()}...`);
  }
  return parts.join('\n\n');
}
