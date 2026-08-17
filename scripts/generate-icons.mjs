// 品牌图标生成：从 public/logo.png 生成 favicon / 苹果图标 / PWA 图标
//
// 用法：node scripts/generate-icons.mjs
// 输入：public/logo.png（品牌 LOGO，已入库）
// 输出：
//   src/app/icon.png         favicon（Next.js App Router 自动 <link rel="icon">）
//   src/app/apple-icon.png   iOS 主屏图标（180×180）
//   public/icons/icon-192x192.png   PWA manifest 192
//   public/icons/icon-512x512.png   PWA manifest 512
//
// 说明：LOGO 是"圆形徽章 + 文字"的竖排结构，主体偏左上且底部留白，背景近纯白。
// 处理流程：① sharp trim(100) 按角落背景色裁掉白边与导出灰框，得到紧凑主体区
//（483×654，实测徽章与文字完整保留）；② resize 到 (size-2*margin) 方形白色画布；
// ③ extend 补 margin 到精确 size×size —— 主体居中、无 contain 接缝。
// ⚠️ sharp 坑：extend 后再 resize 会得到 target+2*pad 的输出（操作被重排），
// 必须 resize→extend 顺序。
import sharp from "sharp";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "public", "logo.png");

if (!existsSync(src)) {
  console.error(`[icons] 缺少输入 ${src} —— 请先把品牌 LOGO 复制到 public/logo.png`);
  process.exit(1);
}

const trimmed = await sharp(src).trim({ threshold: 100 }).toBuffer();
const { width: tw, height: th } = await sharp(trimmed).metadata();
console.log(`[icons] trim 后主体 ${tw}x${th}`);

const targets = [
  { out: join(root, "src", "app", "icon.png"), size: 48 },
  { out: join(root, "src", "app", "apple-icon.png"), size: 180 },
  { out: join(root, "public", "icons", "icon-192x192.png"), size: 192 },
  { out: join(root, "public", "icons", "icon-512x512.png"), size: 512 },
];

for (const { out, size } of targets) {
  const margin = Math.round(size * 0.08);
  const inner = size - margin * 2;
  await sharp(trimmed)
    .resize(inner, inner, { fit: "contain", background: "#ffffff" })
    .extend({ top: margin, bottom: margin, left: margin, right: margin, background: "#ffffff" })
    .png()
    .toFile(out);
  console.log(`[icons] ${size}x${size} → ${out}`);
}
