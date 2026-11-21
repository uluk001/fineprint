import '../src/ui/styles.css';
import './web.css';
import { mountApp, type DocumentSource } from '../src/ui/app.ts';
import { SAMPLES } from '../src/core/samples.ts';
import type { Finding } from '../src/core/types.ts';
import { decompressFromEncodedURIComponent } from 'lz-string';

const textarea = document.getElementById('doc') as HTMLTextAreaElement;
const preview = document.getElementById('preview') as HTMLDivElement;
const select = document.getElementById('sample') as HTMLSelectElement;
const title = document.getElementById('doc-title') as HTMLDivElement;
const editBtn = document.getElementById('edit') as HTMLButtonElement;

select.append(new Option('Choose a sample document', ''));
for (const s of SAMPLES) select.append(new Option(s.title, s.id));

function loadSample(id: string) {
  const s = SAMPLES.find((x) => x.id === id);
  if (!s) return;
  textarea.value = s.text;
  title.textContent = s.title;
  showEditor();
}
select.addEventListener('change', () => loadSample(select.value));

// Documents can be handed over in the URL fragment (never sent to a server).
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('doc')) {
  textarea.value = decompressFromEncodedURIComponent(hash.get('doc')!) ?? '';
  title.textContent = hash.get('title') ?? 'Shared document';
} else {
  select.value = SAMPLES[0].id;
  loadSample(SAMPLES[0].id);
}

function showEditor() {
  preview.classList.add('hidden');
  textarea.classList.remove('hidden');
  editBtn.classList.add('hidden');
}
editBtn.addEventListener('click', showEditor);

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function renderPreview(findings: Finding[]) {
  const text = textarea.value;
  const spans: { start: number; end: number; f: Finding }[] = [];
  for (const f of findings) {
    const at = text.indexOf(f.quote);
    if (at >= 0 && !spans.some((s) => at < s.end && at + f.quote.length > s.start)) {
      spans.push({ start: at, end: at + f.quote.length, f });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let html = '';
  let pos = 0;
  for (const s of spans) {
    html += escapeHtml(text.slice(pos, s.start));
    html += `<mark class="sev-${s.f.severity}" data-id="${s.f.id}" title="${escapeHtml(s.f.explanation)}">${escapeHtml(text.slice(s.start, s.end))}</mark>`;
    pos = s.end;
  }
  html += escapeHtml(text.slice(pos));
  preview.innerHTML = html;
  preview.classList.remove('hidden');
  textarea.classList.add('hidden');
  editBtn.classList.remove('hidden');
}

const source: DocumentSource = {
  async describe() {
    return title.textContent ?? 'Pasted text';
  },
  async getText() {
    return textarea.value;
  },
  async highlight(findings) {
    renderPreview(findings);
  },
  async focus(f) {
    const el = preview.querySelector<HTMLElement>(`mark[data-id="${f.id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1800);
  },
  async clear() {
    showEditor();
  },
};

textarea.addEventListener('input', () => {
  if (select.value) {
    select.value = '';
    title.textContent = 'Pasted text';
  }
});

mountApp({ root: document.getElementById('app')!, source });
