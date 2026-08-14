// shared/utils/api-errors 单元测试 — firstFieldError 从 422 details 提取第一条字段级原因
// 纯函数，无需 mock；契约：details 为 Record<string, string[]>（flattenZodError 形状）
// 品牌 Logo / 商品图片上传共用此函数，防两处拷贝漂移（此前逐字重复且无测试守护）

import { describe, it, expect } from "vitest";
import { firstFieldError } from "@/shared/utils/api-errors";

describe("firstFieldError — 从 422 details 提取第一条具体原因", () => {
  it("多字段时返回第一个字段的首条错误", () => {
    expect(
      firstFieldError({ file: ["仅支持 JPG/PNG/WebP 图片", "文件不能为空"], purpose: [] }),
    ).toBe("仅支持 JPG/PNG/WebP 图片");
  });

  it("只有单字段单错误也能取到", () => {
    expect(firstFieldError({ file: ["图片不能超过 4MB"] })).toBe("图片不能超过 4MB");
  });

  it("undefined / null / 非对象 → null", () => {
    expect(firstFieldError(undefined)).toBeNull();
    expect(firstFieldError(null)).toBeNull();
    expect(firstFieldError("oops")).toBeNull();
    expect(firstFieldError(42)).toBeNull();
  });

  it("空对象 → null", () => {
    expect(firstFieldError({})).toBeNull();
  });

  it("字段值全是空数组 → null", () => {
    expect(firstFieldError({ file: [], purpose: [] })).toBeNull();
  });

  it("字段值首元素非字符串（防御畸形响应）→ null", () => {
    expect(firstFieldError({ file: [123] })).toBeNull();
  });
});
