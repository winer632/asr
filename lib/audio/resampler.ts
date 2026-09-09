// Stateful, anti-aliased resampling. Preserves phase across AudioWorklet quanta.
export class PcmResampler {
  private buffer = new Float32Array(16);
  private position = 16;
  private inputCount = 0;
  private outputCount = 0;
  private coefficients = new Map<number, Float64Array>();
  private readonly ratio: number;
  constructor(
    private inputRate: number,
    private outputRate = 16000,
  ) {
    if (!(inputRate > 0 && outputRate > 0))
      throw new Error('Invalid sample rate');
    this.ratio = inputRate / outputRate;
  }
  push(input: Float32Array, final = false): Float32Array {
    if (this.inputRate === this.outputRate) return input.slice();
    this.inputCount += input.length;
    const combined = new Float32Array(
      this.buffer.length + input.length + (final ? 33 : 0),
    );
    combined.set(this.buffer);
    combined.set(input, this.buffer.length);
    this.buffer = combined;
    const result: number[] = [];
    const maximum = Math.floor(this.inputCount / this.ratio);
    while (
      Math.floor(this.position) + 16 < this.buffer.length &&
      this.outputCount < maximum
    ) {
      const base = Math.floor(this.position),
        phase = Math.round((this.position - base) * 1024);
      let coefficients = this.coefficients.get(phase);
      if (!coefficients) {
        const cutoff = 0.47 * Math.min(1, 1 / this.ratio),
          fraction = phase / 1024;
        coefficients = Float64Array.from({ length: 32 }, (_, j) => {
          const x = j - 15 - fraction;
          const sinc =
            Math.abs(x) < 1e-10
              ? 2 * cutoff
              : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
          const window =
            0.42 +
            0.5 * Math.cos((Math.PI * x) / 16) +
            0.08 * Math.cos((2 * Math.PI * x) / 16);
          return sinc * window;
        });
        const sum = coefficients.reduce((a, b) => a + b, 0);
        coefficients = coefficients.map((value) => value / sum);
        this.coefficients.set(phase, coefficients);
      }
      let value = 0;
      for (let j = 0; j < 32; j++)
        value += this.buffer[base - 15 + j] * coefficients[j];
      result.push(value);
      this.outputCount++;
      this.position += this.ratio;
    }
    const discard = Math.max(0, Math.floor(this.position) - 16);
    this.buffer = this.buffer.slice(discard);
    this.position -= discard;
    return Float32Array.from(result);
  }
}
