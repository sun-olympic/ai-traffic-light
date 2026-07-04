// 从定稿 App 图标位图（assets/icons/icon-1024.png）生成菜单栏托盘图标 tray.png / tray@2x.png。
// 定稿图是 RGB 无 alpha、浅色棋盘格底：先从四角 flood fill 抠背景转透明，
// 再裁剪主体 bbox 居中成方形，box-filter 面积平均下采样（1024→44/22 缩 23 倍，自带抗锯齿）。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./png-io.mjs";

const iconsDir = join(dirname(fileURLToPath(import.meta.url)), "../assets/icons");
const { width, height, rgba } = decodePng(readFileSync(join(iconsDir, "icon-1024.png")));

// —— 1. 抠背景：从四角 BFS，吞掉连通的近中性浅色（棋盘格两色都满足），主体光晕是彩色不受影响 ——
function isBgColor(i) {
  const r = rgba[i];
  const g = rgba[i + 1];
  const b = rgba[i + 2];
  return r > 175 && g > 175 && b > 175 && Math.max(r, g, b) - Math.min(r, g, b) < 32;
}

const bg = new Uint8Array(width * height);
const queue = [0, width - 1, (height - 1) * width, height * width - 1];
for (const p of queue) if (isBgColor(p * 4)) bg[p] = 1;
while (queue.length) {
  const p = queue.pop();
  if (!bg[p]) continue;
  const x = p % width;
  for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
    if (q >= 0 && q < width * height && !bg[q] && isBgColor(q * 4)) {
      bg[q] = 1;
      queue.push(q);
    }
  }
}
for (let p = 0; p < width * height; p++) if (bg[p]) rgba[p * 4 + 3] = 0;

// —— 2. 主体 bbox → 居中方形画布 ——
let minX = width;
let minY = height;
let maxX = 0;
let maxY = 0;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    if (rgba[(y * width + x) * 4 + 3]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
const side = Math.max(maxX - minX + 1, maxY - minY + 1);
const canvas = Buffer.alloc(side * side * 4);
const offX = (side - (maxX - minX + 1)) >> 1;
const offY = (side - (maxY - minY + 1)) >> 1;
for (let y = minY; y <= maxY; y++) {
  const srcStart = (y * width + minX) * 4;
  const dstStart = ((y - minY + offY) * side + offX) * 4;
  rgba.copy(canvas, dstStart, srcStart, srcStart + (maxX - minX + 1) * 4);
}

// —— 3. box-filter 面积平均下采样（alpha 预乘避免透明区渗色）——
function downscale(src, srcSize, dstSize) {
  const dst = Buffer.alloc(dstSize * dstSize * 4);
  const scale = srcSize / dstSize;
  for (let dy = 0; dy < dstSize; dy++) {
    for (let dx = 0; dx < dstSize; dx++) {
      const x0 = Math.floor(dx * scale);
      const x1 = Math.min(srcSize, Math.ceil((dx + 1) * scale));
      const y0 = Math.floor(dy * scale);
      const y1 = Math.min(srcSize, Math.ceil((dy + 1) * scale));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * srcSize + x) * 4;
          const alpha = src[i + 3] / 255;
          r += src[i] * alpha;
          g += src[i + 1] * alpha;
          b += src[i + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      const j = (dy * dstSize + dx) * 4;
      if (a > 0) {
        dst[j] = Math.round(r / a);
        dst[j + 1] = Math.round(g / a);
        dst[j + 2] = Math.round(b / a);
        dst[j + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return dst;
}

writeFileSync(join(iconsDir, "tray@2x.png"), encodePng(44, 44, downscale(canvas, side, 44)));
writeFileSync(join(iconsDir, "tray.png"), encodePng(22, 22, downscale(canvas, side, 22)));
console.log(`written: tray.png (22x22), tray@2x.png (44x44); source bbox ${maxX - minX + 1}x${maxY - minY + 1}`);
