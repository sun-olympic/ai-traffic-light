// 从定稿位图（assets/icons/icon-1024.png，RGB 棋盘格底）生成规范 App 图标：
// - macOS：1024 画布、居中 824 内容区、Apple 圆角矩形（≈22.5% 半径）蒙版 + 透明留白 → build/icon.icns
// - Windows：同一蒙版结果打包 PNG-in-ICO（256/128/64/48/32/16）→ build/icon.ico
// 原图主体本身是大圆角方块、四角带烙死的棋盘格：把原图放大到 900 再套 824 蒙版，
// 蒙版曲线处处落在主体内部，棋盘格角随蒙版外区域一起裁净。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./png-io.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = decodePng(readFileSync(join(root, "assets/icons/icon-1024.png")));

const CANVAS = 1024;
const CONTENT = 824; // Apple 官方模板内容区
const ART = 900; // 主体放大到蒙版之外，保证蒙版切在主体内部
const RADIUS = Math.round(CONTENT * 0.225);

// —— 面积平均缩放（与 gen-tray-icon 同思路，源为不透明 RGB 可省 alpha 预乘）——
function scaleTo(srcPx, srcSize, dstSize) {
  const dst = Buffer.alloc(dstSize * dstSize * 4);
  const k = srcSize / dstSize;
  for (let dy = 0; dy < dstSize; dy++) {
    for (let dx = 0; dx < dstSize; dx++) {
      const x0 = Math.floor(dx * k);
      const x1 = Math.min(srcSize, Math.max(x0 + 1, Math.ceil((dx + 1) * k)));
      const y0 = Math.floor(dy * k);
      const y1 = Math.min(srcSize, Math.max(y0 + 1, Math.ceil((dy + 1) * k)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * srcSize + x) * 4;
          const al = srcPx[i + 3] / 255;
          r += srcPx[i] * al;
          g += srcPx[i + 1] * al;
          b += srcPx[i + 2] * al;
          a += al;
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

// —— 1. 原图 → 900，居中到 1024 透明画布 ——
const art = scaleTo(src.rgba, src.width, ART);
const canvas = Buffer.alloc(CANVAS * CANVAS * 4);
const artOff = (CANVAS - ART) >> 1;
for (let y = 0; y < ART; y++) {
  art.copy(canvas, ((y + artOff) * CANVAS + artOff) * 4, y * ART * 4, (y + 1) * ART * 4);
}

// —— 2. 圆角矩形蒙版（带符号距离场做 1px 抗锯齿边）——
const half = CONTENT / 2;
const cx = CANVAS / 2;
for (let y = 0; y < CANVAS; y++) {
  for (let x = 0; x < CANVAS; x++) {
    const qx = Math.max(Math.abs(x + 0.5 - cx) - (half - RADIUS), 0);
    const qy = Math.max(Math.abs(y + 0.5 - cx) - (half - RADIUS), 0);
    const dist = Math.hypot(qx, qy) - RADIUS;
    const cover = Math.min(Math.max(0.5 - dist, 0), 1);
    if (cover < 1) {
      const i = (y * CANVAS + x) * 4;
      canvas[i + 3] = Math.round(canvas[i + 3] * cover);
    }
  }
}

// —— 3. macOS iconset → icns ——
const buildDir = join(root, "build");
mkdirSync(buildDir, { recursive: true });
const setDir = join(buildDir, "icon.iconset");
rmSync(setDir, { recursive: true, force: true });
mkdirSync(setDir);
const cache = new Map(); // 尺寸 → RGBA（16~1024 共 7 档，@1x/@2x 复用）
function sized(px) {
  if (!cache.has(px)) cache.set(px, px === CANVAS ? canvas : scaleTo(canvas, CANVAS, px));
  return cache.get(px);
}
for (const base of [16, 32, 128, 256, 512]) {
  writeFileSync(join(setDir, `icon_${base}x${base}.png`), encodePng(base, base, sized(base)));
  writeFileSync(join(setDir, `icon_${base}x${base}@2x.png`), encodePng(base * 2, base * 2, sized(base * 2)));
}
execFileSync("iconutil", ["-c", "icns", setDir, "-o", join(buildDir, "icon.icns")]);
rmSync(setDir, { recursive: true, force: true });

// —— 4. Windows ico（PNG-in-ICO，Vista+）——
const icoSizes = [256, 128, 64, 48, 32, 16];
const pngs = icoSizes.map((s) => encodePng(s, s, sized(s)));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(icoSizes.length, 4);
const entries = [];
let offset = 6 + 16 * icoSizes.length;
for (let i = 0; i < icoSizes.length; i++) {
  const e = Buffer.alloc(16);
  e[0] = icoSizes[i] === 256 ? 0 : icoSizes[i]; // 0 = 256
  e[1] = e[0];
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  entries.push(e);
}
writeFileSync(join(buildDir, "icon.ico"), Buffer.concat([header, ...entries, ...pngs]));

// 预览图（人工核对用，不参与打包）
writeFileSync(join(buildDir, "icon-preview.png"), encodePng(CANVAS, CANVAS, canvas));
console.log(`written: build/icon.icns, build/icon.ico (${icoSizes.join("/")}), build/icon-preview.png`);
