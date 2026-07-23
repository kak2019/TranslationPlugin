/**
 * 用法：node scripts/gen-icons.mjs [source-image-path]
 * 默认：scripts/arya-brand.png
 *
 * 从四角 flood-fill 去掉近白背景（保留圆心白色字母），输出 icons/icon{16,48,128}.png
 */
import { Jimp, intToRGBA, rgbaToInt } from 'jimp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] || path.join(__dirname, 'arya-brand.png');
const SIZES = [16, 48, 128];
const outDir = path.join(__dirname, '..', 'icons');

function isBackgroundColor(color) {
  const { r, g, b, a } = intToRGBA(color);
  if (a < 24) return true;
  // 仅清掉接近白/浅灰的画布底，不要动粉红圆和字母抗锯齿
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return a > 180 && min > 230 && max - min < 18;
}

function floodClearBackground(img) {
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const visited = new Uint8Array(w * h);
  const stack = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
    [Math.floor(w / 2), 0],
    [Math.floor(w / 2), h - 1],
    [0, Math.floor(h / 2)],
    [w - 1, Math.floor(h / 2)]
  ];

  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = y * w + x;
    if (visited[i]) continue;
    visited[i] = 1;
    const color = img.getPixelColor(x, y);
    if (!isBackgroundColor(color)) continue;
    img.setPixelColor(rgbaToInt(0, 0, 0, 0), x, y);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
}

function cropOpaque(img) {
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  img.scan(0, 0, w, h, function (x, y) {
    const { a } = intToRGBA(this.getPixelColor(x, y));
    if (a < 16) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  });

  if (maxX < minX || maxY < minY) return img;

  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.03);
  const cropX = Math.max(0, minX - pad);
  const cropY = Math.max(0, minY - pad);
  const cropW = Math.min(w - cropX, maxX - minX + 1 + pad * 2);
  const cropH = Math.min(h - cropY, maxY - minY + 1 + pad * 2);
  return img.crop({ x: cropX, y: cropY, w: cropW, h: cropH });
}

async function fitSquare(img, size) {
  const side = Math.max(img.bitmap.width, img.bitmap.height);
  const canvas = new Jimp({ width: side, height: side, color: 0x00000000 });
  const ox = Math.floor((side - img.bitmap.width) / 2);
  const oy = Math.floor((side - img.bitmap.height) / 2);
  canvas.composite(img, ox, oy);
  return canvas.resize({ w: size, h: size });
}

console.log(`Reading: ${src}`);
let img = await Jimp.read(src);
floodClearBackground(img);
img = cropOpaque(img);

for (const size of SIZES) {
  const out = path.join(outDir, `icon${size}.png`);
  const sized = await fitSquare(img.clone(), size);
  await sized.write(out);
  console.log(`✓ icons/icon${size}.png`);
}

console.log('\nAll icons generated successfully!');
console.log('Reload the extension in chrome://extensions to see the new icon.');
