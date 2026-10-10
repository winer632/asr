import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BYTES_PER_SECOND } from '../shared/protocol.js';

export interface FileTranscript {
  text: string;
  language: string;
  requestId?: string;
}
export interface FileTranscriberOptions {
  url: string;
  key: string;
  appId?: string;
  language?: string;
  tradition?: boolean;
  // Both default to the segment's own length; see fileBudget below.
  timeoutMs?: number;
  attempts?: number;
}
// The hosted 2609 service decodes a whole segment in roughly half to three
// quarters of its audio duration, where the office gateway answered a
// 55-second segment in about a second. A fixed 10-second budget would drop
// the punctuation pass for every long segment on the hosted service, so the
// budget follows the segment length. Everything has to land inside the
// browser's stop window, so a segment large enough to need more than 20
// seconds is given one attempt rather than two.
export function fileBudget(audioSeconds: number) {
  const timeoutMs = Math.min(
    40_000,
    Math.max(10_000, Math.round(audioSeconds * 1000)),
  );
  return { timeoutMs, attempts: timeoutMs > 20_000 ? 1 : 2 };
}
// The streaming pass decodes 2-second chunks and frequently returns text with
// no punctuation at all. The same audio sent as a file is decoded with full
// context and comes back punctuated, so every finished segment is recognised
// once more from the WAV already on disk. Failures keep the streaming text.
export async function transcribeFile(
  options: FileTranscriberOptions,
  filename: string,
  signal?: AbortSignal,
): Promise<FileTranscript | undefined> {
  let audio: Buffer;
  try {
    audio = await readFile(filename);
  } catch {
    return undefined;
  }
  if (audio.length <= 44) return undefined;
  const budget = fileBudget((audio.length - 44) / BYTES_PER_SECOND);
  const attempts = options.attempts ?? budget.attempts;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) return undefined;
    if (attempt) await delay(400 * attempt, signal);
    if (signal?.aborted) return undefined;
    const body = new FormData();
    body.append(
      'audio',
      new Blob([new Uint8Array(audio)], { type: 'audio/wav' }),
      path.basename(filename),
    );
    if (options.appId) body.append('app_id', options.appId);
    if (options.language) body.append('language', options.language);
    body.append('tradition', String(options.tradition ?? false));
    try {
      const response = await fetch(options.url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + options.key },
        body,
        signal: AbortSignal.any([
          // Every attempt must still fit inside the browser's stop timeout.
          AbortSignal.timeout(options.timeoutMs ?? budget.timeoutMs),
          ...(signal ? [signal] : []),
        ]),
      });
      if (!response.ok) {
        // Rejections of this audio will not succeed on a retry.
        if (response.status >= 400 && response.status < 500) return undefined;
        continue;
      }
      const data = (await response.json()) as Record<string, unknown>;
      if (typeof data.text !== 'string') continue;
      return {
        text: data.text,
        language: typeof data.language === 'string' ? data.language : '',
        requestId:
          typeof data.request_id === 'string' ? data.request_id : undefined,
      };
    } catch {
      /* retried, then the streaming result stands */
    }
  }
  return undefined;
}
function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
