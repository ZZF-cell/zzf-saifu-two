// destroyOrder 单元测试 — 一键销毁（隐私擦除，用户/品牌侧记录消失、后台保留）
// mock 系统边界：prisma order.findUnique（事务外）+ $transaction（交互事务内 order.updateMany / auditLog.create）
// 只测公共 seam：orders.service.destroyOrder
//
// 关键契约：
//   F1 幂等守卫 — updateMany where { id, destroyedAt: null }：已销毁订单命中 0 行 →
//       静默 no-op（双击/重试不重复写审计、不覆盖已擦除状态）
//   F2 归属失败统一 404（防订单号枚举）
//   仅 COMPLETED/CANCELLED/REFUNDED 可销毁（isDestroyable）
//   E3 隐私合并 — privacy 保留原 anonymousPackaging/hideProductName，仅追加 destroyed 标记
//   审计快照不含配送地址（隐私承诺：地址随销毁擦除，审计不回存 PII）

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    order: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// 阻断订单 service 对支付 adapter 的真实调用（import 链会经过 payment 模块，mock 掉 adapter）
vi.mock("@/shared/adapters/payment.adapter", () => ({
  paymentAdapter: { createPayment: vi.fn(), verifyCallback: vi.fn(), queryPayment: vi.fn() },
}));

import { prisma } from "@/shared/db/client";
import { destroyOrder } from "@/features/orders/orders.service";

// ── 交互事务 mock：$transaction(fn) 以 tx 对象调用 fn ──

type TxOrder = {
  updateMany: ReturnType<typeof vi.fn>;
};
type Tx = { order: TxOrder; auditLog: { create: ReturnType<typeof vi.fn> } };

let tx: Tx;
type TransactionImpl = (fn: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
const transactionMock = prisma.$transaction as unknown as Mock<TransactionImpl>;

const findUniqueMock = prisma.order.findUnique as unknown as {
  mockResolvedValue: (value: unknown) => unknown;
};

/** destroyOrder 事务外 findUnique 返回的快照（select 子集：id/userId/status/total/privacy/items） */
function snapshot(
  overrides: Partial<{
    userId: string;
    status: string;
    privacy: Record<string, unknown> | null;
    items: { id: string; productId: string; productName: string; qty: number; price: number }[];
  }> = {},
) {
  return {
    id: "order-1",
    userId: "user-1",
    status: "COMPLETED",
    total: 29900,
    privacy: { anonymousPackaging: true, hideProductName: true },
    items: [{ id: "oi-1", productId: "p1", productName: "商品1", qty: 1, price: 29900 }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tx = {
    order: { updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  transactionMock.mockImplementation((fn: (tx: Tx) => Promise<unknown>) => fn(tx));
});

describe("destroyOrder — 一键销毁（隐私擦除）", () => {
  it("订单不存在 → 抛 ORDER_NOT_FOUND，不执行任何写", async () => {
    findUniqueMock.mockResolvedValue(null);

    await expect(destroyOrder("user-1", "order-x")).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
    });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("订单不属于当前用户 → 统一 404 ORDER_NOT_FOUND（防订单号枚举，F2）", async () => {
    findUniqueMock.mockResolvedValue(snapshot({ userId: "user-other" }));

    await expect(destroyOrder("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
      statusCode: 404,
    });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("不可销毁状态（PENDING）→ 抛 ORDER_STATUS_INVALID，不执行任何写", async () => {
    findUniqueMock.mockResolvedValue(snapshot({ status: "PENDING" }));

    await expect(destroyOrder("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_STATUS_INVALID",
    });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("COMPLETED → 守卫命中 → 擦除地址/追加 destroyed 标记 + 审计 DESTROYED（含快照不含地址）", async () => {
    findUniqueMock.mockResolvedValue(snapshot());
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    await destroyOrder("user-1", "order-1");

    // 幂等守卫携带 destroyedAt:null，防止重复销毁覆盖已擦除状态
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", destroyedAt: null },
      data: expect.objectContaining({
        shippingAddress: "[DESTROYED]",
        // E3 隐私合并：保留原 anonymousPackaging/hideProductName，仅追加 destroyed 标记
        privacy: {
          anonymousPackaging: true,
          hideProductName: true,
          destroyed: true,
          destroyedAt: expect.any(String),
        },
        destroyedAt: expect.any(Date),
      }),
    });
    // 审计快照记录状态/金额/商品行，不含配送地址（隐私承诺：地址不回存审计）
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        targetType: "Order",
        targetId: "order-1",
        action: "DESTROYED",
        operatorId: "user-1",
        snapshot: {
          status: "COMPLETED",
          total: 29900,
          itemCount: 1,
          items: [{ id: "oi-1", productId: "p1", productName: "商品1", qty: 1, price: 29900 }],
        },
      },
    });
  });

  it("F1 幂等守卫回归：已销毁订单（updateMany 命中 0 行）→ 静默 no-op，不重复写审计", async () => {
    findUniqueMock.mockResolvedValue(snapshot());
    // 并发重复销毁（双击/重试）：第一次销毁已置 destroyedAt，第二次 updateMany 命中 0 行
    tx.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(destroyOrder("user-1", "order-1")).resolves.toBeUndefined();

    // 幂等 no-op：不抛错、不重复写审计、不覆盖已擦除状态
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", destroyedAt: null },
      data: expect.any(Object),
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
