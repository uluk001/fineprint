import { initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider, CustomProvider, type AppCheck } from 'firebase/app-check';
import { getAI, GoogleAIBackend, type AI } from 'firebase/ai';
import { getRemoteConfig, fetchAndActivate, getValue, type RemoteConfig } from 'firebase/remote-config';
import { DEFAULT_CATEGORIES, parseCategories } from './categories.ts';
import type { Category } from './types.ts';

declare const __TARGET__: 'extension' | 'web';

const env = import.meta.env;

export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

export interface AppSettings {
  categories: Category[];
  chunkChars: number;
  maxChunks: number;
  deepModel: string;
  scanCloudModel: string;
}

const DEFAULTS: AppSettings = {
  categories: DEFAULT_CATEGORIES,
  chunkChars: 2800,
  maxChunks: 14,
  deepModel: 'gemini-3.5-flash',
  scanCloudModel: 'gemini-3.5-flash-lite',
};

let app: FirebaseApp | null = null;
let ai: AI | null = null;
let appCheck: AppCheck | null = null;
let remoteConfig: RemoteConfig | null = null;
let settingsPromise: Promise<AppSettings> | null = null;

/**
 * App Check protects the Gemini cloud endpoint.
 * - Web demo: reCAPTCHA Enterprise attestation on the hosted domain.
 * - Extension: chrome-extension:// pages cannot run reCAPTCHA, so the extension uses an
 *   App Check debug token supplied at build time (VITE_APPCHECK_DEBUG_TOKEN) or pasted by the
 *   user in Settings. Without a token the extension still works fully on-device.
 */
export function initFirebase(opts: { debugToken?: string } = {}): { app: FirebaseApp; ai: AI } {
  if (app && ai) return { app, ai };
  app = initializeApp(firebaseConfig);

  const debugToken = opts.debugToken || env.VITE_APPCHECK_DEBUG_TOKEN;
  const siteKey = env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY;
  const isLocalhost = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  if (__TARGET__ === 'extension' || isLocalhost || !siteKey) {
    if (debugToken) {
      (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken;
    } else if (isLocalhost) {
      (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    }
  }
  const useRecaptcha = __TARGET__ === 'web' && !!siteKey && !isLocalhost;
  if (useRecaptcha || debugToken || isLocalhost) {
    appCheck = initializeAppCheck(app, {
      // In debug mode the SDK exchanges the debug token itself; the custom provider is never
      // asked for a token. It exists so no remote reCAPTCHA script is injected into the
      // extension (MV3 forbids remote code).
      provider: useRecaptcha
        ? new ReCaptchaEnterpriseProvider(siteKey)
        : new CustomProvider({ getToken: () => Promise.reject(new Error('No attestation provider')) }),
      isTokenAutoRefreshEnabled: true,
    });
  }

  ai = getAI(app, { backend: new GoogleAIBackend() });
  return { app, ai };
}

export function hasCloudAccess(): boolean {
  return appCheck !== null;
}

/** Remote Config lets us tune the taxonomy, chunk size and models without a new release. */
export function loadSettings(): Promise<AppSettings> {
  if (settingsPromise) return settingsPromise;
  settingsPromise = (async () => {
    try {
      if (!app) initFirebase();
      remoteConfig = getRemoteConfig(app!);
      remoteConfig.settings.minimumFetchIntervalMillis = 60 * 60 * 1000;
      remoteConfig.defaultConfig = {
        risk_categories: JSON.stringify(DEFAULTS.categories),
        chunk_chars: DEFAULTS.chunkChars,
        max_chunks: DEFAULTS.maxChunks,
        deep_model: DEFAULTS.deepModel,
        scan_cloud_model: DEFAULTS.scanCloudModel,
      };
      await Promise.race([fetchAndActivate(remoteConfig), new Promise((r) => setTimeout(r, 2500))]);
      return {
        categories: parseCategories(getValue(remoteConfig, 'risk_categories').asString()),
        chunkChars: getValue(remoteConfig, 'chunk_chars').asNumber() || DEFAULTS.chunkChars,
        maxChunks: getValue(remoteConfig, 'max_chunks').asNumber() || DEFAULTS.maxChunks,
        deepModel: getValue(remoteConfig, 'deep_model').asString() || DEFAULTS.deepModel,
        scanCloudModel: getValue(remoteConfig, 'scan_cloud_model').asString() || DEFAULTS.scanCloudModel,
      };
    } catch (e) {
      console.warn('[FinePrint] Remote Config unavailable, using defaults', e);
      return DEFAULTS;
    }
  })();
  return settingsPromise;
}
