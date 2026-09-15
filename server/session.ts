import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AsrSegment, type UpstreamOptions } from './upstream.js';
import type { VadStream } from './vad/model.js';
import { SAMPLE_RATE, type ServerEvent } from '../shared/protocol.js';
import type { RecordingArchive } from './archive.js';
import { transcribeFile, type FileTranscriberOptions } from './transcribe.js';
import { pauseMark } from '../shared/text.js';

export interface SessionSettings {
  // Cut an utterance that keeps running at its next short pause, so one long
  // stretch of speech becomes several sentences instead of one wall of text.
  softSplitSeconds?: number;
  // Shortest silence accepted as a sentence break, in 10 ms VAD frames.
  softSplitPauseFrames?: number;
  // Close a segment with a mark derived from the pause the VAD measured when
  // the recogniser returned none. Never changes the recognised words.
  pausePunctuation?: boolean;
  // Recognise every finished segment once more from its saved WAV.
  file?: FileTranscriberOptions;
}
// One browser capture is continuous; each VAD utterance gets a separate ASR session.
export class RecordingSession {
  private position = 0;
  private preRoll = Buffer.alloc(0);
  private current: AsrSegment | undefined;
  private currentSamples = 0;
  private splitFrom: number | undefined;
  private splitId: string | undefined;
  private segments = new Set<AsrSegment>();
  private continued = new Map<string, boolean>();
  private passes = new Set<Promise<void>>();
  private abort = new AbortController();
  private stopping = false;
  private cancelled = false;
  private complete = false;
  constructor(
    private vad: VadStream,
    private options: UpstreamOptions,
    private maxSegmentSeconds = 55,
    private archive?: RecordingArchive,
    private settings: SessionSettings = {},
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
      this.currentSamples + pcm.length / 2 >
        this.maxSegmentSeconds * SAMPLE_RATE
    ) {
      this.endSegment(this.current, true);
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
        this.splitFrom = undefined;
        this.current = this.begin(event.sample);
      } else if (event.type === 'end') {
        this.splitFrom = undefined;
        this.splitId = undefined;
        if (this.current) {
          this.endSegment(this.current);
          this.current = undefined;
        }
      }
    }
    this.split();
    this.options.emit({
      type: 'vad',
      speaking: this.vad.decoder.speaking,
      probability: this.vad.decoder.probability,
    });
  }
  // Start a segment at `sample`, replaying the buffered audio from that point
  // so detection latency never clips the first syllable.
  private begin(sample: number) {
    const availableStart = this.position - this.preRoll.length / 2;
    const actualStart = Math.max(sample, availableStart);
    const segment = this.create(actualStart);
    this.appendSegment(
      segment,
      this.preRoll.subarray((actualStart - availableStart) * 2),
    );
    return segment;
  }
  private split() {
    const seconds = this.settings.softSplitSeconds ?? 0;
    const pause = this.settings.softSplitPauseFrames ?? 20;
    if (this.cancelled) return;
    if (
      seconds &&
      this.current &&
      this.currentSamples >= seconds * SAMPLE_RATE &&
      this.vad.decoder.pauseFrames >= pause
    ) {
      // The speaker is mid-pause. Close here and resume when sound returns;
      // until it does, this may still turn out to be the end of the sentence.
      this.splitId = this.current.id;
      this.endSegment(this.current);
      this.current = undefined;
      this.splitFrom = this.position;
      return;
    }
    if (
      this.splitFrom !== undefined &&
      !this.current &&
      this.vad.decoder.speaking &&
      !this.vad.decoder.pauseFrames
    ) {
      const from = this.splitFrom;
      this.splitFrom = undefined;
      // Speech carried on, so the cut was a pause inside one sentence.
      if (this.splitId) this.continued.set(this.splitId, true);
      this.splitId = undefined;
      this.current = this.begin(from);
    }
  }
  private create(sample: number) {
    const id = 'web-' + randomUUID(),
      startMs = (sample / SAMPLE_RATE) * 1000;
    this.archive?.startSegment(id, startMs);
    const segment = new AsrSegment(id, startMs, {
      ...this.options,
      recoverable: !!this.settings.file,
      emit: (event) => this.deliver(event),
    });
    this.segments.add(segment);
    this.currentSamples = 0;
    void segment.done.then(() => this.segments.delete(segment));
    return segment;
  }
  private deliver(event: ServerEvent) {
    const marked =
      event.type === 'final' && this.settings.pausePunctuation
        ? {
            ...event,
            mark: pauseMark(event.text, this.continued.get(event.id) ?? false),
          }
        : event;
    try {
      this.archive?.receive(marked);
      this.options.emit(marked);
    } catch {
      this.options.emit({
        type: 'error',
        id: 'id' in marked ? marked.id : undefined,
        code: 'storage_failed',
        message: '无法保存识别结果，请检查可用磁盘空间。',
        fatal: true,
      });
    }
  }
  private appendSegment(segment: AsrSegment, pcm: Buffer) {
    this.archive?.appendSegment(segment.id, pcm);
    this.currentSamples += pcm.length / 2;
    segment.append(pcm);
  }
  // `continued` marks a cut inside one utterance, where the speaker carried on.
  private endSegment(segment: AsrSegment, continued = false) {
    this.continued.set(segment.id, continued);
    this.archive?.closeSegment(segment.id);
    segment.end();
    this.recognizeFile(segment);
  }
  // Streaming decodes 2-second chunks and often returns no punctuation at all.
  // The finished WAV is recognised again with full context, which restores
  // punctuation and also recovers segments whose streaming session failed.
  private recognizeFile(segment: AsrSegment) {
    const file = this.settings.file,
      archive = this.archive;
    if (!file || !archive || this.cancelled) return;
    const saved = archive.metadata.segments.find((s) => s.id === segment.id);
    if (!saved) return;
    const filename = path.join(archive.directory, saved.audioFile);
    const pending = transcribeFile(file, filename, this.abort.signal);
    const pass = (async () => {
      const [result] = await Promise.all([pending, segment.done]);
      if (this.cancelled || !result) return;
      // Silence stays silent, and an empty answer never erases streaming text.
      if (!result.text.trim() && saved.text.trim()) return;
      this.deliver({
        type: 'final',
        id: segment.id,
        text: result.text,
        language: result.language || saved.language,
        requestId: result.requestId,
      });
    })()
      .catch(() => {})
      .finally(() => this.passes.delete(pass));
    this.passes.add(pass);
  }
  private async settle() {
    while (this.passes.size || this.segments.size) {
      await Promise.all([...this.segments].map((segment) => segment.done));
      await Promise.all(this.passes);
    }
  }
  async stop() {
    if (this.stopping || this.cancelled) return;
    this.stopping = true;
    this.splitFrom = undefined;
    this.splitId = undefined;
    if (this.current) this.endSegment(this.current);
    this.current = undefined;
    await this.settle();
    if (!this.cancelled) {
      this.archive?.finish('complete');
      this.complete = true;
      this.options.emit({ type: 'stopped' });
    }
  }
  cancel() {
    if (this.cancelled || this.complete) return;
    this.cancelled = true;
    this.abort.abort();
    for (const segment of this.segments) segment.cancel();
    this.segments.clear();
    this.passes.clear();
    this.preRoll = Buffer.alloc(0);
    this.archive?.finish('interrupted');
  }
}
