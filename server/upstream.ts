import { rawText } from '../shared/raw-message.js';
import WebSocket from 'ws';
import { BYTES_PER_SECOND, type ServerEvent } from '../shared/protocol.js';

// The 2609 service is mounted under a path prefix
// (…/signpost/v0/prod-agent-5o-sensenova-filabs-asr-v1), so its routes are
// appended to the configured base instead of replacing the base's own path.
// A base quoted with /infer or /infer/stream already on it is accepted too,
// because the document writes the file endpoint both ways.
export function resolveEndpoints(base: URL) {
  const prefix = base.pathname.replace(/\/(infer(\/stream)?)?\/*$/, '');
  const at = (route: string) => new URL(prefix + route, base);
  const streamUrl = at('/infer/stream');
  streamUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return { fileUrl: at('/infer'), streamUrl, healthUrl: at('/health') };
}
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
  // An authorised app_id is required by the public 0930 service.
  appId?: string;
  // Explicit language name; omitted for automatic detection.
  language?: string;
  tradition?: boolean;
  serverVad?: boolean;
  vadInterval?: number;
  gain?: number;
  // Reports the per-session audio limit the service announces in `started`,
  // so segments are rotated before whatever bound this node is running with.
  onLimit?: (seconds: number) => void;
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
  private endSent = false;
  private closed = false;
  private acquired = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sendTimer: ReturnType<typeof setTimeout> | undefined;
  private nextSendAt = 0;
  private finalTexts: string[] = [];
  private finalCount = 0;
  private language = '';
  private requestId: string | undefined;
  private lastSequence = -1;
  private lastFinalSequence = -1;
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
          server_vad: options.serverVad ?? true,
          vad_interval: options.vadInterval ?? 800,
          tradition: options.tradition ?? false,
          gain: options.gain ?? 1,
        }),
      );
    });
    ws.on('message', (bytes) => {
      if (this.closed) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(rawText(bytes));
        if (!event || typeof event !== 'object' || Array.isArray(event))
          throw new Error('Invalid response');
      } catch {
        this.fail('upstream_protocol', '识别服务返回了无法解析的消息');
        return;
      }
      if (event.type === 'started') {
        if (this.ready) {
          this.fail('upstream_protocol', '识别服务重复确认启动');
          return;
        }
        clearTimeout(this.timer);
        this.ready = true;
        this.nextSendAt = performance.now();
        if (
          typeof event.max_audio_seconds === 'number' &&
          event.max_audio_seconds > 0
        )
          options.onLimit?.(event.max_audio_seconds);
        this.pump();
      } else if (event.type === 'partial' || event.type === 'final') {
        if (
          typeof event.text !== 'string' ||
          typeof event.language !== 'string'
        ) {
          this.fail('upstream_protocol', '识别服务的文字消息缺少必要字段');
          return;
        }
        if (typeof event.sequence === 'number') {
          // A final may reuse the preceding partial's decode sequence (the
          // public service does this when VAD trims trailing silence).
          const previous =
            event.type === 'final' ? this.lastFinalSequence : this.lastSequence;
          if (event.sequence <= previous) return;
          this.lastSequence = Math.max(this.lastSequence, event.sequence);
          if (event.type === 'final') this.lastFinalSequence = event.sequence;
        }
        this.language = event.language || this.language;
        if (typeof event.request_id === 'string')
          this.requestId = event.request_id;
        // 0930 finals belong to server-VAD utterances, not to the connection.
        // Partials replace only the current utterance; completed text survives.
        if (event.type === 'final') {
          this.finalCount++;
          if (event.text) this.finalTexts.push(event.text);
        }
        this.publish(
          'partial',
          [
            ...this.finalTexts,
            ...(event.type === 'partial' ? [event.text] : []),
          ]
            .filter(Boolean)
            .join('\n'),
        );
      } else if (event.type === 'end') {
        this.finish();
      } else if (event.type === 'error') {
        const code =
          typeof event.code === 'string' || typeof event.code === 'number'
            ? String(event.code)
            : 'upstream_error';
        // Do not relay upstream internals or credentials to browser clients.
        // A refused start is a configuration problem and will refuse every
        // following segment too, so it is named instead of read as a glitch.
        this.fail(
          code,
          ['106', '201', '202', 'unauthorized_app', 'invalid_start'].includes(
            code,
          )
            ? '识别服务拒绝了这次会话，请检查 ASR_APP_ID 与服务地址配置'
            : '识别服务未能完成这段语音',
        );
      }
    });
    ws.on('error', () => this.fail('upstream_unavailable', '无法连接识别服务'));
    ws.on('close', (code) => {
      if (this.closed) return;
      if (code === 1000 && this.endSent) this.finish();
      else this.fail('upstream_closed', '识别连接提前断开');
    });
  }
  append(pcm: Buffer) {
    if (this.closed || this.ending) return;
    this.samples += pcm.length / 2;
    this.pendingBytes += pcm.length;
    if (this.pendingBytes > BYTES_PER_SECOND * 10) {
      this.fail('backpressure', '识别音频等待过久');
      return;
    }
    // Bound packets to 100 ms, including buffered pre-roll and delayed startup.
    for (let offset = 0; offset < pcm.length; offset += 3200)
      this.pending.push(Buffer.from(pcm.subarray(offset, offset + 3200)));
    this.pump();
  }
  end() {
    if (this.closed || this.ending) return;
    this.ending = true;
    this.pump();
  }
  private pump() {
    if (this.closed || !this.ready || this.sendTimer || this.endSent) return;
    const packet = this.pending[0];
    if (!packet) {
      if (this.ending) this.sendEnd();
      return;
    }
    // A packet becomes available at its end. Never burst the startup backlog
    // or catch up faster than real time after a delayed timer (error 401).
    const due =
      Math.max(this.nextSendAt, performance.now()) +
      (packet.length / BYTES_PER_SECOND) * 1000;
    this.sendTimer = setTimeout(
      () => {
        this.sendTimer = undefined;
        if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return;
        if (this.ws.bufferedAmount > BYTES_PER_SECOND * 10) {
          this.fail('backpressure', '网络传输跟不上录音速度');
          return;
        }
        this.pending.shift();
        this.pendingBytes -= packet.length;
        this.ws.send(packet);
        this.nextSendAt = performance.now();
        this.pump();
      },
      Math.ceil(due - performance.now()),
    );
  }
  private sendEnd() {
    if (this.endSent) return;
    this.endSent = true;
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
  private publish(type: 'partial' | 'final', text: string) {
    this.options.emit({
      type,
      id: this.id,
      text,
      language: this.language,
      requestId: this.requestId,
    });
  }
  private finish() {
    if (!this.endSent || !this.finalCount) {
      this.fail('upstream_incomplete', '识别连接结束但未收到完整最终结果');
      return;
    }
    this.publish('final', this.finalTexts.join('\n'));
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
    clearTimeout(this.sendTimer);
    this.pending = [];
    this.pendingBytes = 0;
    if (this.acquired) this.options.capacity.release();
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(1000);
    else if (this.ws?.readyState === WebSocket.CONNECTING) this.ws.terminate();
    this.settle();
  }
}
