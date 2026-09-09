import { build } from 'esbuild';
await build({
  entryPoints: ['lib/audio/worklet.ts'],
  outfile: 'public/audio-worklet.js',
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
});
