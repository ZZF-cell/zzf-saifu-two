// brand.service 单元测试 — 品牌归属校验 + 商品提交流程（价格转分 + 待质检）
// mock 系统边界：prisma（brand.findUnique / product.create / brand.update）
// 只测公共 seam：brand.service 的 getBrandByOwner / submitProduct / updateBrandProfile
//
// 核心契约：提交商品要求品牌已 APPROVED（FORBIDDEN），价格必须以元→分存储，
// 新商品默认 status=PENDING 待平台质检。

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    brand: { findUnique: vi.fn(), update: vi.fn() },
    product: { create: vi.fn() },
  },
}));

import { prisma } from "@/shared/db/client";
import { ERROR_CODES } from "@/shared/errors/errors";
import {
  submitProduct,
  updateBrandProfile,
} from "@/features/brand/brand.service";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 提交商品 ──

describe("submitProduct — 品牌提交商品", () => {
  it("品牌已 APPROVED → 价格转分存储 + 状态 PENDING + images 空数组", async () => {
    vi.mocked(prisma.brand.findUnique).mockResolvedValue({ status: "APPROVED" } as never);
    vi.mocked(prisma.product.create).mockResolvedValue({ id: "product-1" } as never);

    const result = await submitProduct("brand-1", {
      name: "静音震动器",
      description: "低噪 50dB",
      category: "智能设备",
      price: 199,
      stock: 10,
    });

    expect(result).toEqual({ id: "product-1" });
    expect(prisma.product.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        brandId: "brand-1",
        name: "静音震动器",
        description: "低噪 50dB",
        category: "智能设备",
        price: 19900, // 元 → 分（整数精度，避免浮点误差）
        stock: 10,
        status: "PENDING",
      }),
      select: { id: true },
    });
    const createArgs = vi.mocked(prisma.product.create).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArgs.data.images).toEqual([]);
  });

  it("价格 0.5 元 → 精确转 50 分（无浮点误差）", async () => {
    vi.mocked(prisma.brand.findUnique).mockResolvedValue({ status: "APPROVED" } as never);
    vi.mocked(prisma.product.create).mockResolvedValue({ id: "product-2" } as never);

    await submitProduct("brand-1", {
      name: "润滑剂",
      category: "身体护理",
      price: 0.5,
      stock: 100,
    });

    const createArgs = vi.mocked(prisma.product.create).mock.calls[0][0] as {
      data: { price: number };
    };
    expect(createArgs.data.price).toBe(50);
  });

  it("specs 未传 → product.create 不含 specs（undefined）", async () => {
    vi.mocked(prisma.brand.findUnique).mockResolvedValue({ status: "APPROVED" } as never);
    vi.mocked(prisma.product.create).mockResolvedValue({ id: "product-3" } as never);

    await submitProduct("brand-1", {
      name: "测试商品",
      category: "测试",
      price: 10,
      stock: 1,
    });

    const createArgs = vi.mocked(prisma.product.create).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArgs.data.specs).toBeUndefined();
  });

  it("品牌不存在 → 抛 BRAND_NOT_FOUND，不创建商品", async () => {
    vi.mocked(prisma.brand.findUnique).mockResolvedValue(null);

    await expect(
      submitProduct("brand-x", { name: "x", category: "c", price: 1, stock: 1 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.BRAND_NOT_FOUND.code });
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it("品牌未过审（PENDING/REJECTED）→ 抛 FORBIDDEN，不创建商品", async () => {
    vi.mocked(prisma.brand.findUnique).mockResolvedValue({ status: "PENDING" } as never);

    await expect(
      submitProduct("brand-1", { name: "x", category: "c", price: 1, stock: 1 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN.code });
    expect(prisma.product.create).not.toHaveBeenCalled();
  });
});

// ── 更新品牌资料 ──

describe("updateBrandProfile — 更新品牌资料", () => {
  it("name + logo → 一并更新，name 去首尾空白", async () => {
    vi.mocked(prisma.brand.update).mockResolvedValue({ id: "brand-1" } as never);

    const result = await updateBrandProfile("brand-1", { name: "  新品牌名  ", logo: "logo.png" });

    expect(result).toEqual({ success: true });
    expect(prisma.brand.update).toHaveBeenCalledWith({
      where: { id: "brand-1" },
      data: { name: "新品牌名", logo: "logo.png" },
    });
  });

  it("name 为空字符串/全空白 → 不更新 name 字段", async () => {
    vi.mocked(prisma.brand.update).mockResolvedValue({ id: "brand-1" } as never);

    await updateBrandProfile("brand-1", { name: "   " });

    expect(prisma.brand.update).toHaveBeenCalledWith({
      where: { id: "brand-1" },
      data: {},
    });
  });
});
