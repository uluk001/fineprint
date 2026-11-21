import { deepAnalysis, deviceModelStatus, getCategories, prepareDeviceModel, scanDocument, type DeviceStatus } from '../core/analyzer.ts';
import { hasCloudAccess, initFirebase } from '../core/firebase.ts';
import { labelFor } from '../core/categories.ts';
import { riskScore } from '../core/text.ts';
import type { Category, DeepReport, Finding, ScanResult } from '../core/types.ts';

export interface DocumentSource {
  /** Human-readable name of what is being analyzed (page title, sample name...). */
  describe(): Promise<string>;
  getText(): Promise<string>;
  highlight?(findings: Finding[]): Promise<void>;
  focus?(finding: Finding): Promise<void>;
  clear?(): Promise<void>;
}

export interface AppOptions {
  root: HTMLElement;
  source: DocumentSource;
  getDebugToken?: () => Promise<string | undefined>;
  /** Extra content rendered above the scan card (e.g. the web demo's text input). */
  inputSlot?: HTMLElement;
}

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
};

const STATUS_TEXT: Record<DeviceStatus, [string, string]> = {
  available: ['ok', 'Gemini Nano is ready. Scans stay on this device.'],
  downloadable: ['warn', 'Gemini Nano can be downloaded. The first scan will start the download; meanwhile Fine Print falls back to the cloud.'],
  downloading: ['warn', 'Gemini Nano is downloading. Until it finishes, scans fall back to the cloud.'],
  unavailable: ['cloud', 'On-device AI is not available on this computer. Scans will use Gemini in the cloud.'],
  unsupported: ['cloud', 'This browser has no built-in AI. Scans will use Gemini in the cloud.'],
};

