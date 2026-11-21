import '../src/ui/styles.css';
import { mountApp, type DocumentSource } from '../src/ui/app.ts';
import type { Finding } from '../src/core/types.ts';

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

async function getDebugToken(): Promise<string | undefined> {
  const { appCheckDebugToken } = await chrome.storage.local.get('appCheckDebugToken');
  return (appCheckDebugToken as string | undefined) || undefined;
}

function mountSettings(root: HTMLElement) {
  const header = root.querySelector('.fp-header');
  if (!header) return;
  const gear = document.createElement('button');
  gear.className = 'fp-icon-btn';
  gear.title = 'Settings';
  gear.textContent = '⚙';
  header.append(gear);

  const panel = document.createElement('div');
  panel.className = 'fp-card fp-settings hidden';
  panel.innerHTML = `
    <h3>Settings</h3>
    <div class="fp-note">Cloud features (fallback and deep analysis) are protected by Firebase App Check.
    Paste the App Check debug token from the testing instructions to enable them. On-device scanning works without it.</div>
    <input type="text" placeholder="App Check debug token" style="margin:8px 0" />
    <div class="fp-row"><button class="fp-btn">Save and reload</button></div>`;
  const input = panel.querySelector('input')!;
  getDebugToken().then((t) => (input.value = t ?? ''));
  panel.querySelector('button')!.addEventListener('click', async () => {
    await chrome.storage.local.set({ appCheckDebugToken: input.value.trim() });
    location.reload();
  });
  gear.addEventListener('click', () => panel.classList.toggle('hidden'));
  root.querySelector('.fp-main')?.prepend(panel);
}

const root = document.getElementById('app')!;
mountApp({ root, source, getDebugToken }).then(() => mountSettings(root));

// Re-describe the document when the user switches tabs.
chrome.tabs.onActivated.addListener(() => {
  source.describe().then((d) => {
    const el = root.querySelector('.fp-card .fp-meta');
    if (el) el.textContent = d;
  });
});
