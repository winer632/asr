// State machine adapted from the supplied vad/vad_decoder.cc (10 ms frames).
export interface VadBoundary {
  type: 'start' | 'end';
  sample: number;
}
export class VadDecoder {
  speaking = false;
  probability = 0;
  private frame = 0;
  private sound = 0;
  private silence = 0;
  private start = -1;
  private previousEnd = -1;
  private scores: number[] = [];
  constructor(
    private silenceFrames = 60,
    private soundFrames = 30,
    private headFrames = 6,
  ) {}
  accept(silenceProbabilities: number[]): VadBoundary[] {
    const events: VadBoundary[] = [];
    for (const probability of silenceProbabilities) {
      this.scores.push(probability);
      if (this.scores.length > 10) this.scores.shift();
      const silenceProbability =
        this.scores.reduce((a, b) => a + b, 0) / this.scores.length;
      this.probability = 1 - silenceProbability;
      this.frame++;
      if (
        (!this.speaking && silenceProbability > 0.65) ||
        (this.speaking && this.probability < 0.65)
      ) {
        this.silence++;
        this.sound = 0;
      } else {
        this.sound++;
        this.silence = 0;
      }
      if (!this.speaking && this.sound >= this.soundFrames) {
        this.start = this.frame - this.sound;
        const sample =
          Math.max(0, this.previousEnd, this.start - this.headFrames) * 160;
        this.speaking = true;
        events.push({ type: 'start', sample });
      } else if (this.speaking) {
        const age = this.frame - this.start;
        const limit =
          age > 5500
            ? 3
            : age > 5000
              ? 7
              : age > 4800
                ? 10
                : age > 4600
                  ? 20
                  : age > 4500
                    ? 25
                    : this.silenceFrames;
        if (this.silence >= limit) {
          this.previousEnd = this.frame - this.silence;
          this.speaking = false;
          events.push({ type: 'end', sample: this.previousEnd * 160 });
          this.start = -1;
        }
      }
    }
    return events;
  }
}
