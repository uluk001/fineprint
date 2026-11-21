// Fine Print content script: extracts page text and highlights flagged clauses
// with the CSS Custom Highlight API (no DOM mutation, so pages never break).

type Sev = 'high' | 'medium' | 'low';
interface Mark {
  quote: string;
  severity: Sev;
}

declare global {
  interface Window {
    __finePrintLoaded?: boolean;
  }
}

if (!window.__finePrintLoaded) {
  window.__finePrintLoaded = true;

  const STYLE_ID = 'fineprint-highlight-style';
  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      ::highlight(fp-high) { background-color: rgba(198, 46, 46, 0.22); text-decoration: underline 2px rgba(198,46,46,.8); }
      ::highlight(fp-medium) { background-color: rgba(230, 150, 20, 0.25); }
      ::highlight(fp-low) { background-color: rgba(58, 111, 69, 0.18); }
      ::highlight(fp-focus) { background-color: rgba(74, 91, 212, 0.45); color: inherit; }
    `;
    document.documentElement.append(style);
  };

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'CANVAS']);

  const norm = (ch: string): string => {
    if (/[‘’‛]/.test(ch)) return "'";
    if (/[“”‟]/.test(ch)) return '"';
    if (/[–—]/.test(ch)) return '-';
    return ch.toLowerCase();
  };

  const normalizeQuote = (s: string) =>
    s
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”‟]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  /** Index of all visible text: normalized string plus a map back to (node, offset). */
  const buildIndex = () => {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    let text = '';
    const map: { node: Text; offset: number }[] = [];
    let lastSpace = true;
    for (const node of nodes) {
      const v = node.nodeValue ?? '';
      for (let i = 0; i < v.length; i++) {
        const ch = v[i];
        if (/\s/.test(ch)) {
          if (lastSpace) continue;
          text += ' ';
          lastSpace = true;
        } else {
          text += norm(ch);
          lastSpace = false;
        }
        map.push({ node, offset: i });
      }
      if (!lastSpace) {
        // Boundary between nodes counts as whitespace (e.g. between <td> cells).
        text += ' ';
        map.push({ node, offset: v.length });
        lastSpace = true;
      }
    }
    return { text, map };
  };

  const findRange = (quote: string, index = buildIndex()): Range | null => {
    let q = normalizeQuote(quote);
    let at = index.text.indexOf(q);
    if (at < 0 && q.length > 60) {
      q = q.slice(0, 60);
      at = index.text.indexOf(q);
    }
    if (at < 0) return null;
    const start = index.map[at];
    const end = index.map[Math.min(at + q.length - 1, index.map.length - 1)];
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, Math.min(end.offset + 1, end.node.length));
    return range;
  };

  const clearAll = () => {
    for (const k of ['fp-high', 'fp-medium', 'fp-low', 'fp-focus']) CSS.highlights.delete(k);
  };

  const highlight = (marks: Mark[]) => {
    ensureStyle();
    clearAll();
    const index = buildIndex();
    const groups: Record<Sev, Range[]> = { high: [], medium: [], low: [] };
    let found = 0;
    for (const m of marks) {
      const r = findRange(m.quote, index);
      if (r) {
        groups[m.severity].push(r);
        found++;
      }
    }
    for (const sev of ['high', 'medium', 'low'] as Sev[]) {
      if (groups[sev].length) CSS.highlights.set(`fp-${sev}`, new Highlight(...groups[sev]));
    }
    return found;
  };

  const focus = (quote: string) => {
    ensureStyle();
    const r = findRange(quote);
    if (!r) return false;
    CSS.highlights.set('fp-focus', new Highlight(r));
    const el = r.startContainer.parentElement;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => CSS.highlights.delete('fp-focus'), 2500);
    return true;
  };

  const extractText = (): { text: string; title: string; fromSelection: boolean } => {
    const sel = window.getSelection()?.toString() ?? '';
    if (sel.trim().length >= 200) return { text: sel, title: document.title, fromSelection: true };
    const main = document.querySelector('main, article, [role="main"]') as HTMLElement | null;
    const candidate = main && main.innerText.trim().length > 1500 ? main : document.body;
    return { text: candidate.innerText, title: document.title, fromSelection: false };
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'fp:getText':
        sendResponse(extractText());
        break;
      case 'fp:highlight':
        sendResponse({ found: highlight(msg.marks as Mark[]) });
        break;
      case 'fp:focus':
        sendResponse({ ok: focus(msg.quote as string) });
        break;
      case 'fp:clear':
        clearAll();
        sendResponse({ ok: true });
        break;
      case 'fp:ping':
        sendResponse({ ok: true });
        break;
    }
    return false;
  });
}

export {};
