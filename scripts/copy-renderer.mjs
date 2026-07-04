// 构建步骤：把渲染进程静态资源（html/css）拷到 dist，js 由 tsc 产出
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(root, "dist/renderer"), { recursive: true });
cpSync(join(root, "src/renderer/static"), join(root, "dist/renderer/static"), {
  recursive: true,
});
