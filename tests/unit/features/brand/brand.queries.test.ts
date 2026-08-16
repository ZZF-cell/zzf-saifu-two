// brand.queries 单元测试 — 品牌归属校验 + 品牌概览（空商品零统计防护）
// mock 系统边界：prisma（brand.findUnique / product.findMany / order.count / orderItem.findMany）
// 只测公共 seam：brand.queries 的 getBrandByOwner / getBrandOverview
//
// 核心契约：
// - getBrandByOwner：按 ownerId 查品牌，无则抛 BRAND_NOT_FOUND
// - getBrandOverview：品牌无商品时直接返回零统计，绝不查全平台订单/销售额（防跨租户数据泄漏）

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    brand: { findUnique: vi.fn() },
    product: { findMany: vi.fn() },
    order: { count: vi.fn() },
    orderItem: { findMany: vi.fn() },
  },
}));

vi.mock("@/features/orders", () => ({
  ORDER_STATUS: {
    PENDING: "PENDING",
    PAID: "PAID",
    SHIPPED: "SHIPPED",
    DELIVERED: "DELIVERED",
    COMPLETED: "COMPLETED",
    CANCELLED: "CANCELLED",
    REFUND_REQUESTED: "REFUND_REQUESTED",
    REFUNDED: "REFUNDED",
  },
  getOrderListByBrand: vi.fn(),
}));

import { prisma } from "@/shared/db/client";
import { ERROR_CODES } from "@/shared/errors/errors";
import {
  getBrandByOwner,
  getBrandOverview,
} from "@/features/brand/brand.queries";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 品牌归属校验 ──

describe("getBrandByOwner — 按用户查品牌", () => {
  it("用户有品牌 → 返回品牌身份", async () => {
    vi.mocked(prisma.brand.findUnique).mockResolvedValue({
      id: "brand-1",
      name: "赛夫严选自营",
      logo: null,
      status: "APPROVED",
    } as never);

    const brand = await getBrandByOwner("user-1");

    expect(brand).toEqual({
      id: "brand-1",
      name: "赛夫严选自营",
      logo: null,
      status: "APPROVED",
    });
    expect(prisma.brand.findUnique).toHaveBeenCalledWith({
      where: { ownerId: "user-1" },
      select: { id: true, name: true, logo: true, status: true },
    });
  });

  it("用户无品牌 → 抛 BRAND_NOT_FOUND", async () => {
    vi.mocked(prisma.brand.findUnique).mockResolvedValue(null);

    await expect(getBrandByOwner("user-x")).rejects.toMatchObject({
      code: ERROR_CODES.BRAND_NOT_FOUND.code,
    });
  });
});

// ── 品牌概览 ──

describe("getBrandOverview — 品牌概览", () => {
  it("品牌无商品 → 返回零统计，绝不查询全平台订单/销售额（跨租户泄漏防护）", async () => {
    vi.mocked(prisma.brand.findUnique).mockResolvedValue({
      id: "brand-1",
      name: "新品牌",
      logo: null,
      status: "APPROVED",
      createdAt: new Date("2026-01-01"),
    } as never);
    vi.mocked(prisma.product.findMany).mockResolvedValue([]);

    const overview = await getBrandOverview("brand-1");

    expect(overview).toEqual({
      brand: expect.objectContaining({ id: "brand-1" }),
      productCount: 0,
      approvedProductCount: 0,
      orderCount: 0,
      paidRevenue: 0,
    });
    // 关键断言：order.count / orderItem.findMany 不被调用（否则会统计全平台数据）
    expect(prisma.order.count).not.toHaveBeenCalled();
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
  });

  it("品牌有商品 → 订单数按含本品牌商品的订单统计，销售额只聚合本品牌商品行（非整单金额）", async () => {
    vi.mocked(prisma.brand.findUnique).mockResolvedValue({
      id: "brand-1",
      name: "品牌A",
      logo: null,
      status: "APPROVED",
      createdAt: new Date("2026-01-01"),
    } as never);
    vi.mocked(prisma.product.findMany).mockResolvedValue([
      { id: "p1", status: "APPROVED" },
      { id: "p2", status: "PENDING" },
    ] as never);
    vi.mocked(prisma.order.count).mockResolvedValue(3);
    vi.mocked(prisma.orderItem.findMany).mockResolvedValue([
      { price: 10000, qty: 2 }, // 本品牌行：price 为行总额（10000分 = 单价50分×2）
      { price: 500, qty: 1 },
    ] as never);

    const overview = await getBrandOverview("brand-1");

    expect(overview.productCount).toBe(2);
    expect(overview.approvedProductCount).toBe(1);
    expect(overview.orderCount).toBe(3);
    expect(overview.paidRevenue).toBe(10500); // 行总额直接求和：10000 + 500（price 已含 ×qty，不再乘 qty）
    // 品牌概览必须查 OrderItem 行聚合而非 Order._sum.total（后者含其他品牌金额）
    expect(prisma.order.count).toHaveBeenCalledWith({
      where: {
        items: { some: { productId: { in: ["p1", "p2"] } } },
        destroyedAt: null, // M8：已销毁订单不计入品牌概览
      },
    });
    expect(prisma.orderItem.findMany).toHaveBeenCalledWith({
      where: {
        productId: { in: ["p1", "p2"] },
        order: {
          status: { in: ["PAID", "SHIPPED", "DELIVERED", "COMPLETED"] },
          destroyedAt: null, // M8：已销毁订单的收入不计入销售额
        },
      },
      select: { price: true },
    });
  });

  it("M8：已销毁订单不计入订单数/销售额（destroyedAt 过滤，与品牌订单列表同口径）", async () => {
    vi.mocked(prisma.brand.findUnique).mockResolvedValue({
      id: "brand-1",
      name: "品牌A",
      logo: null,
      status: "APPROVED",
      createdAt: new Date("2026-01-01"),
    } as never);
    vi.mocked(prisma.product.findMany).mockResolvedValue([
      { id: "p1", status: "APPROVED" },
    ] as never);
    vi.mocked(prisma.order.count).mockResolvedValue(2);
    vi.mocked(prisma.orderItem.findMany).mockResolvedValue([
      { price: 9900 },
    ] as never);

    await getBrandOverview("brand-1");

    // 已销毁订单在查询边界就被 destroyedAt: null 排除——断言两条查询都带该过滤条件
    expect(prisma.order.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ destroyedAt: null }),
      }),
    );
    expect(prisma.orderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          order: expect.objectContaining({ destroyedAt: null }),
        }),
      }),
    );
  });
});