export async function mountApp(opts: AppOptions): Promise<void> {
  const { root, source } = opts;
  let categories: Category[] = [];
  let lastText = '';
  let lastScan: ScanResult | null = null;
  let abort: AbortController | null = null;

  const debugToken = await opts.getDebugToken?.();
  initFirebase({ debugToken });
  getCategories().then((c) => (categories = c));

  // ---------- layout ----------
  const statusDot = h('span', { class: 'fp-dot' });
  const statusText = h('span', {}, 'Checking on-device AI...');
  const statusCard = h('div', { class: 'fp-card' }, h('h3', {}, 'Privacy mode'), h('div', { class: 'fp-status' }, statusDot, statusText));

  const docName = h('div', { class: 'fp-meta' }, '');
  const scanBtn = h('button', { class: 'fp-btn' }, 'Scan for risky clauses');
  const stopBtn = h('button', { class: 'fp-btn secondary hidden' }, 'Stop');
  const bar = h('div');
  const progress = h('div', { class: 'fp-progress hidden' }, bar);
  const progressLabel = h('div', { class: 'fp-progress-label hidden' });
  const scanCard = h('div', { class: 'fp-card' }, h('h3', {}, 'Scan'), docName, h('div', { class: 'fp-row', style: 'margin-top:8px' }, scanBtn, stopBtn), progress, progressLabel);

  const summaryCard = h('div', { class: 'fp-card hidden' });
  const findingsCard = h('div', { class: 'fp-card hidden' }, h('h3', {}, 'Flagged clauses'));
  const findingsList = h('div', { class: 'fp-findings' });
  findingsCard.append(findingsList);

  const scopeFlagged = h('input', { type: 'radio', name: 'scope', value: 'flagged', checked: '' });
  const scopeFull = h('input', { type: 'radio', name: 'scope', value: 'full' });
  const redactBox = h('input', { type: 'checkbox', checked: '' });
  const deepBtn = h('button', { class: 'fp-btn cloud' }, 'Run deep analysis in the cloud');
  const deepOut = h('div', { class: 'fp-deep' });
  const deepCard = h(
    'div',
    { class: 'fp-card fp-consent hidden' },
    h('h3', {}, 'Deep analysis (cloud, opt-in)'),
    h('div', { class: 'fp-note' }, 'Nothing has left your device so far. Choose what Gemini in the cloud may see:'),
    h('label', {}, scopeFlagged, h('span', {}, h('b', {}, 'Only the flagged clauses'), ' with a little context (recommended)')),
    h('label', {}, scopeFull, h('span', {}, h('b', {}, 'The whole document'), ' for the most complete review')),
    h('label', {}, redactBox, h('span', {}, 'Redact emails, phone, card, IBAN and policy numbers first')),
    deepBtn,
    deepOut,
  );

  const errorBox = h('div', { class: 'fp-error hidden' });
  const cloudOffNote = h('div', { class: 'fp-note fp-card hidden' }, 'Deep cloud analysis is off: add an App Check debug token in Settings to enable it. Everything above ran locally.');
  const disclaimer = h('div', { class: 'fp-disclaimer' }, 'Fine Print highlights clauses to read carefully. It is not legal or financial advice.');

  const main = h('main', { class: 'fp-main' }, statusCard, opts.inputSlot ?? null, scanCard, errorBox, summaryCard, findingsCard, deepCard, cloudOffNote, disclaimer);
  root.append(
    h('header', { class: 'fp-header' }, h('div', { class: 'fp-logo' }, 'FP'), h('div', {}, h('div', { class: 'fp-title' }, 'Fine Print'), h('div', { class: 'fp-sub' }, 'Read the terms before they read you')), h('div', { class: 'spacer' })),
    main,
  );

  // ---------- helpers ----------
  const showError = (msg: string | null) => {
    errorBox.textContent = msg ?? '';
    errorBox.classList.toggle('hidden', !msg);
  };

  async function refreshStatus() {
    const s = await deviceModelStatus();
    const [cls, text] = STATUS_TEXT[s];
    statusDot.className = `fp-dot ${cls}`;
    statusText.textContent = text;
    return s;
  }

  async function refreshDocName() {
    try {
      docName.textContent = await source.describe();
    } catch {
      docName.textContent = '';
    }
  }

  function renderSummary(scan: ScanResult) {
    const f = scan.findings;
    const score = riskScore(f);
    const color = score >= 60 ? 'var(--high)' : score >= 30 ? 'var(--medium)' : 'var(--low)';
    const count = (s: string) => f.filter((x) => x.severity === s).length;
    const where =
      scan.cloudChunks === 0
        ? `All ${scan.onDeviceChunks} fragments analyzed on this device. Nothing was sent anywhere.`
        : scan.onDeviceChunks === 0
          ? `${scan.cloudChunks} fragments analyzed in the cloud (on-device AI unavailable).`
          : `${scan.onDeviceChunks} fragments on-device, ${scan.cloudChunks} in the cloud.`;
    summaryCard.replaceChildren(
      h('h3', {}, 'Result'),
      h(
        'div',
        { class: 'fp-summary' },
        h('div', { class: 'fp-score', style: `background:${color}` }, h('div', {}, String(score), h('small', {}, 'risk'))),
        h(
          'div',
          {},
          h('div', {}, h('b', {}, `${f.length} clause${f.length === 1 ? '' : 's'} worth a careful read`)),
          h('div', { class: 'fp-counts' }, h('span', { class: 'fp-pill high' }, `${count('high')} high`), h('span', { class: 'fp-pill medium' }, `${count('medium')} medium`), h('span', { class: 'fp-pill low' }, `${count('low')} low`)),
          h('div', { class: 'fp-meta', style: 'margin-top:6px' }, `${where} ${(scan.ms / 1000).toFixed(1)}s.${scan.truncated ? ' Long document: the first part was analyzed.' : ''}`),
        ),
      ),
    );
    summaryCard.classList.remove('hidden');
  }

  function renderFindings(findings: Finding[]) {
    findingsList.replaceChildren();
    if (!findings.length) {
      findingsList.append(h('div', { class: 'fp-empty' }, 'No risky clauses found yet.'));
    }
    for (const f of findings) {
      const card = h(
        'div',
        { class: `fp-finding ${f.severity}`, title: source.focus ? 'Show in page' : '' },
        h('div', { class: 'top' }, h('span', { class: `fp-pill ${f.severity}` }, f.severity), h('span', { class: 'fp-cat' }, labelFor(categories, f.category)), h('span', { class: `fp-src ${f.source}` }, f.source === 'on_device' ? 'on-device' : 'cloud')),
        h('div', { class: 'fp-quote' }, `"${f.quote}"`),
        h('div', { class: 'fp-expl' }, f.explanation),
      );
      card.addEventListener('click', () => source.focus?.(f));
      findingsList.append(card);
    }
    findingsCard.classList.remove('hidden');
  }

  function renderDeep(r: DeepReport) {
    const color = r.riskLevel === 'high' ? 'var(--high)' : r.riskLevel === 'medium' ? 'var(--medium)' : 'var(--low)';
    const list = (title: string, items: string[]) => (items.length ? [h('h4', {}, title), h('ul', {}, ...items.map((i) => h('li', {}, i)))] : []);
    deepOut.replaceChildren(
      h('h4', {}, 'Verdict ', h('span', { class: 'fp-risk-badge', style: `background:${color};color:#fff` }, `${r.riskLevel} risk`)),
      h('p', { style: 'margin:4px 0' }, r.summary),
      ...(r.topConcerns.length
        ? [h('h4', {}, 'Top concerns'), h('ul', {}, ...r.topConcerns.map((c) => h('li', {}, h('b', {}, c.title), ': ', c.why)))]
        : []),
      ...list('Ask before you sign', r.questionsToAsk),
      ...list('Protections that may be missing', r.missingProtections),
      ...list('What to negotiate', r.negotiationTips),
      h('div', { class: 'fp-note', style: 'margin-top:8px' }, `Sent ${r.sentChars.toLocaleString()} characters to Gemini in the cloud${r.redactions ? `, ${r.redactions} personal details redacted` : ''}. ${(r.ms / 1000).toFixed(1)}s.`),
    );
  }

  // ---------- actions ----------
  scanBtn.addEventListener('click', async () => {
    showError(null);
    scanBtn.disabled = true;
    stopBtn.classList.remove('hidden');
    progress.classList.remove('hidden');
    progressLabel.classList.remove('hidden');
    bar.style.width = '0%';
    deepOut.replaceChildren();
    deepCard.classList.add('hidden');
    await source.clear?.();

    try {
      // User gesture: allowed to start the Gemini Nano download.
      const status = await refreshStatus();
      if (status === 'downloadable' || status === 'downloading') {
        progressLabel.textContent = 'Preparing Gemini Nano...';
        prepareDeviceModel((p) => {
          progressLabel.textContent = `Downloading Gemini Nano ${Math.round(p * 100)}% (cloud fallback meanwhile)`;
          if (p >= 1) refreshStatus();
        }, debugToken);
      } else if (status === 'available') {
        await prepareDeviceModel(() => {}, debugToken);
      }

      lastText = await source.getText();
      if (lastText.trim().length < 200) {
        throw new Error('There is not enough text here to analyze. Open a terms, policy or agreement page, or select the text you want checked.');
      }
      await refreshDocName();
      abort = new AbortController();
      progressLabel.textContent = 'Reading the document...';
      lastScan = await scanDocument(lastText, {
        signal: abort.signal,
        debugToken,
        onProgress: (p, partial) => {
          bar.style.width = `${Math.round((100 * p.done) / Math.max(1, p.total))}%`;
          progressLabel.textContent = `Fragment ${p.done} of ${p.total} · ${p.onDevice} on-device · ${p.inCloud} cloud`;
          renderFindings(partial);
          source.highlight?.(partial);
        },
      });
      renderSummary(lastScan);
      renderFindings(lastScan.findings);
      await source.highlight?.(lastScan.findings);
      deepCard.classList.toggle('hidden', !hasCloudAccess());
      cloudOffNote.classList.toggle('hidden', hasCloudAccess());
    } catch (e) {
      showError((e as Error).message || String(e));
    } finally {
      scanBtn.disabled = false;
      stopBtn.classList.add('hidden');
      progress.classList.add('hidden');
      progressLabel.classList.add('hidden');
      scanBtn.textContent = 'Scan again';
    }
  });

  stopBtn.addEventListener('click', () => abort?.abort());

  deepBtn.addEventListener('click', async () => {
    if (!lastScan) return;
    showError(null);
    deepBtn.disabled = true;
    deepBtn.textContent = 'Asking Gemini in the cloud...';
    try {
      const report = await deepAnalysis(lastText, lastScan.findings, {
        scope: scopeFull.checked ? 'full' : 'flagged',
        redact: redactBox.checked,
        debugToken,
      });
      renderDeep(report);
    } catch (e) {
      showError(`Deep analysis failed: ${(e as Error).message}`);
    } finally {
      deepBtn.disabled = false;
      deepBtn.textContent = 'Run deep analysis again';
    }
  });

  await refreshStatus();
  await refreshDocName();
}
