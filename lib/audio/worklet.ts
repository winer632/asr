import { PcmResampler } from './resampler';
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
}
declare function registerProcessor(name: string, constructor: unknown): void;
class PcmCapture extends AudioWorkletProcessor {
  private resampler = new PcmResampler(sampleRate);
  private buffer = new ArrayBuffer(3200);
  private view = new DataView(this.buffer);
  private offset = 0;
  private energy = 0;
  private stopped = false;
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'flush' || this.stopped) return;
      this.stopped = true;
      this.append(this.resampler.push(new Float32Array(0), true));
      this.emit();
      this.port.postMessage({ type: 'flushed' });
    };
  }
  private append(samples: Float32Array) {
    for (const sample of samples) {
      const value = Math.max(-1, Math.min(1, sample));
      this.view.setInt16(
        this.offset * 2,
        Math.round(value * (value < 0 ? 32768 : 32767)),
        true,
      );
      this.energy += value * value;
      if (++this.offset === 1600) this.emit();
    }
  }
  private emit() {
    if (!this.offset) return;
    const pcm = this.buffer.slice(0, this.offset * 2);
    this.port.postMessage(
      { type: 'audio', pcm, rms: Math.sqrt(this.energy / this.offset) },
      [pcm],
    );
    this.buffer = new ArrayBuffer(3200);
    this.view = new DataView(this.buffer);
    this.offset = 0;
    this.energy = 0;
  }
  process(inputs: Float32Array[][]) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels)
      for (let i = 0; i < mono.length; i++)
        mono[i] += channel[i] / channels.length;
    this.append(this.resampler.push(mono));
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
