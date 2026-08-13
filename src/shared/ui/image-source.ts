// 图片源判定 — 纯函数（可单测，无 React 依赖）
// 双源策略（README 要求）：
//   data:  → base64（next/image 原生支持 data URI，不走优化器，无需 remotePatterns）
//   https: → oss（交给 next/image optimizer，host 白名单由 next.config remotePatterns 兜底，
//            组件层不维护 client 侧白名单，避免与 server 配置双名单漂移）
//   其它   → 统一占位图（防御任意外链被渲染成图片探针）

export const PLACEHOLDER_IMAGE =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" fill="%231a1a2e"><rect width="300" height="300"/><text x="150" y="150" fill="%23ffffff33" text-anchor="middle" dy=".3em" font-size="14">暂无图片</text></svg>`,
  );

export type ResolvedSource =
  | { kind: "oss"; src: string }
  | { kind: "base64"; src: string }
  | { kind: "placeholder"; src: string };

export function resolveImageSource(
  src: string | null | undefined,
): ResolvedSource {
  if (!src || !src.trim()) {
    return { kind: "placeholder", src: PLACEHOLDER_IMAGE };
  }
  const trimmed = src.trim();
  if (trimmed.startsWith("data:")) {
    return { kind: "base64", src: trimmed };
  }
  if (/^https:\/\//i.test(trimmed)) {
    return { kind: "oss", src: trimmed };
  }
  return { kind: "placeholder", src: PLACEHOLDER_IMAGE };
}
