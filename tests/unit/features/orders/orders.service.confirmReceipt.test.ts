// confirmReceipt 单元测试 — 用户确认收货（DELIVERED → COMPLETED）
// mock 系统边界：prisma $transaction（交互事务内 order.findUnique / order.updateMany）+ 事务外 order.findUnique
// 只测公共 seam：orders.service.confirmReceipt
//
// 关键契约：归属校验（不存在 404 / 非本人 403）+ 状态守卫（仅 DELIVERED 可确认，
// updateMany 带 status=DELIVERED，与后台 completeOrder / 自动确认并发只命中一次，防覆写）。

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// 阻断订单 service 对支付 adapter 的真实调用（import 链会经过 payment 模块，mock 掉 adapter）
vi.mock("@/shared/adapters/payment.adapter", () => ({
  paymentAdapter: { createPayment: vi.fn(), verifyCallback: vi.fn(), queryPayment: vi.fn() },
}));

import { prisma } from "@/shared/db/client";
import { confirmReceipt } from "@/features/orders/orders.service";

// ── 交互事务 mock：$transaction(fn) 以 tx 对象调用 fn ──

type TxOrder = {
  findUnique: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};
type Tx = { order: TxOrder; auditLog: { create: ReturnType<typeof vi.fn> } };

let tx: Tx;
type TransactionImpl = (fn: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
const transactionMock = prisma.$transaction as unknown as Mock<TransactionImpl>;

const findUniqueMock = prisma.order.findUnique as unknown as {
  mockResolvedValue: (value: unknown) => unknown;
};

beforeEach(() => {
  vi.clearAllMocks();
  tx = {
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  transactionMock.mockImplementation((fn: (tx: Tx) => Promise<unknown>) => fn(tx));
});

// ── confirmReceipt：用户确认收货 ──

describe("confirmReceipt — 用户确认收货", () => {
  it("订单不存在 → 抛 ORDER_NOT_FOUND，不执行任何写", async () => {
    findUniqueMock.mockResolvedValue(null);

    await expect(confirmReceipt("user-1", "order-x")).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
    });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("订单不属于当前用户 → 统一 404 ORDER_NOT_FOUND（防订单号枚举，F2）", async () => {
    findUniqueMock.mockResolvedValue({ id: "order-1", userId: "user-other", status: "DELIVERED" });

    await expect(confirmReceipt("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
      statusCode: 404,
    });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("非 DELIVERED（如 PAID）→ 抛 ORDER_STATUS_INVALID，提示先等待送达", async () => {
    findUniqueMock.mockResolvedValue({ id: "order-1", userId: "user-1", status: "PAID" });

    await expect(confirmReceipt("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_STATUS_INVALID",
    });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("DELIVERED → 守卫命中 → 置 COMPLETED + completedAt + 审计 CONFIRMED_RECEIPT", async () => {
    findUniqueMock.mockResolvedValue({ id: "order-1", userId: "user-1", status: "DELIVERED" });
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    await confirmReceipt("user-1", "order-1");

    // 状态守卫携带 status=DELIVERED，防止把非已送达订单覆写成 COMPLETED
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "DELIVERED" },
      data: { status: "COMPLETED", completedAt: expect.any(Date) },
    });
    // 审计与状态变更同事务（全链路可追溯）
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        targetType: "Order",
        targetId: "order-1",
        action: "CONFIRMED_RECEIPT",
        operatorId: "user-1",
        snapshot: { before: "DELIVERED", after: "COMPLETED" },
      },
    });
  });

  it("竞态回归：事务内状态已变（updateMany 命中 0 行，被后台/自动确认抢先）→ 抛 ORDER_STATUS_INVALID", async () => {
    findUniqueMock.mockResolvedValue({ id: "order-1", userId: "user-1", status: "DELIVERED" });
    tx.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(confirmReceipt("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_STATUS_INVALID",
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
