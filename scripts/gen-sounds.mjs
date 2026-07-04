// 生成内置提示音（黄/红两种音色，可盲听区分）：纯 PCM 合成，零依赖
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 44100;

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-1, Math.min(1, s)) * 32767, i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function tone(freq, durS, { fade = 0.02, gain = 0.4 } = {}) {
  const n = Math.floor(RATE * durS);
  return Array.from({ length: n }, (_, i) => {
    const env = Math.min(1, i / (RATE * fade), (n - i) / (RATE * fade));
    return Math.sin((2 * Math.PI * freq * i) / RATE) * gain * env;
  });
}

const silence = (durS) => new Array(Math.floor(RATE * durS)).fill(0);

// 黄灯：上行双音 ding-dong（悦耳提醒）
const yellow = [...tone(880, 0.12), ...silence(0.05), ...tone(1175, 0.18)];
// 红灯：低频三连蜂鸣（急促警示）
const red = [...tone(330, 0.1), ...silence(0.06), ...tone(330, 0.1), ...silence(0.06), ...tone(262, 0.22)];

const out = join(dirname(dirname(fileURLToPath(import.meta.url))), "assets/sounds");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "yellow.wav"), wav(yellow));
writeFileSync(join(out, "red.wav"), wav(red));
console.log("sounds written to", out);
