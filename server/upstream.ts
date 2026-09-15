import { rawText } from '../shared/raw-message.js';
import WebSocket from 'ws';
import { BYTES_PER_SECOND, type ServerEvent } from '../shared/protocol.js';

export class Capacity {
  active = 0;
  constructor(readonly limit = 8) {}
  acquire() {
    if (this.active >= this.limit) return false;
    this.active++;
    return true;
  }
  release() {
    this.active = Math.max(0, this.active - 1);
  }
}
export interface UpstreamOptions {
  url: string;
  key: string;
  // SenseNova ASR 2609 requires app_id in production. The gateway in front of
  // the office node rejects unknown start fields, so it is only sent when set.
  appId?: string;
  // Explicit language name; omitted for automatic detection.
  language?: string;
  capacity: Capacity;
  emit: (event: ServerEvent) => void;
  // Set when a finished segment is recognised again from its saved WAV, so a
  // failed streaming segment is a recoverable warning instead of a dead end.
  recoverable?: boolean;
}
export class AsrSegment {
  samples = 0;
  readonly done: Promise<void>;
  private settle!: () => void;
  private ws: WebSocket | undefined;
  private ready = false;
  private ending = false;
  private closed = false;
  private acquired = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    readonly id: string,
    readonly startMs: number,
    private options: UpstreamOptions,
  ) {
    this.done = new Promise((resolve) => {
      this.settle = resolve;
    });
    options.emit({ type: 'segment', id, startMs });
    if (!options.capacity.acquire()) {
      this.fail('busy', '识别通道已满');
      return;
    }
    this.acquired = true;
    this.timer = setTimeout(
      () => this.fail('upstream_timeout', '连接识别服务超时'),
      12_000,
    );
    const ws = (this.ws = new WebSocket(options.url, {
      headers: { Authorization: 'Bearer ' + options.key },
      handshakeTimeout: 10_000,
      maxPayload: 1_000_000,
      perMessageDeflate: false,
    }));
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'start',
          ...(options.appId ? { app_id: options.appId } : {}),
          session_id: id,
          sample_rate: 16000,
          channels: 1,
          format: 'pcm_s16le',
          ...(options.language ? { language: options.language } : {}),
        }),
      );
    });
    ws.on('message', (bytes) => {
      if (this.closed) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(rawText(bytes));
      } catch {
        this.fail('upstream_protocol', '识别服务返回了无法解析的消息');
        return;
      }
      if (event.type === 'started') {
        clearTimeout(this.timer);
        this.ready = true;
        for (const chunk of this.pending) ws.send(chunk);
        this.pending = [];
        this.pendingBytes = 0;
        if (this.ending) this.sendEnd();
      } else if (event.type === 'partial' || event.type === 'final') {
        if (
          typeof event.text !== 'string' ||
          typeof event.language !== 'string'
        ) {
          this.fail('upstream_protocol', '识别服务的文字消息缺少必要字段');
          return;
        }
        options.emit({
          type: event.type,
          id,
          text: event.text,
          language: event.language,
          requestId:
            typeof event.request_id === 'string' ? event.request_id : undefined,
        });
        if (event.type === 'final') this.cleanup();
      } else if (event.type === 'error') {
        // Do not relay upstream internals or credentials to browser clients.
        this.fail(
          typeof event.code === 'string' ? event.code : 'upstream_error',
          '识别服务未能完成这段语音',
        );
      }
    });
    ws.on('error', () => this.fail('upstream_unavailable', '无法连接识别服务'));
    ws.on('close', () => {
      if (!this.closed) this.fail('upstream_closed', '识别连接提前断开');
    });
  }
  append(pcm: Buffer) {
    if (this.closed || this.ending) return;
    this.samples += pcm.length / 2;
    if (!this.ready) {
      this.pendingBytes += pcm.length;
      if (this.pendingBytes > BYTES_PER_SECOND * 10) {
        this.fail('backpressure', '识别连接等待过久');
        return;
      }
      this.pending.push(Buffer.from(pcm));
    } else if (this.ws?.readyState === WebSocket.OPEN) {
      if (this.ws.bufferedAmount > BYTES_PER_SECOND * 10) {
        this.fail('backpressure', '网络传输跟不上录音速度');
        return;
      }
      this.ws.send(pcm);
    }
  }
  end() {
    if (this.closed || this.ending) return;
    this.ending = true;
    if (this.ready) this.sendEnd();
  }
  private sendEnd() {
    this.ws?.send(JSON.stringify({ type: 'end' }));
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.fail('final_timeout', '等待最终识别结果超时'),
      30_000,
    );
  }
  cancel() {
    this.cleanup();
  }
  // One segment failing never stops the recording: the audio keeps being
  // captured and the saved WAV is recognised again once the segment closes.
  private fail(code: string, reason: string) {
    if (this.closed) return;
    this.options.emit({
      type: 'error',
      id: this.id,
      code,
      message:
        reason +
        (this.options.recoverable
          ? '，正在用整段音频重新识别，录音继续。'
          : '，这段文字可能不完整，录音继续。'),
      fatal: false,
    });
    this.cleanup();
  }
  private cleanup() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.pending = [];
    if (this.acquired) this.options.capacity.release();
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(1000);
    else if (this.ws?.readyState === WebSocket.CONNECTING) this.ws.terminate();
    this.settle();
  }
}
