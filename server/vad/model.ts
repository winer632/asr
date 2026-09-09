import * as ort from 'onnxruntime-node';
import { Fbank } from './fbank.js';
import { VadDecoder } from './decoder.js';

// Verified against the supplied net.onnx graph, not a substitute VAD model.
const CACHE_FRAMES = [4, 4, 8, 16, 32, 4, 8, 16, 32, 4, 8, 16, 32, 64];
const INPUTS = [
  'cache',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
  '13',
  '14',
];
const OUTPUTS = [
  '205',
  '216',
  '228',
  '255',
  '267',
  '294',
  '306',
  '333',
  '345',
  '372',
  '384',
  '411',
  '423',
  '450',
];
export class VadFactory {
  private constructor(
    private session: ort.InferenceSession,
    private defaultCaches: Float32Array[],
  ) {}
  static async load(path: string) {
    const session = await ort.InferenceSession.create(path, {
      executionProviders: ['cpu'],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    });
    if (session.inputNames.join(',') !== ['input', ...INPUTS].join(',')) {
      await session.release();
      throw new Error('VAD model inputs do not match the supplied net.onnx.');
    }
    const cache = CACHE_FRAMES.map((size) => new Float32Array(80 * size));
    const factory = new VadFactory(session, cache);
    // The C++ model warms all caches with sum(cache frame sizes) zero fbank frames.
    const warmup = new Float32Array(
      CACHE_FRAMES.reduce((a, b) => a + b, 0) * 80,
    );
    const output = await factory.forward(warmup, cache);
    factory.defaultCaches = output.caches;
    return factory;
  }
  create(silenceMs = 600) {
    return new VadStream(
      this,
      this.defaultCaches.map((c) => c.slice()),
      silenceMs,
    );
  }
  async forward(features: Float32Array, caches: Float32Array[]) {
    const feeds: Record<string, ort.Tensor> = {
      input: new ort.Tensor('float32', features, [1, features.length / 80, 80]),
    };
    INPUTS.forEach((name, i) => {
      feeds[name] = new ort.Tensor('float32', caches[i], [
        1,
        80,
        CACHE_FRAMES[i],
      ]);
    });
    const output = await this.session.run(feeds);
    return {
      probabilities: output.output.data as Float32Array,
      caches: OUTPUTS.map((name) =>
        Float32Array.from(output[name].data as Float32Array),
      ),
    };
  }
  release() {
    return this.session.release();
  }
}
export class VadStream {
  private features = new Fbank();
  readonly decoder: VadDecoder;
  constructor(
    private factory: VadFactory,
    private caches: Float32Array[],
    silenceMs: number,
  ) {
    this.decoder = new VadDecoder(Math.round(silenceMs / 10));
  }
  async accept(samples: Int16Array) {
    const frames = this.features.accept(samples);
    if (!frames.length) return [];
    const feature = new Float32Array(frames.length * 80);
    frames.forEach((frame, i) => feature.set(frame, i * 80));
    const result = await this.factory.forward(feature, this.caches);
    this.caches = result.caches;
    return this.decoder.accept(
      Array.from(
        { length: frames.length },
        (_, i) => result.probabilities[i * 2],
      ),
    );
  }
}
