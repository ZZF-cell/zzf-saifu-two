// 共享商品校验 — updateProductSchema（品牌/管理端编辑共用 partial 更新）
// 核心契约：全字段可选但至少一个；仅改运营信息（价格/库存）可过；
// 类目只在 category 与 subCategory「同时出现」时校验组合（兼容部分更新）；
// 非法组合错误指向 subCategory。

import { describe, it, expect, afterEach, vi } from "vitest";
import { updateProductSchema } from "@/shared/validation/product";

// ossImageUrlSchema 依赖 OSS host 白名单（isOssUrl 运行时读 env），测试内 stub 固定桶域名。
// G4 后 key 须为上传结构 `<folder>/<userId>/<yyyymmdd>/<文件名>.<扩展名>`（4 段）
const BUCKET_URL = "https://mybucket.oss-cn-hangzhou.aliyuncs.com/cert/user-1/20260815/a.pdf";

function stubOssEnv() {
  vi.stubEnv("OSS_BUCKET", "mybucket");
  vi.stubEnv("OSS_REGION", "oss-cn-hangzhou");
}
afterEach(() => vi.unstubAllEnvs());

describe("updateProductSchema — 部分更新校验", () => {
  it("仅改价格 → 通过（运营信息直改）", () => {
    expect(updateProductSchema.safeParse({ price: 99.5 }).success).toBe(true);
  });

  it("仅改库存 → 通过", () => {
    expect(updateProductSchema.safeParse({ stock: 5 }).success).toBe(true);
  });

  it("仅改 name → 通过", () => {
    expect(updateProductSchema.safeParse({ name: "新款" }).success).toBe(true);
  });

  it("空对象 → 失败（至少更新一个字段）", () => {
    const res = updateProductSchema.safeParse({});
    expect(res.success).toBe(false);
  });

  it("category + subCategory 非法组合 → 失败且错误指向 subCategory", () => {
    const res = updateProductSchema.safeParse({
      category: "成人计生用品",
      subCategory: "震动器具", // 震动器具属于情趣用品，非成人计生用品
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const subIssues = res.error.issues.filter((i) => i.path[0] === "subCategory");
      expect(subIssues.length).toBeGreaterThan(0);
    }
  });

  it("category + subCategory 合法组合 → 通过", () => {
    const res = updateProductSchema.safeParse({
      category: "成人计生用品",
      subCategory: "避孕套",
    });
    expect(res.success).toBe(true);
  });

  it("只改 category 不改 subCategory → 通过（partial 更新不强制成对校验）", () => {
    expect(updateProductSchema.safeParse({ category: "情趣用品" }).success).toBe(true);
  });

  it("价格非法（0/负数）→ 失败", () => {
    expect(updateProductSchema.safeParse({ price: 0 }).success).toBe(false);
    expect(updateProductSchema.safeParse({ price: -1 }).success).toBe(false);
  });

  it("库存非法（负数/小数）→ 失败", () => {
    expect(updateProductSchema.safeParse({ stock: -1 }).success).toBe(false);
    expect(updateProductSchema.safeParse({ stock: 1.5 }).success).toBe(false);
  });

  it("certificates 合法（图片/PDF + 白名单 mime + OSS url）→ 通过", () => {
    stubOssEnv();
    const res = updateProductSchema.safeParse({
      certificates: [
        { url: "https://mybucket.oss-cn-hangzhou.aliyuncs.com/cert/user-1/20260815/report.pdf", name: "质检报告.pdf", mime: "application/pdf" },
        { url: "https://mybucket.oss-cn-hangzhou.aliyuncs.com/cert/user-1/20260815/ccc.jpg", name: "3C 认证.jpg", mime: "image/jpeg" },
      ],
    });
    expect(res.success).toBe(true);
  });

  it("certificates 非法（白名单外 mime / 非 OSS url / 空 name）→ 失败", () => {
    stubOssEnv();
    expect(
      updateProductSchema.safeParse({
        certificates: [{ url: BUCKET_URL, name: "x", mime: "application/octet-stream" }],
      }).success,
    ).toBe(false);
    expect(
      updateProductSchema.safeParse({
        certificates: [{ url: "https://evil.com/x.pdf", name: "x", mime: "application/pdf" }],
      }).success,
    ).toBe(false);
    expect(
      updateProductSchema.safeParse({
        certificates: [{ url: BUCKET_URL, name: "", mime: "application/pdf" }],
      }).success,
    ).toBe(false);
  });

  it("certificates 超过 5 份 → 失败（上限 5）", () => {
    stubOssEnv();
    const certs = Array.from({ length: 6 }, (_, i) => ({
      url: BUCKET_URL,
      name: `证书 ${i}`,
      mime: "application/pdf" as const,
    }));
    expect(updateProductSchema.safeParse({ certificates: certs }).success).toBe(false);
  });
});
