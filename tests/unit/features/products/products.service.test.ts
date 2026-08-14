// products.service 单元测试 — 公开详情只放行已上架商品（status 门禁）
// mock 系统边界：prisma.product.findFirst（getProductById 唯一查询）
// 核心契约：DELISTED/PENDING/WITHDRAWN/REJECTED 一律视为不存在（404），
// DB 层以 status:"APPROVED" 过滤，不泄露非在售商品存在性；仅 APPROVED 返回详情。

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: { product: { findFirst: vi.fn() } },
}));

import { prisma } from "@/shared/db/client";
import { ERROR_CODES } from "@/shared/errors/errors";
import { getProductById, requireProductById } from "@/features/products/products.service";

beforeEach(() => {
  vi.clearAllMocks();
});

const approvedProduct = {
  id: "product-1",
  name: "静音震动器",
  description: "低噪 50dB",
  price: 19900,
  images: ["https://img.example.com/a.jpg"],
  specs: { 噪音: "50dB" },
  category: "智能设备",
  subCategory: "智能健康监测",
  stock: 10,
  version: 1,
  sales: 3,
  status: "APPROVED",
  brand: { id: "brand-1", name: "赛夫严选自营" },
};

describe("getProductById — 公开详情只放行已上架商品", () => {
  it("查询强制带 status=APPROVED 过滤（下架/待审/撤回/拒绝均不可达）", async () => {
    vi.mocked(prisma.product.findFirst).mockResolvedValue(null);

    await getProductById("product-x");

    expect(prisma.product.findFirst).toHaveBeenCalledWith({
      where: { id: "product-x", status: "APPROVED" },
      include: { brand: { select: { id: true, name: true } } },
    });
  });

  it.each(["DELISTED", "PENDING", "WITHDRAWN", "REJECTED"])(
    "%s 状态商品（DB 侧已被过滤）→ 返回 null，不泄露存在性",
    async () => {
      vi.mocked(prisma.product.findFirst).mockResolvedValue(null);

      const result = await getProductById("product-x");

      expect(result).toBeNull();
    },
  );

  it("APPROVED 商品 → 返回详情（images 归一为字符串数组 + 品牌信息）", async () => {
    vi.mocked(prisma.product.findFirst).mockResolvedValue(approvedProduct as never);

    const result = await getProductById("product-1");

    expect(result?.id).toBe("product-1");
    expect(result?.status).toBe("APPROVED");
    expect(result?.images).toEqual(["https://img.example.com/a.jpg"]);
    expect(result?.brand).toEqual({ id: "brand-1", name: "赛夫严选自营" });
  });
});

describe("requireProductById — 非在售商品 404", () => {
  it("findFirst 返回 null（下架/待审/撤回）→ 抛 404 PRODUCT_NOT_FOUND", async () => {
    vi.mocked(prisma.product.findFirst).mockResolvedValue(null);

    await expect(requireProductById("product-x")).rejects.toMatchObject({
      code: ERROR_CODES.PRODUCT_NOT_FOUND.code,
      statusCode: 404,
    });
  });

  it("APPROVED → 正常返回详情（不抛错）", async () => {
    vi.mocked(prisma.product.findFirst).mockResolvedValue(approvedProduct as never);

    const result = await requireProductById("product-1");

    expect(result.id).toBe("product-1");
  });
});
