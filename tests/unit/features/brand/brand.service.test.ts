// brand.service 单元测试 — 品牌归属校验 + 商品提交流程（价格转分 + 待质检）
// mock 系统边界：prisma（brand.findUnique / product.create / brand.update）
// 只测公共 seam：brand.service 的 getBrandByOwner / submitProduct / updateBrandProfile
//
// 核心契约：提交商品要求品牌已 APPROVED（FORBIDDEN），价格必须以元→分存储，
// 新商品默认 status=PENDING 待平台质检。

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    brand: { findUnique: vi.fn(), update: vi.fn() },
    product: { create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "@/shared/db/client";
import { ERROR_CODES } from "@/shared/errors/errors";
import {
  submitProduct,
  withdrawProduct,
  delistProduct,
  relistProduct,
  updateProduct,
  updateBrandProfile,
} from "@/features/brand/brand.service";

// ── 交互事务 mock：$transaction(fn) 以 tx 对象调用 fn（生命周期操作全部走事务） ──

type Tx = {
  product: { updateMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

let tx: Tx;
type TransactionImpl = (fn: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
const transactionMock = prisma.$transaction as unknown as Mock<TransactionImpl>;

beforeEach(() => {
  vi.clearAllMocks();
  tx = {
    product: { updateMany: vi.fn(), findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  transactionMock.mockImplementation((fn: (tx: Tx) => Promise<unknown>) => fn(tx));
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
      subCategory: "智能健康监测",
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
        subCategory: "智能健康监测",
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

  it("传入 images → images 数组原样写库（OSS URL）", async () => {
    vi.mocked(prisma.brand.findUnique).mockResolvedValue({ status: "APPROVED" } as never);
    vi.mocked(prisma.product.create).mockResolvedValue({ id: "product-1" } as never);

    await submitProduct("brand-1", {
      name: "静音震动器",
      category: "智能设备",
      subCategory: "智能健康监测",
      price: 199,
      stock: 10,
      images: ["https://img.example.com/product/a.jpg", "https://img.example.com/product/b.jpg"],
    });

    const createArgs = vi.mocked(prisma.product.create).mock.calls[0][0] as {
      data: { images: unknown };
    };
    expect(createArgs.data.images).toEqual([
      "https://img.example.com/product/a.jpg",
      "https://img.example.com/product/b.jpg",
    ]);
  });

  it("传入 certificates → 证书数组原样写库（随商品提交）", async () => {
    vi.mocked(prisma.brand.findUnique).mockResolvedValue({ status: "APPROVED" } as never);
    vi.mocked(prisma.product.create).mockResolvedValue({ id: "product-1" } as never);

    await submitProduct("brand-1", {
      name: "静音震动器",
      category: "智能设备",
      subCategory: "智能健康监测",
      price: 199,
      stock: 10,
      certificates: [
        { url: "https://img.example.com/cert/a.pdf", name: "质检报告.pdf", mime: "application/pdf" },
        { url: "https://img.example.com/cert/b.jpg", name: "3C 认证.jpg", mime: "image/jpeg" },
      ],
    });

    const createArgs = vi.mocked(prisma.product.create).mock.calls[0][0] as {
      data: { certificates: unknown };
    };
    expect(createArgs.data.certificates).toEqual([
      { url: "https://img.example.com/cert/a.pdf", name: "质检报告.pdf", mime: "application/pdf" },
      { url: "https://img.example.com/cert/b.jpg", name: "3C 认证.jpg", mime: "image/jpeg" },
    ]);
  });

  it("不传 certificates → 落库空数组（默认）", async () => {
    vi.mocked(prisma.brand.findUnique).mockResolvedValue({ status: "APPROVED" } as never);
    vi.mocked(prisma.product.create).mockResolvedValue({ id: "product-1" } as never);

    await submitProduct("brand-1", {
      name: "无证书商品",
      category: "测试",
      subCategory: "测试子类",
      price: 10,
      stock: 1,
    });

    const createArgs = vi.mocked(prisma.product.create).mock.calls[0][0] as {
      data: { certificates: unknown };
    };
    expect(createArgs.data.certificates).toEqual([]);
  });

  it("不传 images → 落库空数组（默认）", async () => {
    vi.mocked(prisma.brand.findUnique).mockResolvedValue({ status: "APPROVED" } as never);
    vi.mocked(prisma.product.create).mockResolvedValue({ id: "product-1" } as never);

    await submitProduct("brand-1", {
      name: "无图商品",
      category: "测试",
      subCategory: "测试子类",
      price: 10,
      stock: 1,
    });

    const createArgs = vi.mocked(prisma.product.create).mock.calls[0][0] as {
      data: { images: unknown };
    };
    expect(createArgs.data.images).toEqual([]);
  });

  it("价格 0.5 元 → 精确转 50 分（无浮点误差）", async () => {
    vi.mocked(prisma.brand.findUnique).mockResolvedValue({ status: "APPROVED" } as never);
    vi.mocked(prisma.product.create).mockResolvedValue({ id: "product-2" } as never);

    await submitProduct("brand-1", {
      name: "润滑剂",
      category: "身体护理",
      subCategory: "身体乳/润体",
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
      subCategory: "测试子类",
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
      submitProduct("brand-x", { name: "x", category: "c", subCategory: "c", price: 1, stock: 1 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.BRAND_NOT_FOUND.code });
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it("品牌未过审（PENDING/REJECTED）→ 抛 FORBIDDEN，不创建商品", async () => {
    vi.mocked(prisma.brand.findUnique).mockResolvedValue({ status: "PENDING" } as never);

    await expect(
      submitProduct("brand-1", { name: "x", category: "c", subCategory: "c", price: 1, stock: 1 }),
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

// ── 商品生命周期：撤回 / 下架 / 重新上架 / 编辑（where 强制 brandId 归属） ──

describe("withdrawProduct — 撤回待审提交（PENDING → WITHDRAWN）", () => {
  it("PENDING 商品 → 置 WITHDRAWN + version bump + 审计 PRODUCT_WITHDRAWN", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    await withdrawProduct("brand-1", "product-1", "user-1");

    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", brandId: "brand-1", status: "PENDING" },
      data: { status: "WITHDRAWN", version: { increment: 1 } },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Product", targetId: "product-1", action: "PRODUCT_WITHDRAWN", operatorId: "user-1" },
    });
  });

  it("守卫 0 行但商品属于其他品牌 → 抛 403 BRAND_NOT_OWNED", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 0 });
    tx.product.findUnique.mockResolvedValue({ brandId: "brand-other" });

    await expect(withdrawProduct("brand-1", "product-1", "user-1")).rejects.toMatchObject({
      code: ERROR_CODES.BRAND_NOT_OWNED.code,
      statusCode: 403,
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("守卫 0 行且商品不存在 → 抛 404 PRODUCT_NOT_FOUND", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 0 });
    tx.product.findUnique.mockResolvedValue(null);

    await expect(withdrawProduct("brand-1", "product-x", "user-1")).rejects.toMatchObject({
      code: ERROR_CODES.PRODUCT_NOT_FOUND.code,
    });
  });

  it("守卫 0 行且商品非 PENDING（已上架）→ 抛 409 PRODUCT_STATUS_INVALID", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 0 });
    tx.product.findUnique.mockResolvedValue({ brandId: "brand-1" });

    await expect(withdrawProduct("brand-1", "product-1", "user-1")).rejects.toMatchObject({
      code: ERROR_CODES.PRODUCT_STATUS_INVALID.code,
      statusCode: 409,
    });
  });
});

describe("delistProduct — 品牌下架（APPROVED → DELISTED）", () => {
  it("APPROVED 商品 → 置 DELISTED + 审计（where 带 brandId）", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    await delistProduct("brand-1", "product-1", "user-1");

    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", brandId: "brand-1", status: "APPROVED" },
      data: { status: "DELISTED", version: { increment: 1 } },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Product", targetId: "product-1", action: "PRODUCT_DELISTED", operatorId: "user-1" },
    });
  });

  it("商品属于其他品牌（守卫 0 行）→ 抛 403 BRAND_NOT_OWNED", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 0 });
    tx.product.findUnique.mockResolvedValue({ brandId: "brand-other" });

    await expect(delistProduct("brand-1", "product-1", "user-1")).rejects.toMatchObject({
      code: ERROR_CODES.BRAND_NOT_OWNED.code,
    });
  });
});

describe("relistProduct — 品牌重新上架（DELISTED → APPROVED，不重质检）", () => {
  it("DELISTED 商品 → 置 APPROVED + 审计 PRODUCT_RELISTED", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    await relistProduct("brand-1", "product-1", "user-1");

    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", brandId: "brand-1", status: "DELISTED" },
      data: { status: "APPROVED", version: { increment: 1 } },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { targetType: "Product", targetId: "product-1", action: "PRODUCT_RELISTED", operatorId: "user-1" },
    });
  });

  it("非 DELISTED（如 WITHDRAWN）→ 抛 409，WITHDRAWN 不会误上架", async () => {
    tx.product.updateMany.mockResolvedValue({ count: 0 });
    tx.product.findUnique.mockResolvedValue({ brandId: "brand-1" });

    await expect(relistProduct("brand-1", "product-1", "user-1")).rejects.toMatchObject({
      code: ERROR_CODES.PRODUCT_STATUS_INVALID.code,
    });
  });
});

