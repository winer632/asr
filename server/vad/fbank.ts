// Adapted from the supplied vad-new-standalone/frontend/fbank.h.
// Copyright (c) 2017 Personal (Binbin Zhang). Apache-2.0.
// See THIRD_PARTY_NOTICES.md. Input samples retain the int16 amplitude scale.
const f = Math.fround;
const FRAME = 400,
  SHIFT = 160,
  FFT = 512,
  BINS = 80;
const mel = (hz: number) => f(1127 * f(Math.log(f(1 + f(hz / 700)))));

export class Fbank {
  private remaining = new Float32Array(0);
  private readonly window = Float32Array.from({ length: FRAME }, (_, i) =>
    Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)), 0.85),
  );
  private readonly filters: { indices: number[]; weights: number[] }[];
  private readonly sine = new Float32Array(FFT + FFT / 4);
  constructor() {
    // Preserve the original FFT's float32 trigonometric recurrence. Using a
    // separately rounded Math.sin/cos for each bin changes very quiet spectra.
    let t = f(Math.sin(Math.PI / FFT));
    let dc = f(f(2 * t) * t),
      ds = f(Math.sqrt(f(dc * f(2 - dc))));
    t = f(2 * dc);
    let c = 1,
      s = 0;
    this.sine[FFT / 4] = 1;
    for (let i = 1; i < FFT / 8; i++) {
      c = f(c - dc);
      dc = f(dc + f(t * c));
      s = f(s + ds);
      ds = f(ds - f(t * s));
      this.sine[i] = s;
      this.sine[FFT / 4 - i] = c;
    }
    this.sine[FFT / 8] = Math.sqrt(0.5);
    for (let i = 0; i < FFT / 4; i++) this.sine[FFT / 2 - i] = this.sine[i];
    for (let i = 0; i < FFT / 2 + FFT / 4; i++)
      this.sine[i + FFT / 2] = -this.sine[i];
    const low = mel(20),
      delta = f(f(mel(8000) - low) / (BINS + 1));
    this.filters = Array.from({ length: BINS }, (_, bin) => {
      const left = f(low + f(bin * delta)),
        center = f(low + f((bin + 1) * delta)),
        right = f(low + f((bin + 2) * delta));
      const indices: number[] = [],
        weights: number[] = [];
      for (let i = 0; i < FFT / 2; i++) {
        const value = mel((16000 * i) / FFT);
        if (value > left && value < right) {
          indices.push(i);
          weights.push(
            value <= center
              ? f(f(value - left) / f(center - left))
              : f(f(right - value) / f(right - center)),
          );
        }
      }
      return { indices, weights };
    });
  }
  accept(samples: Int16Array): Float32Array[] {
    const wave = new Float32Array(this.remaining.length + samples.length);
    wave.set(this.remaining);
    wave.set(samples, this.remaining.length);
    const frames = Math.max(0, 1 + Math.floor((wave.length - FRAME) / SHIFT));
    const result = Array.from({ length: frames }, (_, i) =>
      this.compute(wave.subarray(i * SHIFT, i * SHIFT + FRAME)),
    );
    this.remaining = wave.slice(frames * SHIFT);
    return result;
  }
  compute(frame: Float32Array): Float32Array {
    const real = new Float32Array(FFT),
      imaginary = new Float32Array(FFT);
    let mean = 0;
    for (const value of frame) mean = f(mean + value);
    mean = f(mean / FRAME);
    for (let i = 0; i < FRAME; i++) real[i] = f(frame[i] - mean);
    for (let i = FRAME - 1; i > 0; i--)
      real[i] = f(real[i] - f(f(0.97) * real[i - 1]));
    real[0] = f(real[0] - f(f(0.97) * real[0]));
    for (let i = 0; i < FRAME; i++) real[i] = f(real[i] * this.window[i]);
    // Radix-2 FFT: the same unnormalised transform as the original frontend.
    for (let i = 1, j = 0; i < FFT; i++) {
      let bit = FFT >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) [real[i], real[j]] = [real[j], real[i]];
    }
    for (let size = 2; size <= FFT; size <<= 1) {
      for (let offset = 0; offset < size / 2; offset++) {
        const h = (offset * FFT) / size,
          cos = this.sine[h + FFT / 4],
          sin = this.sine[h];
        for (let i = offset; i < FFT; i += size) {
          const j = i + size / 2;
          const dx = f(f(sin * imaginary[j]) + f(cos * real[j]));
          const dy = f(f(cos * imaginary[j]) - f(sin * real[j]));
          real[j] = f(real[i] - dx);
          real[i] = f(real[i] + dx);
          imaginary[j] = f(imaginary[i] - dy);
          imaginary[i] = f(imaginary[i] + dy);
        }
      }
    }
    const power = Float32Array.from({ length: FFT / 2 }, (_, i) =>
      f(f(real[i] * real[i]) + f(imaginary[i] * imaginary[i])),
    );
    return Float32Array.from(this.filters, ({ indices, weights }) => {
      let sum = 0;
      for (let i = 0; i < indices.length; i++)
        sum = f(sum + f(weights[i] * power[indices[i]]));
      return f(Math.log(Math.max(1.1920928955078125e-7, sum)));
    });
  }
}
