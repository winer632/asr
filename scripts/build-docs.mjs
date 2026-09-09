import { copyFile } from 'node:fs/promises';
await copyFile('docs/index.html', 'public/asr-api.html');
console.log(
  'Responsive API reference: docs/index.html and public/asr-api.html',
);
