import type { DeepReport, DeepScope, Finding, ScanProgress, ScanResult } from './types.ts';

export type BridgeRequest =
  | { id: string; type: 'ping' }
  | { id: string; type: 'scan'; payload: { text: string } }
  | {
      id: string;
      type: 'deep';
      payload: { text: string; findings: Finding[]; opts: { scope: DeepScope; redact: boolean } };
    };

export interface BridgeResponse {
  channel: 'fineprint-bridge';
  id: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
  progress?: ScanProgress;
  partial?: Finding[];
}

/** What the UI needs from "the cloud", whether it is called directly (web) or through the bridge (extension). */
export interface CloudAdapter {
  available(): Promise<boolean>;
  scan(text: string, onProgress: (p: ScanProgress, partial: Finding[]) => void): Promise<ScanResult>;
  deep(text: string, findings: Finding[], opts: { scope: DeepScope; redact: boolean }): Promise<DeepReport>;
}
