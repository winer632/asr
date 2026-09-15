import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { rawText } from '../shared/raw-message.js';
import type { ServerEvent } from '../shared/protocol.js';

async function startServer() {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'server/index.ts'],
    {
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        PUBLIC_ORIGIN: '',
        // No recognition happens in this test; only the start message is checked.
        ASR_BASE_URL: 'http://127.0.0.1:1',
        ASR_API_KEY: 'test-only',
        ASR_APP_ID: '',
        TLS_KEY_FILE: '',
        TLS_CERT_FILE: '',
        RECORDINGS_DIR: mkdtempSync(path.join(tmpdir(), 'asr-language-')),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let logs = '';
  child.stderr.on('data', (data) => {
    logs += data.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Server startup timed out: ' + logs));
    }, 10000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Server exited: ' + code + ' ' + logs));
    });
    child.stdout.on('data', (data) => {
      if (data.toString().includes('ASR web ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return {
    base: 'http://127.0.0.1:' + port,
    async stop() {
      if (child.exitCode !== null) return;
      const done = once(child, 'exit');
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      await done;
      clearTimeout(force);
    },
  };
}
// Sends one start message and reports the first reply.
function begin(base: string, start: Record<string, unknown>) {
  return new Promise<ServerEvent>((resolve, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/live', {
      origin: base,
      handshakeTimeout: 3000,
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('no reply to start'));
    }, 8000);
    ws.on('open', () => ws.send(JSON.stringify(start)));
    ws.on('message', (data) => {
      clearTimeout(timer);
      ws.close();
      resolve(JSON.parse(rawText(data)) as ServerEvent);
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

void test('the browser can lock a declared language and nothing else', async () => {
  const server = await startServer();
  try {
    assert.equal((await begin(server.base, { type: 'start' })).type, 'ready');
    assert.equal(
      (await begin(server.base, { type: 'start', language: '' })).type,
      'ready',
    );
    for (const language of ['Cantonese', 'yue', ' japanese ', 'Arabic'])
      assert.equal(
        (await begin(server.base, { type: 'start', language })).type,
        'ready',
        language + ' should be accepted',
      );
    // Languages the service only detects automatically cannot be locked, and
    // the refusal happens here rather than one segment at a time upstream.
    for (const language of ['German', 'auto', 'Klingon', 42]) {
      const event = await begin(server.base, { type: 'start', language });
      assert.equal(event.type, 'error', String(language));
      assert.equal(event.type === 'error' && event.code, 'invalid_language');
      assert.equal(event.type === 'error' && event.fatal, true);
    }
  } finally {
    await server.stop();
  }
});
