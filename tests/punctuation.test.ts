import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
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
import { pauseMark, sentenceLines } from '../shared/text.js';

// Stands in for POST /infer, which decodes the whole segment with full context.
async function fileService(text: string, language = 'Chinese') {
  const sizes: number[] = [];
  const server = http.createServer((req, res) => {
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
    });
    req.on('end', () => {
      sizes.push(size);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ request_id: 'file-test', language, text }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    sizes,
    url: 'http://127.0.0.1:' + port + '/infer',
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
// Stands in for the streaming gateway, which answers 2-second chunks.
async function streamService(finalText: string) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.on('listening', resolve));
  server.on('connection', (ws) => {
    ws.on('message', (data, binary) => {
      if (binary) return;
      const event = JSON.parse(rawText(data));
      if (event.type === 'start')
        ws.send(JSON.stringify({ type: 'started', chunk_seconds: 2 }));
      else if (event.type === 'end')
        ws.send(
          JSON.stringify({
            type: 'final',
            text: finalText,
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

void test('sentence helpers only break on punctuation the recogniser returned', () => {
  assert.deepEqual(sentenceLines('你好。今天开会，请提前到场。'), [
    '你好。',
    '今天开会，请提前到场。',
  ]);
  assert.deepEqual(sentenceLines('Hello. This is a test.'), [
    'Hello.',
    'This is a test.',
  ]);
  assert.deepEqual(sentenceLines('我净系示范旅客清关咁起码'), [
    '我净系示范旅客清关咁起码',
  ]);
  assert.deepEqual(sentenceLines('等一等', '。'), ['等一等。']);
  assert.deepEqual(sentenceLines(''), []);
  // The mark reflects the measured pause, and never doubles existing punctuation.
  assert.equal(pauseMark('确认没有问题', false), '。');
  assert.equal(pauseMark('确认没有问题', true), '，');
  assert.equal(pauseMark('确认没有问题。', false), '');
  assert.equal(pauseMark('nothing yet', false), '.');
  assert.equal(pauseMark('   ', false), '');
});

void test('the finished segment is recognised again so punctuation is restored', async () => {
  const stream = await streamService('我们先说一下今天的安排第一是旅客清关');
  const file = await fileService('我们先说一下今天的安排，第一是旅客清关。');
  const archive = new RecordingArchive(
    mkdtempSync(path.join(tmpdir(), 'asr-punctuation-test-')),
  );
  const events: ServerEvent[] = [];
  let calls = 0;
  const vad = {
    decoder: { speaking: true, probability: 0.99, pauseFrames: 0 },
    accept: async () => (++calls === 1 ? [{ type: 'start', sample: 0 }] : []),
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
    for (let n = 0; n < 4; n++) await session.accept(Buffer.alloc(3200, n));
    await session.stop();
    const finals = events.flatMap((event) =>
      event.type === 'final' ? [event] : [],
    );
    assert.equal(finals.length, 2);
    assert.equal(finals[0].text, '我们先说一下今天的安排第一是旅客清关');
    assert.equal(finals[1].text, '我们先说一下今天的安排，第一是旅客清关。');
    assert.equal(file.sizes.length, 1);
    const saved = archive.metadata.segments[0];
    assert.equal(saved.text, '我们先说一下今天的安排，第一是旅客清关。');
    assert.equal(saved.status, 'complete');
    assert.equal(
      readFileSync(path.join(archive.directory, saved.textFile), 'utf8'),
      '我们先说一下今天的安排，第一是旅客清关。\n',
    );
  } finally {
    session.cancel();
    await stream.close();
    await file.close();
  }
});

void test('a pause-derived mark closes a segment the recogniser left unpunctuated', async () => {
  const stream = await streamService('你哋大把云啦求其俾条link我');
  const file = await fileService('你哋大把云啦求其俾条link我', 'Cantonese');
  const archive = new RecordingArchive(
    mkdtempSync(path.join(tmpdir(), 'asr-mark-test-')),
  );
  const events: ServerEvent[] = [];
  let calls = 0;
  const vad = {
    decoder: { speaking: true, probability: 0.99, pauseFrames: 0 },
    accept: async () => (++calls === 1 ? [{ type: 'start', sample: 0 }] : []),
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
    for (let n = 0; n < 4; n++) await session.accept(Buffer.alloc(3200, n));
    await session.stop();
    const saved = archive.metadata.segments[0];
    // The words stay exactly as recognised; only the closing mark is added.
    assert.equal(saved.text, '你哋大把云啦求其俾条link我');
    assert.equal(saved.mark, '。');
    assert.equal(
      readFileSync(path.join(archive.directory, saved.textFile), 'utf8'),
      '你哋大把云啦求其俾条link我。\n',
    );
  } finally {
    session.cancel();
    await stream.close();
    await file.close();
  }
});

void test('long continuous speech is cut at a short pause without losing audio', async () => {
  const stream = await streamService('一段文字');
  const file = await fileService('一段文字');
  const archive = new RecordingArchive(
    mkdtempSync(path.join(tmpdir(), 'asr-split-test-')),
  );
  const decoder = { speaking: true, probability: 0.99, pauseFrames: 0 };
  let calls = 0;
  const vad = {
    decoder,
    accept: async () => (++calls === 1 ? [{ type: 'start', sample: 0 }] : []),
  } as unknown as VadStream;
  const session = new RecordingSession(
    vad,
    {
      url: stream.url,
      key: 'test-only',
      capacity: new Capacity(8),
      emit: () => {},
    },
    55,
    archive,
    {
      softSplitSeconds: 0.2,
      softSplitPauseFrames: 20,
      pausePunctuation: true,
      file: { url: file.url, key: 'test-only' },
    },
  );
  const all: Buffer[] = [];
  try {
    // 0.1 s per chunk: speech, a short pause past the limit, then speech again.
    for (let n = 0; n < 6; n++) {
      const pcm = Buffer.alloc(3200, n);
      all.push(pcm);
      decoder.pauseFrames = n === 3 ? 25 : n === 4 ? 25 : 0;
      await session.accept(pcm);
    }
    await session.stop();
    assert.equal(archive.metadata.segments.length, 2);
    assert.equal(archive.metadata.segments[0].mark, '，');
    assert.equal(archive.metadata.segments[1].mark, '。');
    // The two segments tile the utterance: no gap and no duplicated audio.
    assert.deepEqual(
      Buffer.concat(
        archive.metadata.segments.map((saved) =>
          readFileSync(path.join(archive.directory, saved.audioFile)).subarray(
            44,
          ),
        ),
      ),
      Buffer.concat(all),
    );
  } finally {
    session.cancel();
    await stream.close();
    await file.close();
  }
});
