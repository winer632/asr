import { readFileSync, writeFileSync } from 'node:fs';
import { VadFactory } from '../server/vad/model.js';
import { readWav } from '../tests/wav.js';
const root = 'test-output/real-speech/';
const cases = JSON.parse(readFileSync(root + 'noise-cases.json', 'utf8')) as {
  name: string;
  path: string;
}[];
cases.push({ name: 'noise_only', path: root + 'noise_only.wav' });
const factory = await VadFactory.load('models/net.onnx');
const results = [];
try {
  for (const test of cases) {
    const source = readWav(test.path).samples;
    const samples = new Int16Array(source.length + 48000);
    samples.set(source, 16000);
    const vad = factory.create();
    const events = [];
    for (let i = 0; i < samples.length; i += 1600)
      events.push(...(await vad.accept(samples.subarray(i, i + 1600))));
    const result = {
      name: test.name,
      segments: events.filter((e) => e.type === 'start').length,
      events,
      ended: !vad.decoder.speaking,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
} finally {
  await factory.release();
}
writeFileSync(root + 'vad-results.json', JSON.stringify(results, null, 2));
