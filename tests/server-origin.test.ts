import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

async function startServer(publicOrigin: string) {
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
        PUBLIC_ORIGIN: publicOrigin,
        ASR_BASE_URL: 'http://127.0.0.1:1',
        ASR_API_KEY: 'test-only',
        TLS_KEY_FILE: '',
        TLS_CERT_FILE: '',
        RECORDINGS_DIR: mkdtempSync(path.join(tmpdir(), 'asr-origin-')),
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

function handshake(
  base: string,
  origin: string,
  headers = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/live', {
      origin,
      headers,
      handshakeTimeout: 3000,
    });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_request, response) => {
      const status = response.statusCode!;
      response.resume();
      ws.terminate();
      resolve(status);
    });
    ws.on('error', reject);
  });
}

void test('HTTPS office origin can use an HTTP backend without trusting forged forwarding headers', async () => {
  const server = await startServer('https://asr.office.example:8443');
  try {
    assert.equal(
      await handshake(server.base, 'https://asr.office.example:8443'),
      101,
    );
    assert.equal(
      await handshake(server.base, 'https://asr.office.example'),
      403,
    );
    assert.equal(
      await handshake(server.base, 'http://asr.office.example:8443'),
      403,
    );
    assert.equal(
      await handshake(server.base, 'https://unrelated.example', {
        'X-Forwarded-Host': 'unrelated.example',
        'X-Forwarded-Proto': 'https',
      }),
      403,
    );
  } finally {
    await server.stop();
  }
});

void test('direct HTTP deployment keeps its original same-origin WebSocket checks', async () => {
  const server = await startServer('');
  try {
    assert.equal(await handshake(server.base, server.base), 101);
    assert.equal(
      await handshake(server.base, 'https://unrelated.example'),
      403,
    );
  } finally {
    await server.stop();
  }
});
