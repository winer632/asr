import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RecordingArchive,
  listRecordings,
  recoverRecordings,
  wavHeader,
} from '../server/archive.js';
void test('complete recording and numbered WAV/TXT pairs preserve the audio and final corrections', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'asr-archive-test-'));
  const archive = new RecordingArchive(root),
    pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
  archive.append(pcm);
  archive.startSegment('first', 0);
  archive.appendSegment('first', pcm);
  archive.receive({
    type: 'partial',
    id: 'first',
    language: 'Chinese',
    text: '今天天',
  });
  archive.receive({
    type: 'final',
    id: 'first',
    language: 'Chinese',
    text: '今天天气很好。',
  });
  archive.closeSegment('first');
  archive.finish('complete');
  archive.finish('interrupted');
  const manifest = listRecordings(root)[0],
    folder = archive.directory;
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.samples, 4);
  assert.deepEqual(
    readFileSync(path.join(folder, 'recording.wav')).subarray(44),
    pcm,
  );
  assert.deepEqual(
    readFileSync(path.join(folder, 'segments/001.wav')).subarray(44),
    pcm,
  );
  assert.equal(
    readFileSync(path.join(folder, 'segments/001.txt'), 'utf8'),
    '今天天气很好。\n',
  );
  assert.equal(
    readFileSync(path.join(folder, 'recording.wav')).readUInt32LE(40),
    pcm.length,
  );
  assert.equal(
    manifest.segments[0].audioFile.replace('.wav', '.txt'),
    manifest.segments[0].textFile,
  );
  assert.ok(
    readFileSync(path.join(folder, 'transcript.txt'), 'utf8').includes(
      'segments/001.wav ↔ segments/001.txt',
    ),
  );
  assert.equal(existsSync(path.join(folder, 'recording.wav.part')), false);
});
void test('server restart repairs a WAV file left by an interrupted recording', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'asr-recover-test-')),
    id = 'interrupted-test',
    directory = path.join(root, id);
  mkdirSync(directory);
  const pcm = Buffer.alloc(3200, 1);
  writeFileSync(
    path.join(directory, 'recording.wav.part'),
    Buffer.concat([wavHeader(0), pcm]),
  );
  writeFileSync(
    path.join(directory, 'manifest.json'),
    JSON.stringify({
      id,
      startedAt: new Date().toISOString(),
      status: 'recording',
      samples: 0,
      segments: [],
    }),
  );
  recoverRecordings(root);
  assert.equal(listRecordings(root)[0].status, 'interrupted');
  assert.equal(listRecordings(root)[0].samples, 1600);
  assert.equal(
    readFileSync(path.join(directory, 'recording.wav')).readUInt32LE(40),
    3200,
  );
});
