import { randomUUID } from 'node:crypto';
import { AsrSegment, type UpstreamOptions } from './upstream.js';
import type { VadStream } from './vad/model.js';
import { SAMPLE_RATE } from '../shared/protocol.js';
import type { RecordingArchive } from './archive.js';

// One browser capture is continuous; each VAD utterance gets a separate ASR session.
export class RecordingSession {
  private position = 0;
  private preRoll = Buffer.alloc(0);
  private current: AsrSegment | undefined;
  private segments = new Set<AsrSegment>();
  private stopping = false;
  private cancelled = false;
  private complete = false;
  constructor(
    private vad: VadStream,
    private options: UpstreamOptions,
    private maxSegmentSeconds = 55,
    private archive?: RecordingArchive,
  ) {}
  capture(pcm: Buffer) {
    if (!this.cancelled && !this.stopping) this.archive?.append(pcm);
  }
  async accept(pcm: Buffer, alreadyCaptured = false) {
    if (this.stopping || this.cancelled) return;
    if (!pcm.length || pcm.length % 2 || pcm.length > 6400)
      throw new Error('Audio frames must contain 1–3200 int16 samples.');
    if (!alreadyCaptured) this.capture(pcm);
    const chunkStart = this.position;
    this.position += pcm.length / 2;
    this.preRoll = Buffer.concat([this.preRoll, pcm]);
    if (this.preRoll.length > SAMPLE_RATE * 2 * 2)
      this.preRoll = this.preRoll.subarray(
        this.preRoll.length - SAMPLE_RATE * 2 * 2,
      );
    // Rotate BEFORE the upstream's declared 60-second limit; no duplicated overlap.
    if (
      this.current &&
      this.current.samples + pcm.length / 2 >
        this.maxSegmentSeconds * SAMPLE_RATE
    ) {
      this.endSegment(this.current);
      this.current = this.create(chunkStart);
    }
    const previouslyActive = this.current;
    if (previouslyActive) this.appendSegment(previouslyActive, pcm);
    const samples = new Int16Array(pcm.length / 2);
    for (let i = 0; i < samples.length; i++)
      samples[i] = pcm.readInt16LE(i * 2);
    const events = await this.vad.accept(samples);
    if (this.cancelled) return;
    for (const event of events) {
      if (event.type === 'start' && !this.current) {
        const availableStart = this.position - this.preRoll.length / 2;
        const actualStart = Math.max(event.sample, availableStart);
        this.current = this.create(actualStart);
        this.appendSegment(
          this.current,
          this.preRoll.subarray((actualStart - availableStart) * 2),
        );
      } else if (event.type === 'end' && this.current) {
        this.endSegment(this.current);
        this.current = undefined;
      }
    }
    this.options.emit({
      type: 'vad',
      speaking: this.vad.decoder.speaking,
      probability: this.vad.decoder.probability,
    });
  }
  private create(sample: number) {
    const id = 'web-' + randomUUID(),
      startMs = (sample / SAMPLE_RATE) * 1000;
    this.archive?.startSegment(id, startMs);
    const segment = new AsrSegment(id, startMs, {
      ...this.options,
      emit: (event) => {
        try {
          this.archive?.receive(event);
          this.options.emit(event);
        } catch {
          this.options.emit({
            type: 'error',
            id,
            code: 'storage_failed',
            message: '无法保存识别结果，请检查可用磁盘空间。',
            fatal: true,
          });
        }
      },
    });
    this.segments.add(segment);
    void segment.done.then(() => this.segments.delete(segment));
    return segment;
  }
  private appendSegment(segment: AsrSegment, pcm: Buffer) {
    this.archive?.appendSegment(segment.id, pcm);
    segment.append(pcm);
  }
  private endSegment(segment: AsrSegment) {
    this.archive?.closeSegment(segment.id);
    segment.end();
  }
  async stop() {
    if (this.stopping || this.cancelled) return;
    this.stopping = true;
    if (this.current) this.endSegment(this.current);
    this.current = undefined;
    await Promise.all([...this.segments].map((segment) => segment.done));
    if (!this.cancelled) {
      this.archive?.finish('complete');
      this.complete = true;
      this.options.emit({ type: 'stopped' });
    }
  }
  cancel() {
    if (this.cancelled || this.complete) return;
    this.cancelled = true;
    for (const segment of this.segments) segment.cancel();
    this.segments.clear();
    this.preRoll = Buffer.alloc(0);
    this.archive?.finish('interrupted');
  }
}
