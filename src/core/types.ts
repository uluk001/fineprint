export type Severity = 'high' | 'medium' | 'low';
export type Source = 'on_device' | 'in_cloud';

export interface Category {
  id: string;
  label: string;
  hint: string;
}

export interface Finding {
  id: string;
  quote: string;
  category: string;
  severity: Severity;
  explanation: string;
  chunkIndex: number;
  source: Source;
}

export interface ScanProgress {
  done: number;
  total: number;
  onDevice: number;
  inCloud: number;
}

export interface ScanResult {
  findings: Finding[];
  chunks: number;
  analyzedChars: number;
  truncated: boolean;
  onDeviceChunks: number;
  cloudChunks: number;
  droppedUngrounded: number;
  ms: number;
}

export interface DeepConcern {
  title: string;
  why: string;
  quote: string;
}

export interface DeepReport {
  riskLevel: 'low' | 'medium' | 'high';
  summary: string;
  topConcerns: DeepConcern[];
  questionsToAsk: string[];
  missingProtections: string[];
  negotiationTips: string[];
  source: Source;
  sentChars: number;
  redactions: number;
  ms: number;
}

export type DeepScope = 'flagged' | 'full';
