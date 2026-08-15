// admin.queries 单元测试 — 数据看板商品口径（在售/下架/待审分立）
// mock 系统边界：prisma（user/brand/product/order 聚合）
// 只测公共 seam：getDashboardStats
//
// 核心契约（在售口径）：
// - 「在售商品」只统计 APPROVED，已下架/已拒绝/已撤回不计入
// - 「已下架」独立统计 DELISTED
// - 品类商品数分布图与在售卡同口径（只聚合 APPROVED），避免图（含下架）与卡（在售）矛盾

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    user: { count: vi.fn() },
    brand: { count: vi.fn() },
    product: { count: vi.fn(), groupBy: vi.fn() },
    order: { count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
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
}));

import { prisma } from "@/shared/db/client";
import { getDashboardStats } from "@/features/admin/admin.queries";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getDashboardStats — 数据看板", () => {
  it("商品口径：在售仅 APPROVED、下架单列、品类图与在售卡同口径", async () => {
    // product.count 三次调用按 where.status 分发：APPROVED→3、DELISTED→1、PENDING→2
    // 显式 Mock 类型绕过 Prisma PrismaPromise 返回类型约束（测试关注分发逻辑非类型）
    const productCountMock = prisma.product.count as unknown as Mock<
      (args?: { where?: { status?: string } }) => Promise<number>
    >;
    productCountMock.mockImplementation((args) => {
      const status = args?.where?.status;
      if (status === "APPROVED") return Promise.resolve(3);
      if (status === "DELISTED") return Promise.resolve(1);
      if (status === "PENDING") return Promise.resolve(2);
      return Promise.resolve(0);
    });
    vi.mocked(prisma.user.count).mockResolvedValue(10);
    vi.mocked(prisma.brand.count).mockResolvedValue(4);
    vi.mocked(prisma.order.count).mockResolvedValue(20);
    vi.mocked(prisma.order.aggregate).mockResolvedValue({ _sum: { total: 9900 } } as never);
    vi.mocked(prisma.order.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.product.groupBy).mockResolvedValue([
      { category: "情趣用品", _count: { _all: 2 } },
    ] as never);
    vi.mocked(prisma.order.findMany).mockResolvedValue([] as never);

    const stats = await getDashboardStats();

    expect(stats.approvedProductCount).toBe(3);
    expect(stats.delistedProductCount).toBe(1);
    expect(stats.pendingProductCount).toBe(2);
    expect(stats.paidRevenue).toBe(9900);

    // 在售口径：三种商品 count 分别带状态过滤，绝无全量 count
    expect(prisma.product.count).toHaveBeenCalledWith({ where: { status: "APPROVED" } });
    expect(prisma.product.count).toHaveBeenCalledWith({ where: { status: "DELISTED" } });
    expect(prisma.product.count).toHaveBeenCalledWith({ where: { status: "PENDING" } });
    expect(prisma.product.count).not.toHaveBeenCalledWith();

    // 品类分布图与「在售商品」卡同一口径：只聚合 APPROVED
    expect(prisma.product.groupBy).toHaveBeenCalledWith({
      by: ["category"],
      where: { status: "APPROVED" },
      _count: { _all: true },
    });
    expect(stats.categoryDist).toEqual([{ category: "情趣用品", count: 2 }]);
  });

  it("无商品时各商品口径为 0，不误报", async () => {
    vi.mocked(prisma.product.count).mockResolvedValue(0);
    vi.mocked(prisma.user.count).mockResolvedValue(0);
    vi.mocked(prisma.brand.count).mockResolvedValue(0);
    vi.mocked(prisma.order.count).mockResolvedValue(0);
    vi.mocked(prisma.order.aggregate).mockResolvedValue({ _sum: { total: null } } as never);
    vi.mocked(prisma.order.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.product.groupBy).mockResolvedValue([] as never);
    vi.mocked(prisma.order.findMany).mockResolvedValue([] as never);

    const stats = await getDashboardStats();

    expect(stats.approvedProductCount).toBe(0);
    expect(stats.delistedProductCount).toBe(0);
    expect(stats.pendingProductCount).toBe(0);
    expect(stats.paidRevenue).toBe(0);
    expect(stats.categoryDist).toEqual([]);
  });
});
