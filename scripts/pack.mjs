/**
 * 打包 Chrome / Edge 商店上传 zip（仅含扩展运行文件，不含 node_modules）
 *
 * 用法：npm run pack
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACK_FILES = [
  'manifest.json',
  'background.js',
  'content',
  'popup',
  'options',
  'shared',
  'icons'
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
const outDir = join(root, 'dist');
const zipName = `arya-translate-v${version}.zip`;
const zipPath = join(outDir, zipName);

for (const item of PACK_FILES) {
  const fullPath = join(root, item);
  if (!existsSync(fullPath)) {
    console.error(`缺少打包文件：${item}`);
    process.exit(1);
  }
}

mkdirSync(outDir, { recursive: true });
if (existsSync(zipPath)) unlinkSync(zipPath);

// Windows 10+ / macOS / Linux 均自带 tar，-a 按 .zip 扩展名自动压缩
execSync(`tar -a -c -f "${zipPath}" ${PACK_FILES.join(' ')}`, {
  cwd: root,
  stdio: 'inherit'
});

const sizeKb = (statSync(zipPath).size / 1024).toFixed(1);
console.log(`\n已生成：dist/${zipName}（${sizeKb} KB）`);
console.log('可直接上传到 Chrome Web Store / Edge Add-ons。');
