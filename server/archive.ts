import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import type { ServerEvent } from '../shared/protocol.js';
import { languageLabel } from '../shared/languages.js';

export interface SavedSegment {
  id: string;
  sequence: number;
  startMs: number;
  endMs: number;
  samples: number;
  language: string;
  text: string;
  status: 'recognizing' | 'complete' | 'interrupted';
  error?: string;
  requestId?: string;
  audioFile: string;
  textFile: string;
}
export interface SavedRecording {
  id: string;
  startedAt: string;
  endedAt?: string;
  status: 'recording' | 'complete' | 'interrupted';
  samples: number;
  audioFile: string;
  textFile: string;
  segments: SavedSegment[];
}
export function wavHeader(bytes: number) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(bytes + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  return header;
}
export class WavWriter {
  samples = 0;
  private fd: number;
  private closed = false;
  constructor(readonly filename: string) {
    this.fd = openSync(filename + '.part', 'wx', 0o600);
    writeSync(this.fd, wavHeader(0));
  }
  append(pcm: Buffer) {
    if (this.closed) throw new Error('Audio file already closed');
    if (this.samples * 2 + pcm.length > 0xffffffff - 36)
      throw new Error('WAV file size limit reached');
    let offset = 0;
    while (offset < pcm.length)
      offset += writeSync(this.fd, pcm, offset, pcm.length - offset);
    this.samples += pcm.length / 2;
  }
  close() {
    if (this.closed) return;
    writeSync(this.fd, wavHeader(this.samples * 2), 0, 44, 0);
    closeSync(this.fd);
    this.closed = true;
    renameSync(this.filename + '.part', this.filename);
  }
}
const clock = (ms: number) =>
  Math.floor(ms / 60000)
    .toString()
    .padStart(2, '0') +
  ':' +
  ((ms / 1000) % 60).toFixed(2).padStart(5, '0');
