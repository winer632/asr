// Run with ASR_API_KEY / ASR_APP_ID. Requires retained FLEURS test audio in
// test-output/real-speech (scripts/prepare-real-audio.py prepares it).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { readWav } from '../tests/wav.js';
import { resolveEndpoints } from '../server/upstream.js';
import { transcribeFile } from '../server/transcribe.js';
import { rawText } from '../shared/raw-message.js';
import { VadFactory } from '../server/vad/model.js';

try {
  process.loadEnvFile('.env');
} catch {
  /* Shell can supply credentials. */
}
const key = process.env.ASR_API_KEY,
  appId = process.env.ASR_APP_ID;
if (!key || !appId) throw new Error('ASR_API_KEY and ASR_APP_ID are required.');
const { streamUrl, fileUrl } = resolveEndpoints(
  new URL(
    process.env.ASR_BASE_URL ||
      'https://api-gai-volc.sensetime.com/agent-5o/signpost/v0/prod-agent-5o-sensenova-filabs-asr-v1',
  ),
);
const root = 'test-output/real-speech/';
const clean = readWav(root + 'yue_hant_hk_clean.wav').pcm;
const repeat = Buffer.concat([
  Buffer.alloc(32000),
  clean,
  Buffer.alloc(48000),
  clean,
  Buffer.alloc(64000),
]);

async function stream(name: string, pcm: Buffer, interval: number) {
  const socket = new WebSocket(streamUrl, {
    headers: { Authorization: 'Bearer ' + key },
    handshakeTimeout: 10000,
  });
  const finals: {
    text: string;
    startSeconds?: number;
    endSeconds?: number;
    receivedSeconds: number;
  }[] = [];
  let endSent = false,
    readyAt = 0;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        socket.terminate();
        reject(new Error(name + ': timeout'));
      },
      pcm.length / 32 + 60000,
    );
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.terminate();
      reject(error);
    };
    socket.on('error', fail);
    socket.on('open', () =>
      socket.send(
        JSON.stringify({
          type: 'start',
          app_id: appId,
          session_id: 'abg-vad-' + randomUUID(),
          format: 'pcm_s16le',
          sample_rate: 16000,
          channels: 1,
          language: 'Cantonese',
          tradition: true,
          server_vad: true,
          vad_interval: interval,
          gain: 1,
        }),
      ),
    );
    socket.on('message', async (data) => {
      try {
        const event = JSON.parse(rawText(data));
        if (event.type === 'started') {
          readyAt = performance.now();
          for (let offset = 0; offset < pcm.length; offset += 3200) {
            const packet = pcm.subarray(offset, offset + 3200);
            await delay(Math.ceil(packet.length / 32));
            if (socket.readyState !== WebSocket.OPEN) return;
            socket.send(packet);
          }
          endSent = true;
          socket.send('{"type":"end"}');
        } else if (event.type === 'final')
          finals.push({
            text: event.text,
            startSeconds: event.start_audio_seconds,
            endSeconds: event.audio_seconds,
            receivedSeconds: +((performance.now() - readyAt) / 1000).toFixed(3),
          });
        else if (event.type === 'error')
          fail(new Error(name + ': upstream code ' + String(event.code)));
        else if (event.type === 'end') socket.close(1000);
      } catch (error) {
        fail(error as Error);
      }
    });
    socket.on('close', (code) => {
      clearTimeout(timer);
      if (endSent && code === 1000) resolve();
      else reject(new Error(name + ': closed prematurely (' + code + ')'));
    });
  });
  const result = {
    name,
    vadIntervalMs: interval,
    inputSeconds: pcm.length / 32000,
    speechFinals: finals.filter((f) => f.text.trim()).length,
    finals,
  };
  console.log(JSON.stringify(result));
  return result;
}

const [normal, fine, noisy, silence, noise, offline] = await Promise.all([
  stream('real_cantonese_repeated_800ms', repeat, 800),
  stream('real_cantonese_repeated_100ms', repeat, 100),
  stream(
    'real_cantonese_snr10',
    readWav(root + 'yue_hant_hk_snr10.wav').pcm,
    800,
  ),
  stream('pure_silence', Buffer.alloc(32000 * 5), 800),
  stream('pure_noise', readWav(root + 'noise_only.wav').pcm, 800),
  transcribeFile(
    {
      url: fileUrl.toString(),
      key,
      appId,
      language: 'Cantonese',
      tradition: true,
    },
    root + 'yue_hant_hk_clean.wav',
  ),
]);
const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .replace(/四十/g, '40')
    .replace(/[\p{P}\p{Z}\s]/gu, '');
assert.ok(offline?.text, 'offline reference recognition failed');
const normalText = normal.finals.map((f) => f.text).join('');
assert.equal(
  normalize(normalText),
  normalize(offline.text + offline.text),
  'default server VAD changed/lost words against the whole-file pass',
);
assert.ok(
  normal.speechFinals >= 2,
  'long silence must separate the two utterances',
);
assert.ok(
  fine.speechFinals >= normal.speechFinals,
  'shorter silence threshold should not coarsen the segmentation',
);
assert.equal(silence.speechFinals, 0, 'silence must not produce words');
assert.equal(
  noise.speechFinals,
  0,
  'this pure-noise sample must not produce words',
);
assert.match(
  noisy.finals.map((f) => f.text).join(''),
  /送往醫院後.*拒絕回去自己的牢房/s,
  '10 dB noisy sample lost the opening or closing phrase',
);
for (const final of normal.finals.filter((f) => f.text.trim())) {
  assert.ok(
    typeof final.startSeconds === 'number' &&
      typeof final.endSeconds === 'number',
  );
  assert.ok(final.startSeconds < final.endSeconds);
}

const factory = await VadFactory.load('models/net.onnx');
const local: object[] = [];
try {
  for (const [name, pcm] of [
    ['real_repeat', repeat],
    ['pure_silence', Buffer.alloc(32000 * 5)],
    ['pure_noise', readWav(root + 'noise_only.wav').pcm],
  ] as const) {
    const vad = factory.create(600),
      events = [];
    const padded = Buffer.concat([pcm, Buffer.alloc(64000)]);
    const samples = Int16Array.from({ length: padded.length / 2 }, (_, i) =>
      padded.readInt16LE(i * 2),
    );
    for (let offset = 0; offset < samples.length; offset += 1600)
      events.push(
        ...(await vad.accept(samples.subarray(offset, offset + 1600))),
      );
    local.push({
      name,
      segments: events.filter((e) => e.type === 'start').length,
      boundaries: events.map((e) => ({
        type: e.type,
        seconds: e.sample / 16000,
      })),
      ended: !vad.decoder.speaking,
    });
    if (name === 'pure_silence') assert.equal(events.length, 0);
  }
} finally {
  await factory.release();
}
writeFileSync(
  'tests/evidence/server-vad-0930.json',
  JSON.stringify(
    {
      testedAt: new Date().toISOString(),
      source: {
        dataset: 'google/fleurs',
        config: 'yue_hant_hk',
        split: 'validation',
        rowIndex: 0,
        id: 1514,
        license: 'CC-BY-4.0',
      },
      server: [normal, fine, noisy, silence, noise],
      offlineText: offline.text,
      repeatedDefaultStreamMatchesOffline: true,
      local,
      limitations:
        'One real Cantonese speaker, artificial Gaussian noise, no real meeting/background-noise or mobile microphone test. Local ONNX VAD can trigger on noise even when ASR returns no words.',
    },
    null,
    2,
  ) + '\n',
);
console.log(
  'Server VAD validation passed; evidence saved to tests/evidence/server-vad-0930.json',
);
