import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RecordingArchive } from '../server/archive.js';
import { deleteRecordings } from '../server/recordings.js';
import type { DeleteRecordingsResult } from '../shared/recordings.js';

function saved(root: string) {
  const archive = new RecordingArchive(root);
  const pcm = Buffer.alloc(3200);
  archive.append(pcm);
  archive.startSegment('speech', 0);
  archive.appendSegment('speech', pcm);
  archive.receive({
    type: 'final',
    id: 'speech',
    language: 'Chinese',
    text: '删除功能测试。',
  });
  archive.closeSegment('speech');
  archive.finish('complete');
  return archive;
}

void test('single and batch deletion remove complete WAV/TXT groups and leave unselected recordings intact', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'asr-delete-'));
  const first = saved(root),
    second = saved(root),
    third = saved(root),
    keep = saved(root);
  const original = readFileSync(path.join(keep.directory, 'manifest.json'));
  const single = await deleteRecordings(root, [first.metadata.id]);
  assert.deepEqual(single.deletedIds, [first.metadata.id]);
  assert.equal(existsSync(first.directory), false);
  const batch = await deleteRecordings(root, [
    second.metadata.id,
    third.metadata.id,
    second.metadata.id,
  ]);
  assert.deepEqual(batch.deletedIds, [second.metadata.id, third.metadata.id]);
  assert.equal(existsSync(second.directory), false);
  assert.equal(existsSync(third.directory), false);
  assert.deepEqual(
    readFileSync(path.join(keep.directory, 'manifest.json')),
    original,
  );
  assert.equal(existsSync(path.join(keep.directory, 'segments/001.wav')), true);
  assert.equal(existsSync(path.join(keep.directory, 'segments/001.txt')), true);
  const repeated = await deleteRecordings(root, [first.metadata.id]);
  assert.deepEqual(repeated.missingIds, [first.metadata.id]);
});

void test('deletion protects active recordings and refuses traversal before changing any files', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'asr-delete-active-'));
  const active = new RecordingArchive(root),
    completed = saved(root);
  try {
    await assert.rejects(
      deleteRecordings(root, [completed.metadata.id, '../outside']),
    );
    await assert.rejects(deleteRecordings(root, []));
    await assert.rejects(
      deleteRecordings(
        root,
        Array.from({ length: 51 }, () => completed.metadata.id),
      ),
    );
    assert.equal(existsSync(completed.directory), true);
    const result = await deleteRecordings(root, [
      active.metadata.id,
      completed.metadata.id,
    ]);
    assert.deepEqual(result.deletedIds, [completed.metadata.id]);
    assert.deepEqual(
      result.failed.map((f) => [f.id, f.code]),
      [[active.metadata.id, 'recording_active']],
    );
    assert.equal(
      existsSync(path.join(active.directory, 'recording.wav.part')),
      true,
    );
    active.append(Buffer.alloc(3200));
  } finally {
    active.finish('complete');
  }
});

void test('symlinks and malformed manifests cannot redirect deletion outside a recording', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'asr-delete-symlink-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'asr-delete-outside-'));
  const sentinel = path.join(outside, 'keep.txt');
  writeFileSync(sentinel, 'keep this file');
  symlinkSync(outside, path.join(root, 'external-link'), 'dir');
  mkdirSync(path.join(root, 'bad-manifest'));
  writeFileSync(
    path.join(root, 'bad-manifest/manifest.json'),
    JSON.stringify({ id: 'another-id', status: 'complete' }),
  );
  mkdirSync(path.join(root, 'manifest-link'));
  symlinkSync(sentinel, path.join(root, 'manifest-link/manifest.json'));
  const nested = saved(root);
  symlinkSync(outside, path.join(nested.directory, 'outside'), 'dir');
  const result = await deleteRecordings(root, [
    'external-link',
    'bad-manifest',
    'manifest-link',
    nested.metadata.id,
  ]);
  assert.deepEqual(result.deletedIds, [nested.metadata.id]);
  assert.equal(result.failed.length, 3);
  assert.ok(result.failed.every((f) => f.code === 'invalid_recording'));
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep this file');
  assert.equal(existsSync(path.join(root, 'bad-manifest/manifest.json')), true);
});

void test('HTTP deletion requires the configured browser origin and reports mixed batch outcomes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'asr-delete-api-'));
  const first = saved(root),
    second = saved(root),
    keep = saved(root);
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = 'https://asr.office.example:8443';
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'server/index.ts'],
    {
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        PUBLIC_ORIGIN: origin,
        ASR_BASE_URL: 'http://127.0.0.1:1',
        ASR_API_KEY: 'test-only',
        RECORDINGS_DIR: root,
        TLS_KEY_FILE: '',
        TLS_CERT_FILE: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  child.stderr.on('data', (b) => {
    log += b.toString();
  });
  const base = 'http://127.0.0.1:' + port;
  const request = (body: string, headers: Record<string, string> = {}) =>
    fetch(base + '/api/recordings', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
  let active: RecordingArchive | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Server startup timeout: ' + log)),
        10000,
      );
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('Server exited: ' + code + ' ' + log));
      });
      child.stdout.on('data', (b) => {
        if (b.toString().includes('ASR web ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    active = new RecordingArchive(root);
    const body = JSON.stringify({ ids: [first.metadata.id] });
    assert.equal((await request(body)).status, 403);
    assert.equal(
      (
        await request(body, {
          Origin: 'https://unrelated.example',
          'X-Forwarded-Host': 'unrelated.example',
        })
      ).status,
      403,
    );
    assert.equal(
      (await request(body, { Origin: origin, 'Content-Type': 'text/plain' }))
        .status,
      415,
    );
    assert.equal((await request('{invalid', { Origin: origin })).status, 400);
    assert.equal(
      (await request('x'.repeat(17000), { Origin: origin })).status,
      413,
    );
    assert.equal(
      (
        await request(
          JSON.stringify({ ids: [first.metadata.id, '../outside'] }),
          { Origin: origin },
        )
      ).status,
      400,
    );
    assert.equal(existsSync(first.directory), true);
    const response = await request(
      JSON.stringify({
        ids: [
          first.metadata.id,
          second.metadata.id,
          active.metadata.id,
          'already-removed',
        ],
      }),
      { Origin: origin },
    );
    assert.equal(response.status, 200);
    const result = (await response.json()) as DeleteRecordingsResult;
    assert.deepEqual(result.deletedIds, [
      first.metadata.id,
      second.metadata.id,
    ]);
    assert.deepEqual(result.missingIds, ['already-removed']);
    assert.equal(result.failed[0].code, 'recording_active');
    assert.equal(existsSync(first.directory), false);
    assert.equal(existsSync(second.directory), false);
    assert.equal(existsSync(keep.directory), true);
    assert.equal(
      (await fetch(base + '/api/recordings/' + first.metadata.id + '/audio'))
        .status,
      404,
    );
    const listing = (await fetch(base + '/api/recordings').then((r) =>
      r.json(),
    )) as { recordings: { id: string }[] };
    assert.deepEqual(
      new Set(listing.recordings.map((r) => r.id)),
      new Set([keep.metadata.id, active.metadata.id]),
    );
  } finally {
    active?.finish('complete');
    if (child.exitCode === null) {
      const done = once(child, 'exit');
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      await done;
      clearTimeout(force);
    }
  }
});
