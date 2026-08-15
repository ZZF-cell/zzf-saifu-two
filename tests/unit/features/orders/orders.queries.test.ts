// orders.queries 单元测试 — 一键销毁的查询层「用户侧消失」契约
// mock 系统边界：prisma（order.findUnique / findMany / count）
// 只测公共 seam：getOrderDetail / getOrderList
//
// 核心契约：销毁（destroyedAt 非空）后，用户列表查询带 destroyedAt: null 过滤
// （订单不再出现在列表）、详情抛 ORDER_NOT_FOUND（视为不存在，不泄露存在性）；
// 管理后台不经过此查询层，数据原样保留。

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

// ── getOrderDetail：已销毁订单 → 404 ──

describe("getOrderDetail — 销毁消失", () => {
  it("已销毁订单（destroyedAt 非空）→ 抛 ORDER_NOT_FOUND，不返回任何数据", async () => {
    findUniqueMock.mockResolvedValue({
      id: "order-1",
      userId: "user-1",
      total: 29900,
      status: "COMPLETED",
      shippingAddress: "encrypted-addr",
      privacy: destroyedPrivacy,
      outTradeNo: "order-1",
      destroyedAt: new Date(),
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

    await expect(getOrderDetail("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
    });
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
      destroyedAt: null,
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

    expect(detail.total).toBe(8800);
    expect(detail.outTradeNo).toBe("order-2");
    expect(detail.items).toHaveLength(1);
  });
});

// ── getOrderList：已销毁订单从列表过滤 ──

describe("getOrderList — 销毁消失", () => {
  it("where 恒带 destroyedAt: null（已销毁订单用户列表不可见），count 用同一过滤", async () => {
    findManyMock.mockResolvedValue([]);
    vi.mocked(prisma.order.count).mockResolvedValue(0);

    await getOrderList("user-1", 1, 20);

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ destroyedAt: null }),
      }),
    );
    // 分页 total 必须用同一 where，否则分页数包含已销毁订单导致最后一页显示「无订单」
    expect(prisma.order.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ destroyedAt: null }),
      }),
    );
  });

  it("正常行 → 金额/首件商品名/件数原样返回（无需掩码，已销毁已被过滤）", async () => {
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

    expect(result.orders[0].total).toBe(8800);
    expect(result.orders[0].firstItemName).toBe("硅胶产品");
    expect(result.orders[0].itemCount).toBe(1);
  });
});

// ── getOrderList：?status= 多状态筛选透传（M2 订单列表状态 Tab） ──

describe("getOrderList — status 筛选", () => {
  it("传 statuses → where.status = { in: statuses }，且保留 destroyedAt: null 过滤", async () => {
    findManyMock.mockResolvedValue([]);
    vi.mocked(prisma.order.count).mockResolvedValue(0);

    await getOrderList("user-1", 1, 20, ["PENDING", "CANCELLED"]);

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          status: { in: ["PENDING", "CANCELLED"] },
          destroyedAt: null,
        },
      }),
    );
  });

  it("不传 statuses → 仅按 userId + destroyedAt: null 筛选，不附加 status 条件", async () => {
    findManyMock.mockResolvedValue([]);
    vi.mocked(prisma.order.count).mockResolvedValue(0);

    await getOrderList("user-1", 1, 20);

    const call = vi.mocked(prisma.order.findMany).mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(call.where.userId).toBe("user-1");
    expect(call.where.destroyedAt).toBeNull();
    expect(call.where.status).toBeUndefined();
  });

  it("传空数组（URL 全是非法状态值被白名单过滤）→ where.status = { in: [] } 显式空结果，不泄漏全量", async () => {
    findManyMock.mockResolvedValue([]);
    vi.mocked(prisma.order.count).mockResolvedValue(0);

    await getOrderList("user-1", 1, 20, []);

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", status: { in: [] }, destroyedAt: null },
      }),
    );
  });
});
