import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync, createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { VadFactory } from './vad/model.js';
import { Capacity } from './upstream.js';
import { RecordingSession } from './session.js';
import type { ServerEvent } from '../shared/protocol.js';
import {
  RecordingArchive,
  listRecordings,
  recoverRecordings,
} from './archive.js';

const root = process.cwd();
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
function integer(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(name + ' is outside the supported range.');
  return value;
}
const port = integer('PORT', 5173, 1, 65535),
  host = process.env.HOST || '127.0.0.1';
const maxConnections = integer('MAX_CONNECTIONS', 8, 1, 32),
  maxAsr = integer('ASR_CONCURRENCY', 8, 1, 8);
const silenceMs = integer('VAD_SILENCE_MS', 600, 300, 2000);
const baseUrl = new URL(process.env.ASR_BASE_URL || 'http://10.210.1.23:19003');
if (
  !['http:', 'https:'].includes(baseUrl.protocol) ||
  baseUrl.username ||
  baseUrl.password
)
  throw new Error(
    'ASR_BASE_URL must be an HTTP(S) origin without credentials.',
  );
const streamUrl = new URL('/infer/stream', baseUrl);
streamUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
const key = process.env.ASR_API_KEY || '';
const capacity = new Capacity(maxAsr);
const recordingsRoot = path.resolve(
  root,
  process.env.RECORDINGS_DIR || 'recordings',
);
recoverRecordings(recordingsRoot);
const modelPath = path.resolve(
  root,
  process.env.VAD_MODEL_PATH || 'models/net.onnx',
);
const factory = await VadFactory.load(modelPath);
const dev = process.argv.includes('--dev');
const vite = dev
  ? await (
      await import('vite')
    ).createServer({ server: { middlewareMode: true }, appType: 'spa' })
  : undefined;
const tlsKey = process.env.TLS_KEY_FILE,
  tlsCert = process.env.TLS_CERT_FILE;
if (!!tlsKey !== !!tlsCert)
  throw new Error('Set both TLS_KEY_FILE and TLS_CERT_FILE.');
const publicOriginValue = process.env.PUBLIC_ORIGIN;
let publicOrigin: string | undefined;
if (publicOriginValue) {
  const parsed = new URL(publicOriginValue);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(
      'PUBLIC_ORIGIN must be an HTTP(S) origin without a path or credentials.',
    );
  publicOrigin = parsed.origin;
}
const listener: http.RequestListener = (req, res) => {
  void handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end('Internal server error');
  });
};
const server =
  tlsKey && tlsCert
    ? https.createServer(
        { key: readFileSync(tlsKey), cert: readFileSync(tlsCert) },
        listener,
      )
    : http.createServer(listener);
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};
async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self)');
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/api/recordings' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        recordings: listRecordings(recordingsRoot).slice(0, 50),
      }),
    );
    return;
  }
  const download = url.pathname.match(
    /^\/api\/recordings\/([A-Za-z0-9_-]+)\/(audio|text|manifest|segments\/([0-9]+)\/(audio|text))$/,
  );
  if (download && req.method === 'GET') {
    const [, id, kind, sequence, segmentKind] = download;
    let relative: string, basename: string;
    if (sequence) {
      const index = Number(sequence);
      if (!Number.isSafeInteger(index) || index < 1 || index > 100000) {
        res.writeHead(404);
        res.end();
        return;
      }
      const stem = String(index).padStart(3, '0');
      relative =
        'segments/' + stem + (segmentKind === 'audio' ? '.wav' : '.txt');
      basename = id + '_' + stem + path.extname(relative);
    } else {
      relative =
        kind === 'audio'
          ? 'recording.wav'
          : kind === 'text'
            ? 'transcript.txt'
            : 'manifest.json';
      basename =
        id +
        (kind === 'manifest'
          ? '_manifest.json'
          : kind === 'audio'
            ? '.wav'
            : '.txt');
    }
    const filename = path.join(recordingsRoot, id, relative);
    if (!existsSync(filename)) {
      res.writeHead(404);
      res.end('File not yet available');
      return;
    }
    res.writeHead(200, {
      'Content-Type': relative.endsWith('.wav')
        ? 'audio/wav'
        : relative.endsWith('.json')
          ? 'application/json; charset=utf-8'
          : 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + basename + '"',
      'Content-Length': statSync(filename).size,
      'Cache-Control': 'no-store',
    });
    createReadStream(filename).pipe(res);
    return;
  }
  if (url.pathname === '/api/status') {
    let upstream = false;
    try {
      const response = await fetch(new URL('/health', baseUrl), {
        signal: AbortSignal.timeout(3000),
      });
      const data = (await response.json()) as {
        status?: string;
        model_loaded?: boolean;
      };
      upstream =
        response.ok && data.status === 'ok' && data.model_loaded === true;
    } catch {
      /* reported as disconnected */
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        vadReady: true,
        configured: !!key,
        upstreamHealthy: upstream,
        activeAsrSessions: capacity.active,
        maxAsrSessions: maxAsr,
      }),
    );
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  if (vite) {
    vite.middlewares(req, res);
    return;
  }
  const publicRoot = path.join(root, 'dist/client');
  let requested: string;
  try {
    requested = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const relative =
    requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const filename = path.resolve(publicRoot, relative);
  if (
    !filename.startsWith(publicRoot + path.sep) ||
    !existsSync(filename) ||
    !statSync(filename).isFile()
  ) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': mime[path.extname(filename)] || 'application/octet-stream',
    'Cache-Control': relative.startsWith('assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  });
  createReadStream(filename).pipe(res);
}
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 6400,
  perMessageDeflate: false,
});
const connections = new Set<WebSocket>();
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url || '/', 'http://localhost').pathname !== '/api/live') {
    if (!vite) socket.destroy();
    return;
  }
  const expectedOrigin =
    publicOrigin || (tlsKey ? 'https://' : 'http://') + req.headers.host;
  if (req.headers.origin && req.headers.origin !== expectedOrigin) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  if (connections.size >= maxConnections) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});
