// image-source 纯函数单测 — 双源判定（不 mock，不引 jsdom）
// 契约：
// - 空/undefined/null → placeholder（统一占位图）
// - data: 开头 → base64（next/image 直接渲染，不走优化器）
// - https:// → oss（host 白名单由 next/image remotePatterns 兜底，组件层不判 host）
// - 相对路径 / http（非 https）→ placeholder（防御任意外链）

import { describe, it, expect } from "vitest";
import { resolveImageSource, PLACEHOLDER_IMAGE } from "@/shared/ui/image-source";

describe("resolveImageSource — 图片源双源判定", () => {
  it("空 / undefined / null → placeholder", () => {
    expect(resolveImageSource("")).toEqual({ kind: "placeholder", src: PLACEHOLDER_IMAGE });
    expect(resolveImageSource(undefined)).toEqual({ kind: "placeholder", src: PLACEHOLDER_IMAGE });
    expect(resolveImageSource(null)).toEqual({ kind: "placeholder", src: PLACEHOLDER_IMAGE });
  });

  it("data: 开头 → base64", () => {
    expect(resolveImageSource("data:image/png;base64,AAAA")).toEqual({
      kind: "base64",
      src: "data:image/png;base64,AAAA",
    });
  });

  it("https:// → oss", () => {
    expect(resolveImageSource("https://img.example.com/a.jpg")).toEqual({
      kind: "oss",
      src: "https://img.example.com/a.jpg",
    });
  });

  it("相对路径 / http（非 https）→ placeholder（防御）", () => {
    expect(resolveImageSource("/images/a.jpg").kind).toBe("placeholder");
    expect(resolveImageSource("http://img.example.com/a.jpg").kind).toBe("placeholder");
    expect(resolveImageSource("javascript:alert(1)").kind).toBe("placeholder");
  });
});
