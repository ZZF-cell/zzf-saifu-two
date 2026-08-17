// checkPaymentStatus 单元测试 —「查询支付」真正向支付宝核对交易终态（死循环修复关键链路）
// mock 系统边界：prisma.order.findUnique + paymentService.queryAlipayTrade（支付宝网关查询）
// 只测公共 seam：orders.service.checkPaymentStatus
//
// 回归点：修复前 check-paid 只读本地 DB 不查支付宝（本地沙箱 notifyUrl=localhost 收不到异步通知），
// 「查询支付」永远返回待支付。本测试锁定 PENDING → 真正 query 支付宝 →
// TRADE_SUCCESS/TRADE_FINISHED 且金额匹配 → markOrderPaid 幂等标记 → 返回 PAID 的完整链路。

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    product: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// 阻断订单 service 对真实 payment 模块的调用（支付宝网关不可测）；queryAlipayTrade / isPaymentConfigured 由各用例 mock
vi.mock("@/features/payment", () => ({
  paymentService: {
    createPayment: vi.fn(),
    queryAlipayTrade: vi.fn(),
    isPaymentConfigured: vi.fn(),
  },
}));

import { prisma } from "@/shared/db/client";
import { paymentService } from "@/features/payment";
import { checkPaymentStatus } from "@/features/orders/orders.service";
import { ORDER_STATUS } from "@/features/orders/orders.state-machine";

// prisma.order.findUnique 的真实类型是完整 Order，mock 只覆盖 service 用到的字段
const findUniqueMock = vi.mocked(prisma.order.findUnique) as unknown as {
  mockResolvedValue: (value: {
    userId: string;
    status: string;
    total: number;
    createdAt: Date;
    destroyedAt?: Date | null;
  } | null) => unknown;
};
const queryTradeMock = vi.mocked(paymentService.queryAlipayTrade);

// ── 交互事务 mock（markOrderPaid / cancelExpiredOrder 都走 $transaction）──

type TxOrder = {
  findUnique: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};