wss.on('connection', (ws) => {
  connections.add(ws);
  let session: RecordingSession | undefined,
    queuedBytes = 0,
    closed = false,
    endQueued = false;
  let chain = Promise.resolve();
  let alive = true;
  const deadline = setTimeout(() => {
    if (!session) fail('start_timeout', '等待录音启动超时。');
  }, 10_000);
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 30_000);
  ws.on('pong', () => {
    alive = true;
  });
  function emit(event: ServerEvent) {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1_000_000) {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(event));
    if (event.type === 'error' && event.fatal) {
      endQueued = true;
      setImmediate(() => {
        try {
          session?.cancel();
        } catch {
          console.error(
            'Unable to finalize recording; recovery will run on next start.',
          );
        }
        ws.close(1011, 'Recognition failed');
      });
    }
  }
  function fail(code: string, message: string) {
    emit({ type: 'error', code, message, fatal: true });
  }
  ws.on('message', (data, isBinary) => {
    if (closed || endQueued) return;
    const bytes = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data as ArrayBuffer);
    if (isBinary) {
      if (!session) {
        fail('not_started', '请先启动录音会话。');
        return;
      }
      if (!bytes.length || bytes.length % 2 || bytes.length > 6400) {
        fail(
          'invalid_audio',
          '音频必须是 16 kHz 单声道 PCM，每帧不超过 200 毫秒。',
        );
        return;
      }
      queuedBytes += bytes.length;
      try {
        session.capture(bytes);
      } catch {
        fail('storage_failed', '录音保存失败，请检查磁盘空间与目录权限。');
        return;
      }
      if (queuedBytes > 320_000) {
        fail('backpressure', '录音处理队列已满，请重新开始。');
        return;
      }
      chain = chain
        .then(async () => {
          if (!closed) await session!.accept(bytes, true);
        })
        .catch(() =>
          fail(
            'processing_failed',
            '录音处理或保存失败，请检查模型和可用磁盘空间后重试。',
          ),
        )
        .finally(() => {
          queuedBytes -= bytes.length;
        });
      return;
    }
    let message: { type?: string };
    try {
      message = JSON.parse(bytes.toString());
      if (!message || Array.isArray(message)) throw new Error();
    } catch {
      fail('invalid_message', '录音控制消息格式错误。');
      return;
    }
    if (message.type === 'start' && !session) {
      clearTimeout(deadline);
      if (!key) {
        fail(
          'not_configured',
          '服务端尚未配置 ASR_API_KEY，请先完成本地服务配置。',
        );
        return;
      }
      try {
        session = new RecordingSession(
          factory.create(silenceMs),
          { url: streamUrl.toString(), key, capacity, emit },
          55,
          new RecordingArchive(recordingsRoot),
        );
      } catch {
        fail(
          'storage_unavailable',
          '无法创建录音文件，请检查录音目录的写入权限与磁盘空间。',
        );
        return;
      }
      emit({ type: 'ready' });
    } else if (message.type === 'end' && session) {
      endQueued = true;
      chain = chain
        .then(() => session!.stop())
        .catch(() => fail('stop_failed', '结束录音失败，请保留已收到的文字。'));
    } else fail('invalid_message', '不支持的录音控制消息。');
  });
  ws.on('error', () => {
    /* close handler releases resources */
  });
  ws.on('close', () => {
    closed = true;
    clearTimeout(deadline);
    clearInterval(heartbeat);
    connections.delete(ws);
    try {
      session?.cancel();
    } catch {
      console.error(
        'Unable to finalize recording; recovery will run on next start.',
      );
    }
  });
});
server.listen(port, host, () => {
  console.log('ASR web ready');
  console.log(
    '  Local: ' +
      (tlsKey ? 'https' : 'http') +
      '://' +
      (host === '0.0.0.0' ? 'localhost' : host) +
      ':' +
      port +
      '/',
  );
  if (!key)
    console.log('  Configure ASR_API_KEY in .env to enable recognition.');
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  for (const ws of connections) ws.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await vite?.close();
  await factory.release();
}
process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
