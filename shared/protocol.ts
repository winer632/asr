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
      // Closing mark derived from the measured pause, never from the model.
      mark?: string;
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
  mark?: string;
  error?: string;
}
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;
