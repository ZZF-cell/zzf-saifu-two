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
    inviteCode: { findMany: vi.fn(), count: vi.fn() },
  },
}));

// 地址解密桩：返回原文（测试关注地址解析/脱敏逻辑，不依赖真实加解密）
vi.mock("@/shared/utils/crypto", () => ({
  decrypt: (s: string) => s,
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
import { getDashboardStats, getAdminInviteCodes, getAdminOrders } from "@/features/admin/admin.queries";

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

// ── 邀请码列表（L6 DISABLED 作废态） ──

describe("getAdminInviteCodes — 邀请码列表（DISABLED 作废态）", () => {
  it("DISABLED 为落库态，不受 EXPIRED 推导覆盖（即使 expiresAt 已过仍显示「已作废」）", async () => {
    vi.mocked(prisma.inviteCode.findMany).mockResolvedValue([
      {
        id: "c1",
        code: "INV-AAAA-1111",
        status: "DISABLED",
        createdBy: "admin-1",
        usedBy: null,
        createdAt: new Date("2026-08-01T00:00:00Z"),
        usedAt: null,
        expiresAt: new Date("2020-01-01T00:00:00Z"), // 已过期，但 DISABLED 优先于 EXPIRED 推导
      },
    ] as never);
    vi.mocked(prisma.inviteCode.count).mockResolvedValue(1);

    const result = await getAdminInviteCodes({ page: 1, pageSize: 20 });

    expect(result.items[0].status).toBe("DISABLED");
  });

  it("status=DISABLED 筛选 → 直查 DISABLED（findMany + count 同 where）", async () => {
    vi.mocked(prisma.inviteCode.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.inviteCode.count).mockResolvedValue(0);

    await getAdminInviteCodes({ page: 1, pageSize: 20, status: "DISABLED" });

    expect(prisma.inviteCode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "DISABLED" } }),
    );
    expect(prisma.inviteCode.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "DISABLED" } }),
    );
  });
});

// ── 订单查询（默认隐藏已销毁 / 按订单号查已销毁 / destroyed=only 筛选） ──

describe("getAdminOrders — 订单查询（已销毁按需查询）", () => {
  it("默认排除已销毁订单：where.destroyedAt = null（隐私严谨，已销毁需按需查询）", async () => {
    vi.mocked(prisma.order.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.order.count).mockResolvedValue(0);

    await getAdminOrders({ page: 1, pageSize: 20 });

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { destroyedAt: null } }),
    );
    expect(prisma.order.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: { destroyedAt: null } }),
    );
  });

  it('destroyed="only" → 只看已销毁：where.destroyedAt = { not: null }', async () => {
    vi.mocked(prisma.order.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.order.count).mockResolvedValue(0);

    await getAdminOrders({ page: 1, pageSize: 20, destroyed: "only" });

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { destroyedAt: { not: null } } }),
    );
  });

  it("orderId 优先：where 只含 id 精确匹配，忽略 status/destroyed（查已销毁订单入口）", async () => {
    vi.mocked(prisma.order.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.order.count).mockResolvedValue(0);

    await getAdminOrders({
      page: 1,
      pageSize: 20,
      orderId: "ord-1",
      status: "COMPLETED",
      destroyed: "only",
    });

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ord-1" } }),
    );
    // where 只含 id：不混入 destroyedAt/status（避免破坏精确查单笔的语义）
    const callWhere = (prisma.order.findMany as Mock).mock.calls[0]![0]!.where;
    expect(Object.keys(callWhere)).toEqual(["id"]);
  });

  it('status="TO_SHIP" → 排除已销毁 + status in [PAID, SHIPPED]（与看板待发货同口径）', async () => {
    vi.mocked(prisma.order.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.order.count).mockResolvedValue(0);

    await getAdminOrders({ page: 1, pageSize: 20, status: "TO_SHIP" });

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { destroyedAt: null, status: { in: ["PAID", "SHIPPED"] } },
      }),
    );
  });

  it("返回行透出原始信息：items/privacy/destroyedAt；已销毁订单地址擦除 → recipient=null", async () => {
    vi.mocked(prisma.order.findMany).mockResolvedValue([
      {
        id: "ord-1",
        userId: "u-1",
        total: 9900,
        status: "COMPLETED",
        createdAt: new Date("2026-08-01T00:00:00Z"),
        paidAt: new Date("2026-08-01T00:00:00Z"),
        destroyedAt: new Date("2026-08-02T00:00:00Z"),
        privacy: { anonymousPackaging: true, hideProductName: false, destroyed: true },
        shippingAddress: "[DESTROYED]",
        user: { nickname: "alice" },
        items: [
          { productName: "商品A", qty: 2, price: 3000 },
          { productName: "商品B", qty: 1, price: 3900 },
        ],
      },
    ] as never);
    vi.mocked(prisma.order.count).mockResolvedValue(1);

    const result = await getAdminOrders({ page: 1, pageSize: 20, destroyed: "only" });
    const row = result.orders[0];

    expect(row.isDestroyed).toBe(true);
    expect(row.destroyedAt).toBeInstanceOf(Date);
    expect(row.recipient).toBeNull(); // [DESTROYED] 无法解析 → 地址已擦除（隐私承诺）
    expect(row.items).toEqual([
      { productName: "商品A", qty: 2, price: 3000 },
      { productName: "商品B", qty: 1, price: 3900 },
    ]);
    expect(row.privacy?.anonymousPackaging).toBe(true);
    expect(row.privacy?.destroyed).toBe(true);
    expect(row.firstItemName).toBe("商品A");
    expect(row.itemCount).toBe(3); // qty 累加 2+1
  });

  it("正常订单：地址解密取收货人 + 手机号脱敏展示", async () => {
    vi.mocked(prisma.order.findMany).mockResolvedValue([
      {
        id: "ord-2",
        userId: "u-2",
        total: 5000,
        status: "PAID",
        createdAt: new Date("2026-08-01T00:00:00Z"),
        paidAt: null,
        destroyedAt: null,
        privacy: null,
        shippingAddress: JSON.stringify({ name: "张三", phone: "13800138000", city: "北京" }),
        user: { nickname: "bob" },
        items: [{ productName: "商品C", qty: 1, price: 5000 }],
      },
    ] as never);
    vi.mocked(prisma.order.count).mockResolvedValue(1);

    const result = await getAdminOrders({ page: 1, pageSize: 20 });
    const row = result.orders[0];

    expect(row.isDestroyed).toBe(false);
    expect(row.destroyedAt).toBeNull();
    expect(row.recipient).toEqual({ name: "张三", phone: "138****8000", city: "北京" });
    expect(row.privacy).toBeNull();
  });
});
