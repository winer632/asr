import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { AsrSegment, Capacity } from '../server/upstream.js';
import { rawText } from '../shared/raw-message.js';
import type { ServerEvent } from '../shared/protocol.js';

async function service(connect: (ws: WebSocket) => void) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', connect);
  return {
    url: 'ws://127.0.0.1:' + (server.address() as AddressInfo).port,
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

void test('startup backlog is paced, tail bytes are exact, and multiple VAD finals survive until end', async () => {
  const packets: { at: number; pcm: Buffer }[] = [];
  let readyAt = 0,
    ends = 0;
  const upstream = await service((ws) => {
    const send = (event: object) => ws.send(JSON.stringify(event));
    ws.on('message', (data, binary) => {
      if (binary) {
        packets.push({
          at: performance.now(),
          pcm: Buffer.from(data as Buffer),
        });
        if (packets.length === 1) {
          send({
            type: 'final',
            sequence: 1,
            text: '第一句。',
            language: 'Cantonese',
            start_audio_seconds: 0,
            audio_seconds: 0.1,
          });
          send({
            type: 'partial',
            sequence: 2,
            text: '暂定',
            language: 'Cantonese',
          });
          send({
            type: 'partial',
            sequence: 2,
            text: '重复包不应出现',
            language: 'Cantonese',
          });
        }
        return;
      }
      const event = JSON.parse(rawText(data));
      if (event.type === 'start')
        setTimeout(() => {
          readyAt = performance.now();
          send({ type: 'started', max_audio_seconds: 60 });
        }, 120);
      else if (event.type === 'end') {
        ends++;
        send({
          type: 'final',
          sequence: 2,
          text: '第二句。',
          language: 'Cantonese',
          start_audio_seconds: 0.1,
          audio_seconds: 0.2015625,
        });
        send({
          type: 'final',
          sequence: 2,
          text: '重复 final 不应出现',
          language: 'Cantonese',
        });
        send({ type: 'end' });
      }
    });
  });
  const events: ServerEvent[] = [],
    capacity = new Capacity();
  const segment = new AsrSegment('paced', 0, {
    url: upstream.url,
    key: 'test-only',
    capacity,
    emit: (e) => events.push(e),
  });
  const pcm = Buffer.alloc(6450, 7);
  try {
    segment.append(pcm);
    segment.end();
    segment.end();
    await segment.done;
    assert.equal(ends, 1);
    assert.deepEqual(
      packets.map((p) => p.pcm.length),
      [3200, 3200, 50],
    );
    assert.deepEqual(Buffer.concat(packets.map((p) => p.pcm)), pcm);
    assert.ok(packets[0].at - readyAt >= 90, 'startup pre-roll must not burst');
    assert.ok(
      packets[1].at - packets[0].at >= 90,
      'send rate must stay at real time',
    );
    assert.equal(events.filter((e) => e.type === 'final').length, 1);
    const final = events.at(-1);
    assert.equal(final?.type === 'final' && final.text, '第一句。\n第二句。');
    assert.ok(
      events.some((e) => e.type === 'partial' && e.text === '第一句。\n暂定'),
    );
    assert.equal(capacity.active, 0);
  } finally {
    segment.cancel();
    await upstream.close();
  }
});

for (const mode of ['normal', 'missing_final', 'abrupt'] as const) {
  void test('connection completion: ' + mode, async () => {
    const upstream = await service((ws) => {
      ws.on('message', (data, binary) => {
        if (binary) return;
        const event = JSON.parse(rawText(data));
        if (event.type === 'start')
          ws.send(JSON.stringify({ type: 'started' }));
        else if (event.type === 'end') {
          if (mode !== 'missing_final')
            ws.send(
              JSON.stringify({
                type: 'final',
                text: '保留文字',
                language: 'Chinese',
              }),
            );
          ws.close(mode === 'abrupt' ? 1011 : 1000);
        }
      });
    });
    const events: ServerEvent[] = [],
      capacity = new Capacity();
    const segment = new AsrSegment(mode, 0, {
      url: upstream.url,
      key: 'test-only',
      capacity,
      emit: (e) => events.push(e),
    });
    try {
      segment.append(Buffer.alloc(320));
      segment.end();
      await segment.done;
      assert.equal(capacity.active, 0);
      if (mode === 'normal') assert.equal(events.at(-1)?.type, 'final');
      else {
        assert.equal(events.filter((e) => e.type === 'final').length, 0);
        assert.equal(events.at(-1)?.type, 'error');
      }
    } finally {
      segment.cancel();
      await upstream.close();
    }
  });
}

void test('numeric rate-limit and app authorization errors retain their codes without leaking details', async () => {
  for (const code of [401, 201]) {
    const upstream = await service((ws) =>
      ws.on('message', () =>
        ws.send(JSON.stringify({ type: 'error', code, message: 'secret-key' })),
      ),
    );
    const events: ServerEvent[] = [],
      capacity = new Capacity();
    const segment = new AsrSegment('numeric', 0, {
      url: upstream.url,
      key: 'test-only',
      capacity,
      emit: (e) => events.push(e),
    });
    try {
      await segment.done;
      const error = events.find((e) => e.type === 'error');
      assert.equal(error?.code, String(code));
      assert.ok(!error?.message.includes('secret-key'));
      if (code === 201) assert.match(error!.message, /ASR_APP_ID/);
      assert.equal(capacity.active, 0);
    } finally {
      segment.cancel();
      await upstream.close();
    }
  }
});
