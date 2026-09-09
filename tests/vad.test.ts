import test from 'node:test';
import assert from 'node:assert/strict';
import { VadFactory } from '../server/vad/model.js';
import { readWav } from './wav.js';
void test('supplied ONNX VAD separates speech from silence in all three languages', async () => {
  const factory = await VadFactory.load('models/net.onnx');
  try {
    const silence = factory.create();
    for (let i = 0; i < 30; i++)
      assert.deepEqual(await silence.accept(new Int16Array(1600)), []);
    for (const language of ['mandarin', 'cantonese', 'english']) {
      const { samples } = readWav('tests/fixtures/' + language + '_1.wav');
      const input = new Int16Array(16000 + samples.length + 32000);
      input.set(samples, 16000);
      const stream = factory.create(),
        events = [];
      for (let i = 0; i < input.length; i += 1600)
        events.push(...(await stream.accept(input.subarray(i, i + 1600))));
      const starts = events.filter((e) => e.type === 'start'),
        ends = events.filter((e) => e.type === 'end');
      assert.ok(starts.length > 0, language + ': speech not detected');
      assert.equal(starts.length, ends.length, language + ': missing end');
      assert.ok(
        starts[0].sample >= 8000 && starts[0].sample < 32000,
        language + ': onset outside expected range',
      );
      assert.equal(stream.decoder.speaking, false);
    }
  } finally {
    await factory.release();
  }
});
