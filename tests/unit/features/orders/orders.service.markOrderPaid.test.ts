// markOrderPaid 单元测试 — 支付回调幂等 + 金额快照核验 + 状态冲突（资损关键路径）
// mock 系统边界：prisma $transaction（交互事务内 order.findUnique / order.updateMany）
// 只测公共 seam：orders.service.markOrderPaid

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// 阻断订单 service 对支付 adapter 的真实调用（import 链会经过 payment 模块，mock 掉 adapter）
vi.mock("@/shared/adapters/payment.adapter", () => ({
  paymentAdapter: { createPayment: vi.fn(), verifyCallback: vi.fn() },
}));

import { prisma } from "@/shared/db/client";
import { markOrderPaid } from "@/features/orders/orders.service";
import { ERROR_CODES } from "@/shared/errors/errors";

// ── 交互事务 mock：$transaction(fn) 以 tx 对象调用 fn ──

type TxOrder = {
  findUnique: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};
type Tx = { order: TxOrder };

let tx: Tx;
// prisma.$transaction 有多个重载；用 vitest Mock 显式声明实现签名：
// $transaction(fn) 内部用测试 tx 调用事务回调 fn
type TransactionImpl = (fn: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
const transactionMock = prisma.$transaction as unknown as Mock<TransactionImpl>;

beforeEach(() => {
  vi.clearAllMocks();
  tx = { order: { findUnique: vi.fn(), updateMany: vi.fn() } };
  transactionMock.mockImplementation(
    (fn: (tx: Tx) => Promise<unknown>) => fn(tx),
  );
});

// ── markOrderPaid：金额核验 + 幂等标记 ──

describe("markOrderPaid — 支付回调幂等处理", () => {
  it("PENDING 且金额一致 → 标记 PAID，updateMany 命中 PENDING + 记录 outTradeNo/alipayTradeNo/paidAt", async () => {
    tx.order.findUnique.mockResolvedValue({ total: 29900 });
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    const result = await markOrderPaid("order-1", "order-1", 29900, "202608122200000000001");

    expect(result).toEqual({ success: true, conflict: false });
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "PENDING" },
      data: {
        status: "PAID",
        outTradeNo: "order-1",
        alipayTradeNo: "202608122200000000001",
        paidAt: expect.any(Date),
      },
    });
  });

  it("回调未携带 trade_no → alipayTradeNo 落库为 null", async () => {
    tx.order.findUnique.mockResolvedValue({ total: 29900 });
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    const result = await markOrderPaid("order-1", "order-1", 29900);

    expect(result).toEqual({ success: true, conflict: false });
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "PENDING" },
      data: {
        status: "PAID",
        outTradeNo: "order-1",
        alipayTradeNo: null,
        paidAt: expect.any(Date),
      },
    });
  });

  it("回调金额与订单快照不一致 → conflict=true，绝不标记 PAID（防资损）", async () => {
    tx.order.findUnique.mockResolvedValue({ total: 29900 });

    const result = await markOrderPaid("order-1", "order-1", 100);

    expect(result).toEqual({ success: false, conflict: true });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("订单不存在 → 抛 ORDER_NOT_FOUND，事务内不执行任何写", async () => {
    tx.order.findUnique.mockResolvedValue(null);

    await expect(markOrderPaid("order-x", "order-x", 29900)).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
    });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("重复通知（已 PAID）→ 幂等返回 success，不再写入", async () => {
    // 第一次 findUnique = 金额核验；updateMany count=0；第二次 findUnique = 状态检查
    tx.order.findUnique
      .mockResolvedValueOnce({ total: 29900 })
      .mockResolvedValueOnce({ status: "PAID" });
    tx.order.updateMany.mockResolvedValue({ count: 0 });

    const result = await markOrderPaid("order-1", "order-1", 29900);

    expect(result).toEqual({ success: true, conflict: false });
    // 幂等路径仍执行 updateMany（保证并发下第一次通知赢得竞争），但 count=0 不重复写
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
  });

  it("支付到达但订单已取消（CANCELLED）→ conflict=true（需人工退款场景）", async () => {
    tx.order.findUnique
      .mockResolvedValueOnce({ total: 29900 })
      .mockResolvedValueOnce({ status: "CANCELLED" });
    tx.order.updateMany.mockResolvedValue({ count: 0 });

    const result = await markOrderPaid("order-1", "order-1", 29900);

    expect(result).toEqual({ success: false, conflict: true });
  });

  it("支付到达但订单已退款（REFUNDED）→ conflict=true", async () => {
    tx.order.findUnique
      .mockResolvedValueOnce({ total: 29900 })
      .mockResolvedValueOnce({ status: "REFUNDED" });
    tx.order.updateMany.mockResolvedValue({ count: 0 });

    const result = await markOrderPaid("order-1", "order-1", 29900);

    expect(result).toEqual({ success: false, conflict: true });
  });
});

// 顺带验证 errors 枚举补全（支付模块 API 依赖它）
describe("ERROR_CODES.PAYMENT_NOT_CONFIGURED", () => {
  it("已定义 503 错误码", () => {
    expect(ERROR_CODES.PAYMENT_NOT_CONFIGURED).toEqual({
      status: 503,
      code: "PAYMENT_NOT_CONFIGURED",
    });
  });
});
