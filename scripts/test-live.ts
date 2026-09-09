import { rawText } from '../shared/raw-message.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, cpSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { readWav } from '../tests/wav.js';
import type { SavedRecording } from '../server/archive.js';
import type { ServerEvent } from '../shared/protocol.js';

try {
  process.loadEnvFile('.env');
} catch {
  /* CI can inject the key. */
}
if (!process.env.ASR_API_KEY)
  throw new Error('ASR_API_KEY is required for live ASR validation.');
const reservation = net.createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = (reservation.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const destination = mkdtempSync(path.join(tmpdir(), 'asr-live-validation-'));
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    RECORDINGS_DIR: destination,
    TLS_KEY_FILE: '',
    TLS_CERT_FILE: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (b) => {
  serverLog += b.toString();
});
server.stderr.on('data', (b) => {
  serverLog += b.toString();
});
const base = 'http://127.0.0.1:' + port;
const results: unknown[] = [];
async function downloadBytes(url: string): Promise<Buffer> {
  const response = await fetch(url);
  assert.equal(response.status, 200, 'Download failed: ' + url);
  const data: ArrayBuffer = await response.arrayBuffer();
  return Buffer.from(data);
}
async function run(name: string, pcm: Buffer, expectedLanguages: string[]) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/live', {
    origin: base,
  });
  const messages: { seconds: number; event: ServerEvent }[] = [],
    started = performance.now();
  const outcome = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        ws.terminate();
        reject(new Error(name + ': timed out'));
      },
      (pcm.length / 32000) * 1000 + 45000,
    );
    ws.on('open', () => ws.send(JSON.stringify({ type: 'start' })));
    ws.on('error', reject);
    ws.on('message', async (bytes) => {
      const event = JSON.parse(rawText(bytes)) as ServerEvent;
      if (event.type !== 'vad')
        messages.push({
          seconds: +(performance.now() - started).toFixed(1) / 1000,
          event,
        });
      if (event.type === 'ready') {
        try {
          const origin = performance.now();
          for (let offset = 0; offset < pcm.length; offset += 3200) {
            const frame = pcm.subarray(offset, offset + 3200);
            await delay(
              Math.max(
                0,
                origin + (offset + frame.length) / 32 - performance.now(),
              ),
            );
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(frame);
          }
          ws.send(JSON.stringify({ type: 'end' }));
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
          ws.close();
        }
      } else if (event.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(name + ': ' + event.message));
        ws.close();
      } else if (event.type === 'stopped') {
        clearTimeout(timeout);
        resolve();
        ws.close();
      }
    });
    ws.on('close', () => {
      if (!messages.some((m) => m.event.type === 'stopped')) {
        clearTimeout(timeout);
        reject(new Error(name + ': closed before stopped'));
      }
    });
  });
  await outcome;
  const finals = messages.flatMap((m) =>
    m.event.type === 'final' ? [m.event] : [],
  );
  assert.ok(finals.length > 0, name + ': no final text');
  assert.ok(
    messages.some((m) => m.event.type === 'partial'),
    name + ': no streaming output',
  );
  for (const language of expectedLanguages)
    assert.ok(
      finals.some((f) => f.language === language),
      name + ': missing ' + language,
    );
  const listing = (await fetch(base + '/api/recordings').then((r) =>
    r.json(),
  )) as { recordings: SavedRecording[] };
  const recording = listing.recordings.find((r) =>
    r.segments.some((s) => s.id === finals[0].id),
  )!;
  assert.ok(recording, name + ': saved recording missing');
  assert.equal(recording.status, 'complete');
  const fullAudio = await downloadBytes(
    base + '/api/recordings/' + recording.id + '/audio',
  );
  assert.deepEqual(
    fullAudio.subarray(44),
    pcm,
    name + ': full recording differs from input',
  );
  assert.equal(fullAudio.readUInt32LE(40), pcm.length);
  for (const segment of recording.segments) {
    const prefix =
      base +
      '/api/recordings/' +
      recording.id +
      '/segments/' +
      segment.sequence;
    const audio = await downloadBytes(prefix + '/audio');
    const text = await fetch(prefix + '/text').then((r) => r.text());
    assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
    assert.equal(audio.readUInt32LE(40), segment.samples * 2);
    assert.equal(text.trim(), segment.text.trim());
    assert.equal(segment.status, 'complete');
  }
  const result = {
    name,
    recordingId: recording.id,
    inputSeconds: pcm.length / 32000,
    finals,
    firstPartialSeconds: messages.find((m) => m.event.type === 'partial')
      ?.seconds,
    exactFullAudioMatch: true,
    savedPairs: recording.segments.length,
    messages,
  };
  results.push(result);
  console.log(
    JSON.stringify({
      name,
      finalLanguages: finals.map((f) => f.language),
      finalTexts: finals.map((f) => f.text),
      savedPairs: recording.segments.length,
      exactFullAudioMatch: true,
    }),
  );
}
try {
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw new Error(serverLog);
    try {
      if ((await fetch(base + '/api/status')).ok) break;
    } catch {
      /* startup */
    }
    await delay(200);
  }
  const names = ['mandarin_1', 'cantonese_1', 'english_1'];
  const languages = ['Chinese', 'Cantonese', 'English'];
  const silence = Buffer.alloc(32000);
  await Promise.all(
    names.map((name, i) =>
      run(
        name,
        Buffer.concat([
          silence,
          readWav('tests/fixtures/' + name + '.wav').pcm,
          silence,
        ]),
        [languages[i]],
      ),
    ),
  );
  const mixed = Buffer.concat([
    silence,
    ...['mandarin_2', 'cantonese_2', 'english_2'].flatMap((name) => [
      readWav('tests/fixtures/' + name + '.wav').pcm,
      Buffer.alloc(64000),
    ]),
  ]);
  await run('continuous_language_switch', mixed, [
    'Chinese',
    'Cantonese',
    'English',
  ]);
  mkdirSync('test-output', { recursive: true });
  cpSync(destination, 'test-output/recordings', { recursive: true });
  writeFileSync(
    'test-output/live-results.json',
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        recordingsDirectory: path.resolve('test-output/recordings'),
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    'Live validation passed; audio/text pairs saved in test-output/recordings',
  );
} finally {
  server.kill('SIGTERM');
  const forced = setTimeout(() => server.kill('SIGKILL'), 5000);
  await once(server, 'exit');
  clearTimeout(forced);
}
