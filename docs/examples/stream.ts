import { rawText } from '../../shared/raw-message.js';
// Run: npx tsx docs/examples/stream.ts speech.pcm
// Convert first: ffmpeg -i speech.wav -ar 16000 -ac 1 -f s16le speech.pcm
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
try {
  process.loadEnvFile('.env');
} catch {
  /* Environment variables may be supplied by the shell. */
}
if (!process.env.ASR_API_KEY || !process.argv[2])
  throw new Error('Set ASR_API_KEY and provide a raw PCM filename.');
const pcm = readFileSync(process.argv[2]);
if (pcm.length % 2) throw new Error('PCM16 data length must be even.');
const url = new URL(
  '/infer/stream',
  process.env.ASR_BASE_URL || 'http://10.210.1.23:19003',
);
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
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
      session_id: 'example-' + randomUUID(),
      sample_rate: 16000,
      channels: 1,
      format: 'pcm_s16le',
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
        await delay(100);
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(pcm.subarray(offset, offset + 3200));
      }
      socket.send(JSON.stringify({ type: 'end' }));
    } catch (error) {
      console.error(String(error));
      process.exitCode = 1;
      socket.close();
    }
  } else if (event.type === 'partial' || event.type === 'final') {
    // Each text is a full hypothesis for this session. Replace, don't concatenate.
    console.log(
      JSON.stringify({
        type: event.type,
        language: event.language,
        text: event.text,
      }),
    );
    if (event.type === 'final') socket.close(1000);
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
socket.on('close', () => clearTimeout(deadline));