export class RecordingArchive {
  readonly metadata: SavedRecording;
  readonly directory: string;
  private full: WavWriter;
  private writers = new Map<string, WavWriter>();
  private finished = false;
  constructor(root: string) {
    const startedAt = new Date().toISOString();
    const id = startedAt.replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
    this.directory = path.join(root, id);
    mkdirSync(path.join(this.directory, 'segments'), {
      recursive: true,
      mode: 0o700,
    });
    this.full = new WavWriter(path.join(this.directory, 'recording.wav'));
    this.metadata = {
      id,
      startedAt,
      status: 'recording',
      samples: 0,
      audioFile: 'recording.wav',
      textFile: 'transcript.txt',
      segments: [],
    };
    this.persist();
  }
  append(pcm: Buffer) {
    this.full.append(pcm);
    this.metadata.samples = this.full.samples;
  }
  startSegment(id: string, startMs: number) {
    const sequence = this.metadata.segments.length + 1,
      name = String(sequence).padStart(3, '0');
    const segment: SavedSegment = {
      id,
      sequence,
      startMs,
      endMs: startMs,
      samples: 0,
      language: '',
      text: '',
      status: 'recognizing',
      audioFile: 'segments/' + name + '.wav',
      textFile: 'segments/' + name + '.txt',
    };
    this.metadata.segments.push(segment);
    this.writers.set(
      id,
      new WavWriter(path.join(this.directory, segment.audioFile)),
    );
    this.writeText(segment);
    this.persist();
  }
  appendSegment(id: string, pcm: Buffer) {
    const writer = this.writers.get(id);
    if (!writer) return;
    writer.append(pcm);
    const segment = this.metadata.segments.find((s) => s.id === id)!;
    segment.samples = writer.samples;
    segment.endMs = segment.startMs + writer.samples / 16;
  }
  closeSegment(id: string) {
    const writer = this.writers.get(id);
    writer?.close();
    this.writers.delete(id);
    this.persist();
  }
  receive(event: ServerEvent) {
    if (this.finished || !('id' in event) || !event.id) return;
    const segment = this.metadata.segments.find((s) => s.id === event.id);
    if (!segment) return;
    if (event.type === 'partial' || event.type === 'final') {
      segment.text = event.text;
      segment.language = event.language;
      segment.requestId = event.requestId;
      segment.status = event.type === 'final' ? 'complete' : 'recognizing';
    } else if (event.type === 'error') {
      segment.error = event.message;
      segment.status = 'interrupted';
    } else return;
    this.writeText(segment);
    this.persist();
  }
  private writeText(segment: SavedSegment) {
    const prefix =
      segment.status === 'complete' ? '' : '【未完成识别，请核对音频】\n';
    this.atomic(
      segment.textFile,
      prefix + (segment.text || segment.error || '') + '\n',
    );
  }
  private atomic(file: string, data: string) {
    const target = path.join(this.directory, file);
    writeFileSync(target + '.tmp', data, { mode: 0o600 });
    renameSync(target + '.tmp', target);
  }
  private persist() {
    const lines = [
      '录音编号：' + this.metadata.id,
      '开始时间：' + this.metadata.startedAt,
      '状态：' + this.metadata.status,
      '完整音频：recording.wav',
      '',
    ];
    for (const s of this.metadata.segments)
      lines.push(
        '[' +
          clock(s.startMs) +
          ' – ' +
          clock(s.endMs) +
          '] ' +
          languageLabel(s.language) +
          ' · ' +
          (s.status === 'complete' ? '已完成' : '未完成'),
        '对应文件：' + s.audioFile + ' ↔ ' + s.textFile,
        s.text || s.error || '等待识别',
        '',
      );
    if (!this.metadata.segments.length)
      lines.push(this.finished ? '未检测到有效语音。' : '等待语音。');
    this.atomic('transcript.txt', lines.join('\n'));
    this.atomic('manifest.json', JSON.stringify(this.metadata, null, 2) + '\n');
  }
  finish(status: 'complete' | 'interrupted') {
    if (this.finished) return;
    for (const writer of this.writers.values()) writer.close();
    this.writers.clear();
    this.full.close();
    this.metadata.status = status;
    this.metadata.endedAt = new Date().toISOString();
    for (const segment of this.metadata.segments)
      if (segment.status !== 'complete') {
        segment.status = 'interrupted';
        this.writeText(segment);
      }
    this.finished = true;
    this.persist();
  }
}
export function listRecordings(root: string): SavedRecording[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((id) => /^[A-Za-z0-9_-]+$/.test(id))
    .sort()
    .reverse()
    .flatMap((id) => {
      try {
        return [
          JSON.parse(
            readFileSync(path.join(root, id, 'manifest.json'), 'utf8'),
          ) as SavedRecording,
        ];
      } catch {
        return [];
      }
    });
}
// Repair WAV headers after an interrupted server process; never delete recordings.
export function recoverRecordings(root: string) {
  for (const item of listRecordings(root)) {
    if (item.status !== 'recording') continue;
    const directory = path.join(root, item.id);
    for (const relative of [
      'recording.wav',
      ...item.segments.map((s) => s.audioFile),
    ]) {
      const unfinished = path.join(directory, relative + '.part');
      if (!existsSync(unfinished)) continue;
      const bytes = statSync(unfinished).size - 44;
      if (bytes < 0 || bytes % 2) continue;
      const fd = openSync(unfinished, 'r+');
      writeSync(fd, wavHeader(bytes), 0, 44, 0);
      closeSync(fd);
      renameSync(unfinished, path.join(directory, relative));
      if (relative === 'recording.wav') item.samples = bytes / 2;
      else {
        const segment = item.segments.find((s) => s.audioFile === relative);
        if (segment) {
          segment.samples = bytes / 2;
          segment.endMs = segment.startMs + segment.samples / 16;
        }
      }
    }
    item.status = 'interrupted';
    item.endedAt = new Date().toISOString();
    item.segments.forEach((s) => {
      if (s.status !== 'complete') s.status = 'interrupted';
    });
    writeFileSync(
      path.join(directory, 'manifest.json'),
      JSON.stringify(item, null, 2) + '\n',
      { mode: 0o600 },
    );
    const transcript = path.join(directory, 'transcript.txt');
    if (existsSync(transcript))
      writeFileSync(
        transcript,
        '【服务曾中断，录音文件已恢复；未完成文字请核对音频】\n' +
          readFileSync(transcript, 'utf8'),
        { mode: 0o600 },
      );
  }
}
