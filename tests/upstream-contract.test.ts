import test from 'node:test';
import assert from 'node:assert/strict';
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
import { LANGUAGES, findLanguage } from '../shared/languages.js';

// Collects the start message so the wire format can be asserted.
async function startCollector() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const starts: Record<string, unknown>[] = [];
  server.on('connection', (ws) => {
    ws.on('message', (data, binary) => {
      if (binary) return;
      const event = JSON.parse(rawText(data)) as Record<string, unknown>;
      if (event.type === 'start') {
        starts.push(event);
        ws.send(JSON.stringify({ type: 'started', chunk_seconds: 2 }));
      } else if (event.type === 'end')
        ws.send(
          JSON.stringify({ type: 'final', text: '文字', language: 'Chinese' }),
        );
    });
  });
  return {
    starts,
    url: 'ws://127.0.0.1:' + (server.address() as AddressInfo).port,
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function recordOnce(appId?: string) {
  const upstream = await startCollector();
  const archive = new RecordingArchive(
    mkdtempSync(path.join(tmpdir(), 'asr-start-test-')),
  );
  let calls = 0;
  const vad = {
    decoder: { speaking: true, probability: 0.99, pauseFrames: 0 },
    accept: async () => (++calls === 1 ? [{ type: 'start', sample: 0 }] : []),
  } as unknown as VadStream;
  const session = new RecordingSession(
    vad,
    {
      url: upstream.url,
      key: 'test-only',
      appId,
      capacity: new Capacity(8),
      emit: () => {},
    },
    55,
    archive,
  );
  try {
    for (let n = 0; n < 3; n++) await session.accept(Buffer.alloc(3200, n));
    await session.stop();
    return upstream.starts;
  } finally {
    session.cancel();
    await upstream.close();
  }
}

void test('the declared languages match the service and resolve by name, code and label', () => {
  // SenseNova ASR 2609 accepts these six for explicit selection, by full name
  // or short code; everything else returns invalid_language.
  const declared = LANGUAGES.filter((language) => language.declared);
  assert.deepEqual(
    declared.map((language) => language.code),
    ['Chinese', 'Cantonese', 'English', 'Japanese', 'Korean', 'Arabic'],
  );
  assert.deepEqual(
    declared.map((language) => language.locale),
    ['zh', 'yue', 'en', 'ja', 'ko', 'ar'],
  );
  for (const language of LANGUAGES) {
    assert.equal(findLanguage(language.code), language);
    assert.equal(findLanguage(language.locale), language);
    assert.equal(findLanguage(language.label), language);
    assert.equal(
      findLanguage(' ' + language.code.toUpperCase() + ' '),
      language,
    );
  }
  assert.equal(findLanguage('Klingon'), undefined);
});

void test('app_id is sent only once configured, because the gateway rejects unknown start fields', async () => {
  const withoutId = await recordOnce();
  assert.equal(withoutId.length, 1);
  assert.deepEqual(Object.keys(withoutId[0]).sort(), [
    'channels',
    'format',
    'sample_rate',
    'session_id',
    'type',
  ]);
  const withId = await recordOnce('office-app');
  assert.equal(withId[0].app_id, 'office-app');
});
