import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { readWav } from '../tests/wav.js';
import { rawText } from '../shared/raw-message.js';
import type { SavedRecording } from '../server/archive.js';
import type { ServerEvent } from '../shared/protocol.js';
try {
  process.loadEnvFile('.env');
} catch {
  /* shell configuration */
}
const duration = Number(process.env.ENDURANCE_SECONDS || 600);
assert.ok(duration >= 70 && duration <= 3600);
assert.ok(process.env.ASR_API_KEY, 'ASR_API_KEY is required');
const output = path.resolve(
  'test-output/endurance-' + new Date().toISOString().replace(/[:.]/g, '-'),
);
mkdirSync(output, { recursive: true });
const input = Buffer.alloc(duration * 32000);
const english = readWav('tests/fixtures/english_1.wav').pcm;
let left = 0,
  right = english.length - 2;
while (left < right && Math.abs(english.readInt16LE(left)) < 150) left += 2;
while (right > left && Math.abs(english.readInt16LE(right)) < 150) right -= 2;
const continuous = english.subarray(
  Math.max(0, left - 2560),
  Math.min(english.length, right + 2560),
);
let position = 0;
while (position < 70 * 32000) {
  const size = Math.min(continuous.length, 70 * 32000 - position);
  continuous.copy(input, position, 0, size);
  position += size;
}
position = Math.min(input.length, position + 64000);
const phrases = ['mandarin_2', 'cantonese_2', 'english_2'].map(
  (name) => readWav('tests/fixtures/' + name + '.wav').pcm,
);
for (let round = 0; position < input.length; round++) {
  const phrase = phrases[round % 3];
  const size = Math.min(phrase.length, input.length - position);
  phrase.copy(input, position, 0, size);
  position = Math.min(input.length, position + size + 64000);
}
const reservation = net.createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = (reservation.address() as net.AddressInfo).port;
await new Promise<void>((r) => reservation.close(() => r()));
const server = spawn(process.execPath, ['dist/server/server/index.js'], {
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    RECORDINGS_DIR: path.join(output, 'recordings'),
    TLS_KEY_FILE: '',
    TLS_CERT_FILE: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (bytes) => {
  serverLog += String(bytes);
});
server.stderr.on('data', (bytes) => {
  serverLog += String(bytes);
});
const base = 'http://127.0.0.1:' + port;
const events: ServerEvent[] = [],
  memory: { elapsed: number; rssMiB: number | null }[] = [];
function sampleMemory(elapsed: number) {
  let rssMiB: number | null = null;
  try {
    rssMiB =
      Number(
        execFileSync('ps', ['-o', 'rss=', '-p', String(server.pid)], {
          encoding: 'utf8',
        }).trim(),
      ) / 1024;
  } catch {
    /* not supported on every OS */
  }
  const entry = { elapsed, rssMiB };
  memory.push(entry);
  console.log(
    JSON.stringify({
      progress: 'endurance',
      ...entry,
      completedSegments: events.filter((e) => e.type === 'final').length,
    }),
  );
}
try {
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw new Error(serverLog);
    try {
      if ((await fetch(base + '/api/status')).ok) break;
    } catch {}
    await delay(200);
  }
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/live', {
    origin: base,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        ws.terminate();
        reject(new Error('Endurance deadline exceeded'));
      },
      duration * 1000 + 60000,
    );
    ws.on('open', () => ws.send(JSON.stringify({ type: 'start' })));
    ws.on('error', reject);
    ws.on('message', async (bytes) => {
      const event = JSON.parse(rawText(bytes)) as ServerEvent;
      if (event.type !== 'vad') events.push(event);
      if (event.type === 'ready') {
        try {
          const began = performance.now();
          sampleMemory(0);
          for (let offset = 0; offset < input.length; offset += 3200) {
            const frame = input.subarray(offset, offset + 3200);
            await delay(
              Math.max(
                0,
                began + (offset + frame.length) / 32 - performance.now(),
              ),
            );
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(frame);
            if ((offset + frame.length) % (60 * 32000) === 0)
              sampleMemory((offset + frame.length) / 32000);
          }
          ws.send(JSON.stringify({ type: 'end' }));
        } catch (error) {
          clearTimeout(timer);
          reject(error);
          ws.close();
        }
      } else if (event.type === 'error') {
        clearTimeout(timer);
        reject(new Error(event.message));
        ws.close();
      } else if (event.type === 'stopped') {
        clearTimeout(timer);
        resolve();
        ws.close();
      }
    });
    ws.on('close', () => {
      if (!events.some((e) => e.type === 'stopped')) {
        clearTimeout(timer);
        reject(new Error('Recording disconnected before completion'));
      }
    });
  });
  const listing = (await fetch(base + '/api/recordings').then((r) =>
    r.json(),
  )) as { recordings: SavedRecording[] };
  assert.equal(listing.recordings.length, 1);
  const recording = listing.recordings[0];
  assert.equal(recording.status, 'complete');
  assert.equal(recording.samples, duration * 16000);
  const response = await fetch(
    base + '/api/recordings/' + recording.id + '/audio',
  );
  const raw: ArrayBuffer = await response.arrayBuffer();
  const saved = Buffer.from(raw);
  assert.equal(saved.readUInt32LE(40), input.length);
  const inputHash = createHash('sha256').update(input).digest('hex'),
    savedHash = createHash('sha256').update(saved.subarray(44)).digest('hex');
  assert.equal(inputHash, savedHash);
  assert.ok(
    recording.segments.every(
      (s) => s.samples <= 55 * 16000 && s.status === 'complete',
    ),
  );
  const report = {
    testedAt: new Date().toISOString(),
    durationSeconds: duration,
    recordingId: recording.id,
    segments: recording.segments,
    events,
    memory,
    inputSha256: inputHash,
    savedPcmSha256: savedHash,
    exactAudioMatch: true,
    outputDirectory: output,
  };
  writeFileSync(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      result: 'passed',
      durationSeconds: duration,
      segments: recording.segments.length,
      exactAudioMatch: true,
      report: path.join(output, 'report.json'),
    }),
  );
} catch (error) {
  writeFileSync(
    path.join(output, 'failure.json'),
    JSON.stringify(
      { error: String(error), events, memory, serverLog },
      null,
      2,
    ),
  );
  throw error;
} finally {
  server.kill('SIGTERM');
  const force = setTimeout(() => server.kill('SIGKILL'), 5000);
  await once(server, 'exit');
  clearTimeout(force);
}
