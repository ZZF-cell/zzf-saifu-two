// cancelExpiredOrder 单元测试 — Inngest 支付超时自动取消（竞态安全 + 库存回补）
// mock 系统边界：prisma $transaction（交互事务内 order.findUnique / order.updateMany / product.updateMany）
// 只测公共 seam：orders.service.cancelExpiredOrder
//
// 关键回归点：updateMany 状态守卫必须先于库存回补。
// 若支付回调与超时取消并发、回调抢先置 PAID，守卫命中 0 行 → 提前返回，
// 绝不允许回补已支付订单的库存（防资损）。

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    product: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// 阻断订单 service 对支付 adapter 的真实调用（import 链会经过 payment 模块，mock 掉 adapter）
vi.mock("@/shared/adapters/payment.adapter", () => ({
  paymentAdapter: { createPayment: vi.fn(), verifyCallback: vi.fn(), queryPayment: vi.fn() },
}));

import { prisma } from "@/shared/db/client";
import { cancelExpiredOrder } from "@/features/orders/orders.service";

// ── 交互事务 mock：$transaction(fn) 以 tx 对象调用 fn ──

type TxOrder = {
  findUnique: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};
type TxProduct = { updateMany: ReturnType<typeof vi.fn> };
type Tx = { order: TxOrder; product: TxProduct };

let tx: Tx;
type TransactionImpl = (fn: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
const transactionMock = prisma.$transaction as unknown as Mock<TransactionImpl>;

beforeEach(() => {
  vi.clearAllMocks();
  tx = {
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    product: { updateMany: vi.fn() },
  };
  transactionMock.mockImplementation((fn: (tx: Tx) => Promise<unknown>) => fn(tx));
});

// ── cancelExpiredOrder：超时取消 + 库存回补 ──

describe("cancelExpiredOrder — 支付超时自动取消", () => {
  it("PENDING → 守卫命中 + 回补库存 + 置 CANCELLED，返回 cancelled:true", async () => {
    tx.order.findUnique.mockResolvedValue({
      status: "PENDING",
      items: [
        { productId: "p1", qty: 2 },
        { productId: null, qty: 1 }, // 已被销毁的商品（productId 为空）应跳过回补
      ],
    });
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    const result = await cancelExpiredOrder("order-1");

    expect(result).toEqual({ cancelled: true, status: "CANCELLED" });
    // 状态守卫携带 status=PENDING，防止把已支付订单覆写成 CANCELLED
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "PENDING" },
      data: { status: "CANCELLED", cancelledAt: expect.any(Date) },
    });
    // 回补库存：productId=null 的项跳过，仅回补 p1（stock +2 / sales -2）
    expect(tx.product.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { stock: { increment: 2 }, sales: { decrement: 2 } },
    });
  });

  it("订单不存在 → no-op 返回 NOT_FOUND，不执行任何写", async () => {
    tx.order.findUnique.mockResolvedValue(null);

    const result = await cancelExpiredOrder("missing");

    expect(result).toEqual({ cancelled: false, status: "NOT_FOUND" });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });

  it("订单已支付（PAID）→ no-op 返回 PAID，绝不回补库存（防资损）", async () => {
    tx.order.findUnique.mockResolvedValue({
      status: "PAID",
      items: [{ productId: "p1", qty: 2 }],
    });

    const result = await cancelExpiredOrder("order-1");

    expect(result).toEqual({ cancelled: false, status: "PAID" });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });

  it("订单已取消（CANCELLED）→ no-op 返回 CANCELLED，不重复回补库存", async () => {
    tx.order.findUnique.mockResolvedValue({
      status: "CANCELLED",
      items: [{ productId: "p1", qty: 1 }],
    });

    const result = await cancelExpiredOrder("order-1");

    expect(result).toEqual({ cancelled: false, status: "CANCELLED" });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });

  it("竞态回归：事务内读 PENDING 但提交前被支付回调抢先（updateMany 命中 0 行）→ 返回 ALREADY_CHANGED 且绝不回补库存", async () => {
    // 关键回归用例：修复前 restoreStock 在守卫之前执行，命中 0 行时库存已被回补并提交（资损）
    tx.order.findUnique.mockResolvedValue({
      status: "PENDING",
      items: [{ productId: "p1", qty: 1 }],
    });
    tx.order.updateMany.mockResolvedValue({ count: 0 });

    const result = await cancelExpiredOrder("order-1");

    expect(result).toEqual({ cancelled: false, status: "ALREADY_CHANGED" });
    // 守卫失败 → 库存绝不能被回补（这是本次修复的核心断言）
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });

  it("多商品订单 → 逐个回补库存", async () => {
    tx.order.findUnique.mockResolvedValue({
      status: "PENDING",
      items: [
        { productId: "p1", qty: 1 },
        { productId: "p2", qty: 3 },
      ],
    });
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    await cancelExpiredOrder("order-1");

    expect(tx.product.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.product.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "p1" },
      data: { stock: { increment: 1 }, sales: { decrement: 1 } },
    });
    expect(tx.product.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "p2" },
      data: { stock: { increment: 3 }, sales: { decrement: 3 } },
    });
  });
});
