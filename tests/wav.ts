import { readFileSync } from 'node:fs';
export function readWav(filename: string) {
  const data = readFileSync(filename);
  if (
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new Error('Not a WAV file');
  let pcm: Buffer | undefined,
    validFormat = false;
  for (let offset = 12; offset + 8 <= data.length;) {
    const id = data.toString('ascii', offset, offset + 4),
      size = data.readUInt32LE(offset + 4),
      start = offset + 8;
    if (start + size > data.length) throw new Error('Truncated WAV file');
    if (id === 'fmt ')
      validFormat =
        size >= 16 &&
        data.readUInt16LE(start) === 1 &&
        data.readUInt16LE(start + 2) === 1 &&
        data.readUInt32LE(start + 4) === 16000 &&
        data.readUInt16LE(start + 14) === 16;
    if (id === 'data') pcm = data.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!validFormat || !pcm || pcm.length % 2)
    throw new Error('Expected PCM16 mono 16 kHz WAV');
  return {
    pcm,
    samples: Int16Array.from({ length: pcm.length / 2 }, (_, i) =>
      pcm.readInt16LE(i * 2),
    ),
  };
}