describe("updateProduct — 品牌编辑商品（归属守卫 + 状态机）", () => {
  const baseOld = {
    id: "product-1",
    brandId: "brand-1",
    name: "静音震动器",
    category: "智能设备",
    subCategory: "智能健康监测",
    description: "低噪 50dB",
    images: [],
    certificates: [],
    specs: {},
    status: "APPROVED",
  };

  it("改基本信息（name）→ 回 PENDING 重审 + 审计 PRODUCT_UPDATE_REVIEW", async () => {
    tx.product.findUnique.mockResolvedValue(baseOld);
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    const result = await updateProduct("brand-1", "product-1", { name: "静音震动器 Pro" }, "user-1");

    expect(result).toEqual({ id: "product-1", status: "PENDING" });
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", brandId: "brand-1", status: "APPROVED" },
      data: { name: "静音震动器 Pro", status: "PENDING", version: { increment: 1 } },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "PRODUCT_UPDATE_REVIEW" }),
    });
  });

  it("仅改检测证书（certificates）→ 回 PENDING 重审（证书属基本信息，改证书需重审）", async () => {
    tx.product.findUnique.mockResolvedValue(baseOld);
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    const result = await updateProduct(
      "brand-1",
      "product-1",
      {
        certificates: [
          { url: "https://img.example.com/cert/new.pdf", name: "新质检报告.pdf", mime: "application/pdf" },
        ],
      },
      "user-1",
    );

    expect(result).toEqual({ id: "product-1", status: "PENDING" });
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", brandId: "brand-1", status: "APPROVED" },
      data: expect.objectContaining({
        certificates: [
          { url: "https://img.example.com/cert/new.pdf", name: "新质检报告.pdf", mime: "application/pdf" },
        ],
        status: "PENDING",
        version: { increment: 1 },
      }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "PRODUCT_UPDATE_REVIEW" }),
    });
  });

  it("仅改运营信息（price）→ 状态不变 + 价格元→分 + 审计 PRODUCT_UPDATE", async () => {
    tx.product.findUnique.mockResolvedValue(baseOld);
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    const result = await updateProduct("brand-1", "product-1", { price: 199 }, "user-1");

    expect(result).toEqual({ id: "product-1", status: "APPROVED" });
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "product-1", brandId: "brand-1", status: "APPROVED" },
      data: { price: 19900, version: { increment: 1 } },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "PRODUCT_UPDATE" }),
    });
  });

  it("WITHDRAWN 任意修改 → 回 PENDING 重新提交 + 审计 PRODUCT_UPDATE_RESUBMIT", async () => {
    tx.product.findUnique.mockResolvedValue({ ...baseOld, status: "WITHDRAWN" });
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    const result = await updateProduct("brand-1", "product-1", { stock: 20 }, "user-1");

    expect(result).toEqual({ id: "product-1", status: "PENDING" });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "PRODUCT_UPDATE_RESUBMIT" }),
    });
  });

  it("商品属于其他品牌 → 抛 403 BRAND_NOT_OWNED（读取即拒绝，不进入更新）", async () => {
    tx.product.findUnique.mockResolvedValue({ ...baseOld, brandId: "brand-other" });

    await expect(
      updateProduct("brand-1", "product-1", { name: "越权改名" }, "user-1"),
    ).rejects.toMatchObject({
      code: ERROR_CODES.BRAND_NOT_OWNED.code,
    });
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("商品不存在 → 抛 404 PRODUCT_NOT_FOUND", async () => {
    tx.product.findUnique.mockResolvedValue(null);

    await expect(
      updateProduct("brand-1", "product-x", { name: "x" }, "user-1"),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PRODUCT_NOT_FOUND.code,
    });
  });

  it("读后状态并发变更（守卫 0 行）→ 抛 409，不覆盖他人决策", async () => {
    tx.product.findUnique.mockResolvedValue(baseOld);
    tx.product.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      updateProduct("brand-1", "product-1", { name: "并发改动" }, "user-1"),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PRODUCT_STATUS_INVALID.code,
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
