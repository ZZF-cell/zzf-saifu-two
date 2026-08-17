// prebuild：生成 public/build-id.json（PWA 构建版本校验）
//
// 每次 `npm run build` 生成唯一版本号。前端 PwaInstaller 轮询 /build-id.json，
// 发现版本变化 → 弹条提示刷新（README「构建版本校验」）。
// 文件落在 public/ → next build 随其余静态资源拷贝进产物，随部署自然更新。
import { createHash, randomBytes } from "crypto";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = createHash("sha256")
  .update(String(Date.now()) + randomBytes(16).toString("hex"))
  .digest("hex")
  .slice(0, 12);

const out = join(root, "public", "build-id.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({ version, generatedAt: new Date().toISOString() }, null, 2),
);

console.log(`[build-id] ${version} → public/build-id.json`);
