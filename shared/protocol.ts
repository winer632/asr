export type { Language } from './languages.js';
export type ServerEvent =
  | { type: 'ready' | 'stopped' }
  | { type: 'vad'; speaking: boolean; probability: number }
  | { type: 'segment'; id: string; startMs: number }
  | {
      type: 'partial' | 'final';
      id: string;
      text: string;
      language: string;
      requestId?: string;
    }
  | {
      type: 'error';
      message: string;
      code: string;
      id?: string;
      fatal: boolean;
    };
export interface Transcript {
  id: string;
  startMs: number;
  text: string;
  language: string;
  final: boolean;
  error?: string;
}
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;
