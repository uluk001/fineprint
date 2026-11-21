import '../src/ui/styles.css';
import { mountApp, type DocumentSource } from '../src/ui/app.ts';
import type { Finding } from '../src/core/types.ts';
import { CloudBridge } from './bridge-client.ts';

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab.');
  return tab;
}

/** Send a message to the page, injecting the content script first if the page predates the install. */
async function toPage<T>(msg: unknown): Promise<T> {
  const tab = await activeTab();
  if (!tab.url || /^(chrome|edge|about|chrome-extension):/.test(tab.url) || tab.url.startsWith('https://chromewebstore.google.com')) {
    throw new Error('Chrome does not let extensions read this page. Open the terms page you want to check.');
  }
  try {
    return await chrome.tabs.sendMessage(tab.id!, msg);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tab.id!, msg);
  }
}

const source: DocumentSource = {
  async describe() {
    const tab = await activeTab();
    const host = tab.url ? new URL(tab.url).hostname : '';
    return `${tab.title ?? 'This page'}${host ? ` · ${host}` : ''}`;
  },
  async getText() {
    const res = await toPage<{ text: string; fromSelection: boolean }>({ type: 'fp:getText' });
    return res?.text ?? '';
  },
  async highlight(findings: Finding[]) {
    await toPage({ type: 'fp:highlight', marks: findings.map((f) => ({ quote: f.quote, severity: f.severity })) }).catch(() => {});
  },
  async focus(f: Finding) {
    await toPage({ type: 'fp:focus', quote: f.quote }).catch(() => {});
  },
  async clear() {
    await toPage({ type: 'fp:clear' }).catch(() => {});
  },
};

const root = document.getElementById('app')!;
const bridgeUrl = import.meta.env.VITE_BRIDGE_URL as string | undefined;
const cloud = bridgeUrl ? new CloudBridge(bridgeUrl) : undefined;
mountApp({ root, source, cloud, scanMode: 'device' });

// Re-describe the document when the user switches tabs.
chrome.tabs.onActivated.addListener(() => {
  source.describe().then((d) => {
    const el = root.querySelector('.fp-card .fp-meta');
    if (el) el.textContent = d;
  });
});
