/**
 * 用法：node scripts/gen-icons.mjs <source-image-path>
 * 例：  node scripts/gen-icons.mjs C:\Users\fgao2\Downloads\arya.png
 *
 * 会把图片压缩并输出到 icons/ 目录的 icon16.png、icon48.png、icon128.png
 */
import { Jimp } from 'jimp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];

if (!src) {
  console.error('Usage: node scripts/gen-icons.mjs <source-image-path>');
  process.exit(1);
}

const SIZES = [16, 48, 128];
const outDir = path.join(__dirname, '..', 'icons');

console.log(`Reading: ${src}`);
const img = await Jimp.read(src);

for (const size of SIZES) {
  const out = path.join(outDir, `icon${size}.png`);
  await img.clone().resize({ w: size, h: size }).write(out);
  console.log(`✓ icons/icon${size}.png`);
}

console.log('\nAll icons generated successfully!');
console.log('Reload the extension in chrome://extensions to see the new icon.');
