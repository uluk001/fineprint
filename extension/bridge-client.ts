import type { BridgeRequest, BridgeResponse, CloudAdapter } from '../src/core/bridge-protocol.ts';
import type { DeepReport, Finding, ScanProgress, ScanResult } from '../src/core/types.ts';

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: ScanProgress, partial: Finding[]) => void;
};

/** Talks to the hidden cloud-bridge iframe hosted on the attested web origin. */
export class CloudBridge implements CloudAdapter {
  private iframe: HTMLIFrameElement;
  private origin: string;
  private pending = new Map<string, Pending>();
  private ready: Promise<boolean>;
  private seq = 0;

  constructor(url: string) {
    this.origin = new URL(url).origin;
    this.iframe = document.createElement('iframe');
    this.iframe.src = url;
    this.iframe.title = 'Fine Print cloud bridge';
    this.iframe.setAttribute('aria-hidden', 'true');
    this.iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';

    let markReady: (ok: boolean) => void = () => {};
    this.ready = new Promise<boolean>((r) => (markReady = r));
    const timer = setTimeout(() => markReady(false), 15000);

    window.addEventListener('message', (e: MessageEvent<BridgeResponse>) => {
      if (e.origin !== this.origin || e.source !== this.iframe.contentWindow) return;
      const msg = e.data;
      if (msg?.channel !== 'fineprint-bridge') return;
      if (msg.id === 'ready') {
        clearTimeout(timer);
        markReady(true);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.progress) {
        p.onProgress?.(msg.progress, msg.partial ?? []);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'Cloud request failed'));
    });

    document.body.append(this.iframe);
  }

  available(): Promise<boolean> {
    return this.ready;
  }

  private async call<T>(req: WithoutId<BridgeRequest>, onProgress?: Pending['onProgress']): Promise<T> {
    if (!(await this.ready)) throw new Error('Cloud features are unreachable right now. On-device scanning still works.');
    const id = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.iframe.contentWindow!.postMessage({ ...req, id }, this.origin);
    });
  }

  scan(text: string, onProgress: (p: ScanProgress, partial: Finding[]) => void): Promise<ScanResult> {
    return this.call<ScanResult>({ type: 'scan', payload: { text } }, onProgress);
  }

  deep(text: string, findings: Finding[], opts: { scope: 'flagged' | 'full'; redact: boolean }): Promise<DeepReport> {
    return this.call<DeepReport>({ type: 'deep', payload: { text, findings, opts } });
  }
}
