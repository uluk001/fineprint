# Fine Print

**Read the terms before they read you.**

Fine Print is a Chrome extension and web app that reads insurance policies, loan agreements and subscription terms and flags the clauses that can cost you money, coverage or privacy: auto-renewals, cancellation fees, exclusions, deductibles, claim deadlines, arbitration, data sharing and more.

It is built on **Firebase AI Logic hybrid inference**:

- **On-device first.** Every document is scanned by **Gemini Nano** running locally in Chrome. Contracts are among the most private documents people read, so by default nothing leaves the device.
- **Cloud only with consent.** A *deep analysis* (verdict, top concerns, questions to ask before signing, what to negotiate) runs on **Gemini in the cloud**, only after the user opts in. By default only the flagged clauses are shared, and personal data (emails, phone, card, IBAN, policy numbers) is redacted first.
- **Graceful fallback.** If Gemini Nano is not available yet (still downloading, unsupported hardware), the same scan transparently falls back to the cloud model, and the UI says so.

Live demo: https://uluk001.github.io/fineprint/

---

## How it works

```
 page / pasted text
        │
        ▼
 chunker (fits Gemini Nano context) ──► Gemini Nano (PREFER_ON_DEVICE)
        │                                   │  structured JSON (responseConstraint)
        │                                   ▼
        │                      grounding check: every quote must exist in the source
        │                                   │  (drops hallucinated / paraphrased findings)
        ▼                                   ▼
 highlights in the page  ◄──────── deduped findings + risk score
        │
        └─ user opts in ─► redact PII ─► Gemini 3.5 Flash (ONLY_IN_CLOUD) ─► deep report
```

| Piece | Where |
|---|---|
| Hybrid scan model (`InferenceMode.PREFER_ON_DEVICE`, on-device `responseConstraint` + cloud `responseJsonSchema`) | `src/core/analyzer.ts` |
| Cloud-only deep analysis model (`InferenceMode.ONLY_IN_CLOUD`) | `src/core/analyzer.ts` |
| Which engine answered (`response.inferenceSource`) shown per finding | `src/ui/app.ts` |
| Gemini Nano download with progress (`initializeDeviceModel`) after a user gesture | `src/ui/app.ts` |
| Chunking, quote grounding, dedupe, risk score, PII redaction | `src/core/text.ts` (unit-tested) |
| Page highlighting with the CSS Custom Highlight API (no DOM mutation) | `extension/content.ts` |
| Side panel + context menu "Check selected terms" | `extension/` |
| Web demo with sample documents | `web/` |
| Cloud bridge for the extension (App Check without secrets) | `web/bridge.ts`, `extension/bridge-client.ts` |

### Firebase products

- **Firebase AI Logic**: hybrid on-device/cloud inference with the Gemini Developer API.
- **Firebase App Check**: reCAPTCHA Enterprise attestation. Extension pages (`chrome-extension://`) cannot run reCAPTCHA, so the side panel embeds a hidden **cloud bridge** page from the attested web origin (`web/bridge.ts`); it accepts `postMessage` requests only from the pinned extension ID and makes the cloud calls on its behalf. No secrets ship in the extension.
- **Firebase Remote Config**: the risk taxonomy, chunk size, fragment limit and cloud model names can be changed without shipping a new extension (`remoteconfig.template.json`).

## Try it

### Web demo
1. Open https://uluk001.github.io/fineprint/ in desktop Chrome 139+.
2. For on-device inference enable `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` and restart Chrome. Without it the demo still works using the cloud fallback.
3. Pick a sample (car insurance, personal loan, streaming subscription) or paste your own terms, then click **Scan for risky clauses**.
4. Click a finding to jump to it in the document. Run **Deep analysis** to get the cloud review.

### Chrome extension
1. Download the latest `fineprint-extension.zip` from Releases, unzip it.
2. Open `chrome://extensions`, enable Developer mode, click **Load unpacked** and select the folder.
3. Open any terms of service, policy wording or loan agreement page and click the Fine Print icon.
4. The side panel scans on-device with Gemini Nano. If Nano is not ready, or when you start a deep analysis, it uses Gemini in the cloud through the cloud bridge, with no setup.

## Build from source

```bash
npm install
npm test                 # unit tests for chunking, grounding, redaction, scoring
npm run build:extension  # -> dist/extension (load unpacked)
npm run build:web        # -> dist/web
npm run dev:web          # local dev server (App Check debug mode on localhost)
```

Firebase web config lives in `.env` (public identifiers). Private values such as `VITE_APPCHECK_DEBUG_TOKEN` go in `.env.local` (git-ignored).

## Privacy

- Document text is processed on-device unless the user starts a deep analysis or on-device AI is unavailable; the UI shows which engine handled every fragment.
- No accounts, no analytics, no server of our own. The extension stores only its settings.
- Fine Print highlights clauses worth a careful read. It is not legal or financial advice.

## License

Apache 2.0
