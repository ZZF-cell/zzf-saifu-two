// autoCompleteDeliveredOrder 单元测试 — 送达 7 天自动确认收货（Inngest cron 兜底）
// mock 系统边界：prisma $transaction（交互事务内 order.findUnique / order.updateMany）
// 只测公共 seam：orders.service.autoCompleteDeliveredOrder
//
// 关键契约：系统发起无用户校验；非 DELIVERED（含不存在）静默 no-op 不抛错不重试；
// updateMany 带 status=DELIVERED 状态守卫，与用户 confirmReceipt / 后台 completeOrder
// 并发只命中一次，绝不把已变更订单覆写成 COMPLETED。

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
import { autoCompleteDeliveredOrder } from "@/features/orders/orders.service";

// ── 交互事务 mock：$transaction(fn) 以 tx 对象调用 fn ──

type TxOrder = {
  findUnique: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};
type Tx = { order: TxOrder; auditLog: { create: ReturnType<typeof vi.fn> } };

let tx: Tx;
type TransactionImpl = (fn: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
const transactionMock = prisma.$transaction as unknown as Mock<TransactionImpl>;

beforeEach(() => {
  vi.clearAllMocks();
  tx = {
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  transactionMock.mockImplementation((fn: (tx: Tx) => Promise<unknown>) => fn(tx));
});

// ── autoCompleteDeliveredOrder：送达 7 天自动确认 ──

describe("autoCompleteDeliveredOrder — 自动确认收货", () => {
  it("DELIVERED → 守卫命中 → 置 COMPLETED + completedAt + 审计 AUTO_COMPLETED（operatorId null）", async () => {
    tx.order.findUnique.mockResolvedValue({ status: "DELIVERED" });
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    const result = await autoCompleteDeliveredOrder("order-1");

    expect(result).toEqual({ completed: true, status: "COMPLETED" });
    // 状态守卫携带 status=DELIVERED，防止把非已送达订单覆写成 COMPLETED
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "DELIVERED" },
      data: { status: "COMPLETED", completedAt: expect.any(Date) },
    });
    // 系统动作审计：operatorId null（与支付回调 markOrderPaid 的 PAID 审计一致）
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        targetType: "Order",
        targetId: "order-1",
        action: "AUTO_COMPLETED",
        operatorId: null,
        snapshot: { before: "DELIVERED", after: "COMPLETED" },
      },
    });
  });

  it("订单不存在 → 静默 no-op 返回 NOT_FOUND，不抛错、不写审计", async () => {
    tx.order.findUnique.mockResolvedValue(null);

    const result = await autoCompleteDeliveredOrder("missing");

    expect(result).toEqual({ completed: false, status: "NOT_FOUND" });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("非 DELIVERED（如 PAID）→ 静默 no-op 返回 PAID，不执行任何写", async () => {
    tx.order.findUnique.mockResolvedValue({ status: "PAID" });

    const result = await autoCompleteDeliveredOrder("order-1");

    expect(result).toEqual({ completed: false, status: "PAID" });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("非 DELIVERED（如 COMPLETED 已确认）→ 静默 no-op 返回 COMPLETED，不重复写", async () => {
    tx.order.findUnique.mockResolvedValue({ status: "COMPLETED" });

    const result = await autoCompleteDeliveredOrder("order-1");

    expect(result).toEqual({ completed: false, status: "COMPLETED" });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("竞态回归：事务内读 DELIVERED 但提交前被用户确认抢先（updateMany 命中 0 行）→ 返回 ALREADY_CHANGED", async () => {
    tx.order.findUnique.mockResolvedValue({ status: "DELIVERED" });
    tx.order.updateMany.mockResolvedValue({ count: 0 });

    const result = await autoCompleteDeliveredOrder("order-1");

    expect(result).toEqual({ completed: false, status: "ALREADY_CHANGED" });
    // 守卫失败 → 不写审计，绝不把已变更订单标记为系统完成
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
