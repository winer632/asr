import { rawText } from '../../shared/raw-message.js';
// Run: npx tsx docs/examples/stream.ts speech.pcm
// Convert first: ffmpeg -i speech.wav -ar 16000 -ac 1 -f s16le speech.pcm
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { resolveEndpoints } from '../../server/upstream.js';
try {
  process.loadEnvFile('.env');
} catch {
  /* Environment variables may be supplied by the shell. */
}
if (!process.env.ASR_API_KEY || !process.env.ASR_APP_ID || !process.argv[2])
  throw new Error(
    'Set ASR_API_KEY, ASR_APP_ID and provide a raw PCM filename.',
  );
const pcm = readFileSync(process.argv[2]);
if (pcm.length % 2) throw new Error('PCM16 data length must be even.');
const { streamUrl: url } = resolveEndpoints(
  new URL(
    process.env.ASR_BASE_URL ||
      'https://api-gai-volc.sensetime.com/agent-5o/signpost/v0/prod-agent-5o-sensenova-filabs-asr-v1',
  ),
);
let endSent = false,
  finals = 0;
const socket = new WebSocket(url, {
  headers: { Authorization: 'Bearer ' + process.env.ASR_API_KEY },
  handshakeTimeout: 10000,
});
const deadline = setTimeout(() => {
  socket.terminate();
  console.error('ASR request timed out.');
  process.exitCode = 1;
}, 90000);
socket.on('open', () =>
  socket.send(
    JSON.stringify({
      type: 'start',
      app_id: process.env.ASR_APP_ID,
      session_id: 'abg-example-' + randomUUID(),
      sample_rate: 16000,
      channels: 1,
      format: 'pcm_s16le',
      ...(process.env.ASR_LANGUAGE
        ? { language: process.env.ASR_LANGUAGE }
        : {}),
      server_vad: true,
      vad_interval: Number(process.env.ASR_VAD_INTERVAL_MS || 800),
      tradition: ['1', 'true'].includes(process.env.ASR_TRADITION || ''),
      gain: Number(process.env.ASR_GAIN || 1),
    }),
  ),
);
socket.on('message', async (bytes) => {
  const event = JSON.parse(rawText(bytes));
  if (event.type === 'started') {
    try {
      if (pcm.length / 32000 > event.max_audio_seconds)
        throw new Error('Audio exceeds the session limit.');
      for (let offset = 0; offset < pcm.length; offset += 3200) {
        const packet = pcm.subarray(offset, offset + 3200);
        await delay(Math.ceil(packet.length / 32));
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(packet);
      }
      endSent = true;
      socket.send(JSON.stringify({ type: 'end' }));
    } catch (error) {
      console.error(String(error));
      process.exitCode = 1;
      socket.close();
    }
  } else if (event.type === 'partial' || event.type === 'final') {
    // Replace partials within one VAD utterance; keep every final utterance.
    if (event.type === 'final') finals++;
    console.log(
      JSON.stringify({
        type: event.type,
        sequence: event.sequence,
        language: event.language,
        text: event.text,
        start_audio_seconds: event.start_audio_seconds,
        audio_seconds: event.audio_seconds,
      }),
    );
  } else if (event.type === 'end') {
    socket.close(1000);
  } else if (event.type === 'error') {
    console.error(JSON.stringify(event));
    process.exitCode = 1;
    socket.close();
  }
});
socket.on('error', () => {
  console.error('ASR connection failed. Check the URL, network and key.');
  process.exitCode = 1;
});
socket.on('close', (code) => {
  clearTimeout(deadline);
  if (!endSent || !finals || code !== 1000) {
    console.error('Stream ended without a complete final result.');
    process.exitCode = 1;
  }
});
