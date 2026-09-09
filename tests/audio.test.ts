import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Fbank } from '../server/vad/fbank.js';
import { PcmResampler } from '../lib/audio/resampler.js';
import { readWav } from './wav.js';

void test('TypeScript fbank matches the original C++ frontend', () => {
  const { samples } = readWav('tests/fixtures/english_1.wav');
  const actual = new Fbank()
    .accept(samples.subarray(0, 16000))
    .flatMap((frame) => Array.from(frame));
  const golden = readFileSync('tests/fixtures/fbank-reference.f32');
  assert.equal(actual.length * 4, golden.length);
  const maximum = Math.max(
    ...actual.map((value, i) => Math.abs(value - golden.readFloatLE(i * 4))),
  );
  assert.ok(maximum < 0.0001, 'C++ feature difference: ' + maximum);
});
void test('fbank retains overlapping frames at arbitrary packet boundaries', () => {
  const { samples } = readWav('tests/fixtures/mandarin_1.wav');
  const whole = new Fbank()
    .accept(samples)
    .flatMap((frame) => Array.from(frame));
  const fragmented = new Fbank(),
    frames: number[] = [];
  for (let p = 0; p < samples.length; p += 113)
    frames.push(
      ...fragmented
        .accept(samples.subarray(p, p + 113))
        .flatMap((frame) => Array.from(frame)),
    );
  assert.deepEqual(frames, whole);
});
for (const rate of [16000, 44100, 48000])
  void test(
    'resampling ' + rate + ' Hz preserves time and packet continuity',
    () => {
      const input = Float32Array.from(
        { length: rate },
        (_, i) => 0.6 * Math.sin((2 * Math.PI * 1000 * i) / rate),
      );
      const resampler = new PcmResampler(rate),
        output: number[] = [];
      for (let i = 0; i < input.length; i += 128)
        output.push(...resampler.push(input.subarray(i, i + 128)));
      output.push(...resampler.push(new Float32Array(0), true));
      assert.equal(output.length, 16000);
      const expected = [...new PcmResampler(rate).push(input, true)];
      assert.equal(expected.length, output.length);
      assert.ok(
        Math.max(...output.map((n, i) => Math.abs(n - expected[i]))) < 0.0004,
      );
      const rms = Math.sqrt(
        output.slice(100, -100).reduce((n, v) => n + v * v, 0) /
          (output.length - 200),
      );
      assert.ok(rms > 0.4 && rms < 0.44);
    },
  );
void test('resampler suppresses high-frequency aliasing', () => {
  const input = Float32Array.from({ length: 48000 }, (_, i) =>
    Math.sin((2 * Math.PI * 12000 * i) / 48000),
  );
  const output = new PcmResampler(48000).push(input, true).slice(100, -100);
  const rms = Math.sqrt(
    output.reduce((sum, n) => sum + n * n, 0) / output.length,
  );
  assert.ok(rms < 0.025, 'Aliased tone RMS: ' + rms);
});
