// orders.queries 单元测试 — 一键销毁的查询层隐私掩码（MAJOR 修复回归护栏）
// mock 系统边界：prisma（order.findUnique / findMany / count）
// 只测公共 seam：getOrderDetail / getOrderList
//
// 核心契约：已销毁订单在用户/品牌视图中「金额/流水号/商品名/明细」全部掩码，
// DB 原样保留（管理端与退款核验仍可查）。

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    order: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  },
}));

import { prisma } from "@/shared/db/client";
import { getOrderDetail, getOrderList } from "@/features/orders/orders.queries";

const findUniqueMock = vi.mocked(prisma.order.findUnique) as unknown as {
  mockResolvedValue: (value: unknown) => unknown;
};
const findManyMock = vi.mocked(prisma.order.findMany) as unknown as {
  mockResolvedValue: (value: unknown[]) => unknown;
};

const destroyedPrivacy = { destroyed: true, destroyedAt: "2026-08-15T00:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
});

// ── getOrderDetail：已销毁订单掩码 ──

describe("getOrderDetail — 销毁掩码", () => {
  it("已销毁订单 → total 置 0、流水号置 null、明细清空、地址掩码", async () => {
    findUniqueMock.mockResolvedValue({
      id: "order-1",
      userId: "user-1",
      total: 29900,
      status: "COMPLETED",
      shippingAddress: "encrypted-addr",
      privacy: destroyedPrivacy,
      outTradeNo: "order-1",
      paidAt: new Date(),
      shippedAt: null,
      deliveredAt: null,
      completedAt: new Date(),
      cancelledAt: null,
      refundedAt: null,
      createdAt: new Date(),
      items: [
        { id: "i1", productName: "成人用品A", price: 29900, qty: 1, productId: "p1" },
      ],
    });

    const detail = await getOrderDetail("user-1", "order-1");

    expect(detail.isDestroyed).toBe(true);
    expect(detail.total).toBe(0);
    expect(detail.outTradeNo).toBeNull();
    expect(detail.items).toEqual([]);
    expect(detail.shippingAddress).toBe("[DESTROYED]");
  });

  it("正常订单 → 金额/流水号/明细原样返回", async () => {
    findUniqueMock.mockResolvedValue({
      id: "order-2",
      userId: "user-1",
      total: 8800,
      status: "PAID",
      shippingAddress: "encrypted-addr",
      privacy: { anonymousPackaging: true },
      outTradeNo: "order-2",
      paidAt: new Date(),
      shippedAt: null,
      deliveredAt: null,
      completedAt: null,
      cancelledAt: null,
      refundedAt: null,
      createdAt: new Date(),
      items: [
        { id: "i2", productName: "硅胶产品", price: 8800, qty: 1, productId: "p2" },
      ],
    });

    const detail = await getOrderDetail("user-1", "order-2");

    expect(detail.isDestroyed).toBe(false);
    expect(detail.total).toBe(8800);
    expect(detail.outTradeNo).toBe("order-2");
    expect(detail.items).toHaveLength(1);
  });
});

// ── getOrderList：已销毁订单列表行掩码 ──

describe("getOrderList — 销毁掩码", () => {
  it("已销毁行 → 金额 0、商品名「已销毁」、件数 0", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "order-1",
        total: 29900,
        status: "COMPLETED",
        privacy: destroyedPrivacy,
        createdAt: new Date(),
        paidAt: new Date(),
        _count: { items: 2 },
        items: [{ productName: "成人用品A" }],
      },
    ]);
    vi.mocked(prisma.order.count).mockResolvedValue(1);

    const result = await getOrderList("user-1", 1, 20);

    expect(result.orders[0].isDestroyed).toBe(true);
    expect(result.orders[0].total).toBe(0);
    expect(result.orders[0].firstItemName).toBe("已销毁");
    expect(result.orders[0].itemCount).toBe(0);
  });

  it("正常行 → 金额/首件商品名/件数原样返回", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "order-2",
        total: 8800,
        status: "PAID",
        privacy: { anonymousPackaging: true },
        createdAt: new Date(),
        paidAt: new Date(),
        _count: { items: 1 },
        items: [{ productName: "硅胶产品" }],
      },
    ]);
    vi.mocked(prisma.order.count).mockResolvedValue(1);

    const result = await getOrderList("user-1", 1, 20);

    expect(result.orders[0].isDestroyed).toBe(false);
    expect(result.orders[0].total).toBe(8800);
    expect(result.orders[0].firstItemName).toBe("硅胶产品");
    expect(result.orders[0].itemCount).toBe(1);
  });
});

// ── getOrderList：?status= 多状态筛选透传（M2 订单列表状态 Tab） ──

describe("getOrderList — status 筛选", () => {
  it("传 statuses → where.status = { in: statuses }", async () => {
    findManyMock.mockResolvedValue([]);
    vi.mocked(prisma.order.count).mockResolvedValue(0);

    await getOrderList("user-1", 1, 20, ["PENDING", "CANCELLED"]);

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", status: { in: ["PENDING", "CANCELLED"] } },
      }),
    );
  });

  it("不传 statuses → 仅按 userId 筛选，不附加 status 条件", async () => {
    findManyMock.mockResolvedValue([]);
    vi.mocked(prisma.order.count).mockResolvedValue(0);

    await getOrderList("user-1", 1, 20);

    const call = vi.mocked(prisma.order.findMany).mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(call.where.userId).toBe("user-1");
    expect(call.where.status).toBeUndefined();
  });
});