type Tx = {
  order: TxOrder;
  product: { updateMany: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

let tx: Tx;
type TransactionImpl = (fn: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
const transactionMock = prisma.$transaction as unknown as Mock<TransactionImpl>;

beforeEach(() => {
  vi.clearAllMocks();
  // 默认视为支付宝已配置（cancelExpiredOrder 据此走真实查询分支，而非跳过查询直接取消）
  vi.mocked(paymentService.isPaymentConfigured).mockReturnValue(true);
  tx = {
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    product: { updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  transactionMock.mockImplementation((fn: (tx: Tx) => Promise<unknown>) => fn(tx));
});

/** 未过期 PENDING 订单快照（checkPaymentStatus 首次读取） */
function snapshot(
  overrides: Partial<{
    userId: string;
    status: string;
    total: number;
    createdAt: Date;
    destroyedAt?: Date | null;
    items?: { productId: string | null; qty: number }[];
  }> = {},
) {
  return {
    userId: "user-1",
    status: ORDER_STATUS.PENDING,
    total: 29900,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("checkPaymentStatus — 查询支付状态（真正查支付宝）", () => {
  it("订单不存在 → 抛 ORDER_NOT_FOUND，不查支付宝", async () => {
    findUniqueMock.mockResolvedValue(null);

    await expect(checkPaymentStatus("user-1", "order-x")).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
    });
    expect(queryTradeMock).not.toHaveBeenCalled();
  });

  it("订单不属于当前用户 → 统一 404 ORDER_NOT_FOUND（防订单号枚举，F2）", async () => {
    findUniqueMock.mockResolvedValue(snapshot({ userId: "user-other" }));

    await expect(checkPaymentStatus("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
      statusCode: 404,
    });
    expect(queryTradeMock).not.toHaveBeenCalled();
  });

  it("已销毁订单（destroyedAt 非空）→ 对用户侧视为不存在，抛 ORDER_NOT_FOUND（F3）", async () => {
    findUniqueMock.mockResolvedValue(
      snapshot({ destroyedAt: new Date("2026-08-01T00:00:00Z") }),
    );

    await expect(checkPaymentStatus("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
    });
    expect(queryTradeMock).not.toHaveBeenCalled();
  });

  it("PENDING + 支付宝 TRADE_SUCCESS 且金额一致 → markOrderPaid 幂等标记 → 返回 PAID", async () => {
    findUniqueMock.mockResolvedValue(snapshot());
    queryTradeMock.mockResolvedValue({
      success: true,
      code: "10000",
      tradeStatus: "TRADE_SUCCESS",
      outTradeNo: "order-1",
      totalAmountFen: 29900,
      alipayTradeNo: "202608122200000000001",
    });
    // markOrderPaid 事务内：金额核验 findUnique → 命中 PENDING → 置 PAID
    tx.order.findUnique.mockResolvedValue({ total: 29900 });
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    const result = await checkPaymentStatus("user-1", "order-1");

    // 关键断言：真正查询了支付宝网关（而非只读本地 DB）
    expect(queryTradeMock).toHaveBeenCalledWith("order-1");
    // 幂等标记：updateMany 命中 PENDING → 置 PAID（含 outTradeNo/alipayTradeNo）
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "PENDING" },
      data: {
        status: "PAID",
        outTradeNo: "order-1",
        alipayTradeNo: "202608122200000000001",
        paidAt: expect.any(Date),
      },
    });
    expect(result).toEqual({ status: "PAID" });
  });

  it("PENDING + TRADE_FINISHED（不可退款终态）→ 同样标记 PAID", async () => {
    findUniqueMock.mockResolvedValue(snapshot());
    queryTradeMock.mockResolvedValue({
      success: true,
      tradeStatus: "TRADE_FINISHED",
      outTradeNo: "order-1",
      totalAmountFen: 29900,
      alipayTradeNo: "t-1",
    });
    tx.order.findUnique.mockResolvedValue({ total: 29900 });
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    const result = await checkPaymentStatus("user-1", "order-1");

    expect(result).toEqual({ status: "PAID" });
  });

  it("PENDING + 支付宝仍在等待支付（WAIT_BUYER_PAY）→ 返回 PENDING，不标记", async () => {
    findUniqueMock.mockResolvedValue(snapshot());
    queryTradeMock.mockResolvedValue({
      success: true,
      tradeStatus: "WAIT_BUYER_PAY",
      outTradeNo: "order-1",
    });

    const result = await checkPaymentStatus("user-1", "order-1");

    expect(result).toEqual({ status: "PENDING" });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("PENDING + 查询失败（success:false，网关异常）→ 优雅返回 PENDING，不抛错", async () => {
    findUniqueMock.mockResolvedValue(snapshot());
    queryTradeMock.mockResolvedValue({ success: false, error: "network timeout" });

    const result = await checkPaymentStatus("user-1", "order-1");

    expect(result).toEqual({ status: "PENDING" });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("PENDING + TRADE_SUCCESS 但金额与订单快照不符 → 拒绝标记，返回 PENDING（防资损）", async () => {
    findUniqueMock.mockResolvedValue(snapshot());
    queryTradeMock.mockResolvedValue({
      success: true,
      tradeStatus: "TRADE_SUCCESS",
      outTradeNo: "order-1",
      totalAmountFen: 100, // 与订单快照 29900 不符 → 拒绝
      alipayTradeNo: "t-x",
    });

    const result = await checkPaymentStatus("user-1", "order-1");

    expect(result).toEqual({ status: "PENDING" });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("非 PENDING（已 PAID）→ 直接返回当前状态，不查询支付宝", async () => {
    findUniqueMock.mockResolvedValue(snapshot({ status: "PAID" }));

    const result = await checkPaymentStatus("user-1", "order-1");

    expect(result).toEqual({ status: "PAID" });
    expect(queryTradeMock).not.toHaveBeenCalled();
  });

  it("已超时 PENDING → 先查支付(未支付) → 惰性取消订单，返回 CANCELLED", async () => {
    findUniqueMock.mockResolvedValue(
      snapshot({
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        items: [{ productId: "p1", qty: 1 }],
      }),
    );
    // M1/D2 回归：超时取消前必须向支付宝核对终态；网关 code=10000 且明确未支付才允许取消
    queryTradeMock.mockResolvedValue({
      success: true,
      code: "10000",
      tradeStatus: "TRADE_NOT_EXIST",
    });
    tx.order.updateMany.mockResolvedValue({ count: 1 });
    tx.product.updateMany.mockResolvedValue({ count: 1 });

    const result = await checkPaymentStatus("user-1", "order-1");

    expect(result).toEqual({ status: "CANCELLED" });
    // 修复后：取消前确实查了支付（而非修复前直接取消）
    expect(queryTradeMock).toHaveBeenCalledWith("order-1");
    // 取消成功后库存回补确实触发
    expect(tx.product.updateMany).toHaveBeenCalledTimes(1);
  });

  it("已超时 PENDING 但支付宝已支付 → 标记 PAID，返回 PAID（不取消，防资损）", async () => {
    findUniqueMock.mockResolvedValue(
      snapshot({
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        total: 100,
      }),
    );
    queryTradeMock.mockResolvedValue({
      success: true,
      code: "10000",
      tradeStatus: "TRADE_SUCCESS",
      outTradeNo: "order-1",
      totalAmountFen: 100,
      alipayTradeNo: "alipay-1",
    });
    // markOrderPaid 幂等事务
    tx.order.findUnique.mockResolvedValue({ total: 100 });
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    const result = await checkPaymentStatus("user-1", "order-1");

    expect(result).toEqual({ status: "PAID" });
    // 取消动作绝不触发：不回补库存
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });
});
