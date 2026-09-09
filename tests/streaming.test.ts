import { rawText } from '../shared/raw-message.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { RecordingSession } from '../server/session.js';
import { Capacity } from '../server/upstream.js';
import { RecordingArchive } from '../server/archive.js';
import type { VadStream } from '../server/vad/model.js';
import type { ServerEvent } from '../shared/protocol.js';

void test('disconnect preserves PCM already received while VAD inference is pending', async () => {
  const archive = new RecordingArchive(
    mkdtempSync(path.join(tmpdir(), 'asr-pending-test-')),
  );
  let finishInference!: (value: []) => void;
  const vad = {
    decoder: { speaking: false, probability: 0 },
    accept: () =>
      new Promise<[]>((resolve) => {
        finishInference = resolve;
      }),
  } as unknown as VadStream;
  const session = new RecordingSession(
    vad,
    {
      url: 'ws://127.0.0.1:1',
      key: 'test-only',
      capacity: new Capacity(),
      emit: () => {},
    },
    55,
    archive,
  );
  const first = Buffer.alloc(3200, 1),
    second = Buffer.alloc(3200, 2);
  session.capture(first);
  const pending = session.accept(first, true);
  session.capture(second);
  session.cancel();
  finishInference([]);
  await pending;
  assert.equal(archive.metadata.status, 'interrupted');
  assert.deepEqual(
    readFileSync(path.join(archive.directory, 'recording.wav')).subarray(44),
    Buffer.concat([first, second]),
  );
});

void test('long speech rotates without losing samples, waits for final, and saves matching pairs', async () => {
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => upstream.on('listening', resolve));
  const received: { id: string; pcm: Buffer }[] = [];
  upstream.on('connection', (ws) => {
    let id = '',
      chunks: Buffer[] = [];
    ws.on('message', (data, binary) => {
      if (binary) {
        chunks.push(Buffer.from(data as Buffer));
        return;
      }
      const event = JSON.parse(rawText(data));
      if (event.type === 'start') {
        id = event.session_id;
        ws.send(
          JSON.stringify({
            type: 'started',
            chunk_seconds: 2,
            max_audio_seconds: 60,
          }),
        );
      } else if (event.type === 'end') {
        received.push({ id, pcm: Buffer.concat(chunks) });
        chunks = [];
        ws.send(
          JSON.stringify({
            type: 'partial',
            text: '暂定',
            language: 'Chinese',
          }),
        );
        setTimeout(
          () =>
            ws.send(
              JSON.stringify({
                type: 'final',
                text: '最终文字',
                language: 'Chinese',
              }),
            ),
          received.length === 1 ? 30 : 5,
        );
      }
    });
  });
  const capacity = new Capacity(8),
    events: ServerEvent[] = [];
  const archive = new RecordingArchive(
    mkdtempSync(path.join(tmpdir(), 'asr-stream-test-')),
  );
  let calls = 0;
  const vad = {
    decoder: { speaking: true, probability: 0.99 },
    accept: async () => (++calls === 1 ? [{ type: 'start', sample: 0 }] : []),
  } as unknown as VadStream;
  const session = new RecordingSession(
    vad,
    {
      url: 'ws://127.0.0.1:' + (upstream.address() as AddressInfo).port,
      key: 'test-only',
      capacity,
      emit: (event) => events.push(event),
    },
    0.3,
    archive,
  );
  const all: Buffer[] = [];
  try {
    for (let n = 0; n < 8; n++) {
      const pcm = Buffer.alloc(3200, n);
      all.push(pcm);
      await session.accept(pcm);
    }
    await session.stop();
    assert.equal(events.at(-1)?.type, 'stopped');
    assert.equal(events.filter((e) => e.type === 'final').length, 3);
    assert.equal(capacity.active, 0);
    assert.deepEqual(
      Buffer.concat(
        archive.metadata.segments.map(
          (s) => received.find((r) => r.id === s.id)!.pcm,
        ),
      ),
      Buffer.concat(all),
    );
    assert.equal(archive.metadata.segments.length, 3);
    assert.equal(archive.metadata.status, 'complete');
    for (const saved of archive.metadata.segments) {
      assert.deepEqual(
        readFileSync(path.join(archive.directory, saved.audioFile)).subarray(
          44,
        ),
        received.find((r) => r.id === saved.id)!.pcm,
      );
      assert.equal(
        readFileSync(path.join(archive.directory, saved.textFile), 'utf8'),
        '最终文字\n',
      );
    }
    session.cancel();
    assert.equal(archive.metadata.status, 'complete');
  } finally {
    session.cancel();
    for (const client of upstream.clients) client.terminate();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
