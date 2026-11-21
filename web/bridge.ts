// Cloud bridge for the Chrome extension.
//
// Extension pages (chrome-extension://) cannot run reCAPTCHA, so they cannot get a Firebase
// App Check token on their own. The side panel embeds this page in a hidden iframe; it runs on
// the attested web origin, holds the App Check session, and performs cloud Gemini calls on
// behalf of the extension. Only the pinned extension origin may talk to it.

import { initFirebase } from '../src/core/firebase.ts';
import { deepAnalysis, scanDocument } from '../src/core/analyzer.ts';
import type { BridgeRequest, BridgeResponse } from '../src/core/bridge-protocol.ts';

const allowed = new Set(
  String(import.meta.env.VITE_EXTENSION_ORIGINS ?? '')
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean),
);

initFirebase();

window.addEventListener('message', async (event: MessageEvent<BridgeRequest>) => {
  if (!allowed.has(event.origin) || event.source !== window.parent) return;
  const req = event.data;
  if (!req || typeof req.id !== 'string') return;

  const reply = (msg: Omit<BridgeResponse, 'id' | 'channel'>) =>
    window.parent.postMessage({ channel: 'fineprint-bridge', id: req.id, ...msg } satisfies BridgeResponse, event.origin);

  try {
    switch (req.type) {
      case 'ping':
        reply({ ok: true, result: 'pong' });
        break;
      case 'scan': {
        const result = await scanDocument(req.payload.text, {
          mode: 'cloud',
          onProgress: (progress, partial) => reply({ progress, partial }),
        });
        reply({ ok: true, result });
        break;
      }
      case 'deep': {
        const result = await deepAnalysis(req.payload.text, req.payload.findings, req.payload.opts);
        reply({ ok: true, result });
        break;
      }
    }
  } catch (e) {
    reply({ ok: false, error: (e as Error)?.message ?? String(e) });
  }
});

// Tell the embedding side panel that the bridge is listening. No data is included.
window.parent.postMessage({ channel: 'fineprint-bridge', id: 'ready' }, '*');
