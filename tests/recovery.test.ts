import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { rawText } from '../shared/raw-message.js';
import { RecordingSession } from '../server/session.js';
import { Capacity } from '../server/upstream.js';
import { RecordingArchive } from '../server/archive.js';
import type { VadStream } from '../server/vad/model.js';
import type { ServerEvent } from '../shared/protocol.js';
import type { VadBoundary } from '../server/vad/decoder.js';

// The first streaming session drops like a flaky upstream; the next works.
async function flakyStream() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.on('listening', resolve));
  let connections = 0;
  server.on('connection', (ws) => {
    const first = ++connections === 1;
    ws.on('message', (data, binary) => {
      if (binary) return;
      const event = JSON.parse(rawText(data));
      if (event.type === 'start') {
        if (first) {
          ws.close(1011, 'upstream gone');
          return;
        }
        ws.send(JSON.stringify({ type: 'started', chunk_seconds: 2 }));
      } else if (event.type === 'end')
        ws.send(
          JSON.stringify({
            type: 'final',
            text: '第二段流式文字',
            language: 'Chinese',
          }),
        );
    });
  });
  return {
    url: 'ws://127.0.0.1:' + (server.address() as AddressInfo).port,
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function fileService(text: string) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ request_id: 'r', language: 'Chinese', text: text }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url:
      'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/infer',
    get calls() {
      return calls;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

void test('a failed segment warns without stopping the recording and is recovered from its WAV', async () => {
  const stream = await flakyStream();
  const file = await fileService('第一段整段识别文字。');
  const archive = new RecordingArchive(
    mkdtempSync(path.join(tmpdir(), 'asr-recovery-test-')),
  );
  const events: ServerEvent[] = [];
  const script: Record<number, VadBoundary[]> = {
    1: [{ type: 'start', sample: 0 }],
    4: [{ type: 'end', sample: 6400 }],
    5: [{ type: 'start', sample: 8000 }],
  };
  let calls = 0;
  const vad = {
    decoder: { speaking: true, probability: 0.99, pauseFrames: 0 },
    accept: async () => script[++calls] || [],
  } as unknown as VadStream;
  const session = new RecordingSession(
    vad,
    {
      url: stream.url,
      key: 'test-only',
      capacity: new Capacity(8),
      emit: (event) => events.push(event),
    },
    55,
    archive,
    { pausePunctuation: true, file: { url: file.url, key: 'test-only' } },
  );
  try {
    for (let n = 0; n < 8; n++) await session.accept(Buffer.alloc(3200, n));
    await session.stop();
    const errors = events.filter((event) => event.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'upstream_closed');
    // The whole capture must survive one segment's recognition failure.
    assert.equal(errors[0].fatal, false);
    assert.equal(events.at(-1)?.type, 'stopped');
    assert.equal(archive.metadata.status, 'complete');
    assert.equal(archive.metadata.segments.length, 2);
    const [first, second] = archive.metadata.segments;
    assert.equal(first.text, '第一段整段识别文字。');
    assert.equal(first.status, 'complete');
    assert.equal(first.error, undefined);
    assert.equal(second.text, '第一段整段识别文字。');
    assert.equal(file.calls, 2);
  } finally {
    session.cancel();
    await stream.close();
    await file.close();
  }
});
