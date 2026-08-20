// cancelOrder 单元测试 — 手动取消（超时/未超时 × 支付宝查询失败/成功 分派）
// mock 系统边界：prisma $transaction + paymentAdapter（支付宝查询）
// 只测公共 seam：orders.service.cancelOrder
//
// 关键回归：此前支付宝查询失败一律拒绝取消 → 超时订单永远取消不了（死锁，用户报障
// 「完全没支付也取消不了」）。修复：已超时（D1 保证支付宝允许支付窗口已随订单关闭，
// 收款不可能再发生）→ 查询失败放行取消；未超时 → 用户可能正付款，保守保持 PENDING。
// 能查到已支付时仍走 markOrderPaid「标记 PAID 不取消」防护（防资损）。

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    product: { updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// 阻断订单 service 对支付 adapter 的真实调用（import 链会经过 payment 模块，mock 掉 adapter）
vi.mock("@/shared/adapters/payment.adapter", () => ({
  paymentAdapter: { createPayment: vi.fn(), verifyCallback: vi.fn(), queryPayment: vi.fn() },
}));

import { prisma } from "@/shared/db/client";
import { paymentAdapter } from "@/shared/adapters/payment.adapter";
import { cancelOrder } from "@/features/orders/orders.service";

// ── 交互事务 mock：$transaction(fn) 以 tx 对象调用 fn ──

type TxOrder = {
  findUnique: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};
type TxProduct = { updateMany: ReturnType<typeof vi.fn> };
type TxAudit = { create: ReturnType<typeof vi.fn> };
type Tx = { order: TxOrder; product: TxProduct; auditLog: TxAudit };

let tx: Tx;
type TransactionImpl = (fn: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
const transactionMock = prisma.$transaction as unknown as Mock<TransactionImpl>;

const ALIPAY_ENV = ["ALIPAY_APP_ID", "ALIPAY_PRIVATE_KEY", "ALIPAY_PUBLIC_KEY"] as const;
const savedEnv = new Map<string, string | undefined>();

function orderSnapshot(
  overrides: Partial<{
    userId: string;
    status: string;
    total: number;
    createdAt: Date;
    items: { productId: string | null; qty: number }[];
  }> = {},
) {
  return {
    id: "order-1",
    userId: "user-1",
    status: "PENDING",
    total: 100,
    createdAt: new Date(),
    items: [{ productId: "p1", qty: 1 }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 默认视为「支付宝已配置」：isPaymentConfigured() 走真实查询分支
  for (const key of ALIPAY_ENV) {
    savedEnv.set(key, process.env[key]);
    process.env[key] = "test-config";
  }
  // 默认：网关确认未支付（code=10000 + TRADE_NOT_EXIST）→ 允许进入取消
  vi.mocked(paymentAdapter.queryPayment).mockResolvedValue({
    success: true,
    code: "10000",
    tradeStatus: "TRADE_NOT_EXIST",
  });
  tx = {
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    product: { updateMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue(undefined) },
  };
  // 外层只读（cancelOrder）与事务内 markOrderPaid 读订单共享同一 mock，只需设置一次
  prisma.order.findUnique = tx.order.findUnique as never;
  transactionMock.mockImplementation((fn: (tx: Tx) => Promise<unknown>) => fn(tx));
});

afterEach(() => {
  for (const key of ALIPAY_ENV) {
    const saved = savedEnv.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  savedEnv.clear();
});

// ── cancelOrder：手动取消 ──

describe("cancelOrder — 手动取消（超时/未超时 × 查询失败分派）", () => {
  it("未超时 + 支付宝查询失败 → 抛「支付状态确认中」，不取消/不回补库存（用户可能正付款，保守）", async () => {
    tx.order.findUnique.mockResolvedValue(orderSnapshot()); // createdAt = now（未超时）
    vi.mocked(paymentAdapter.queryPayment).mockResolvedValue({ success: false, error: "网络超时" });

    await expect(cancelOrder("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_STATUS_INVALID",
      message: expect.stringContaining("支付状态确认中"),
    });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });

  it("已超时 + 支付宝查询失败 → 放行取消（D1 窗口已关闭，收款不可能再发生）", async () => {
    tx.order.findUnique.mockResolvedValue(
      orderSnapshot({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }),
    );
    tx.order.updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(paymentAdapter.queryPayment).mockResolvedValue({ success: false, error: "网络超时" });

    await cancelOrder("user-1", "order-1");

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "PENDING" },
      data: { status: "CANCELLED", cancelledAt: expect.any(Date) },
    });
    expect(tx.product.updateMany).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "USER_CANCELLED" }),
      }),
    );
  });

  it("未超时 + 查询成功未支付（TRADE_NOT_EXIST）→ 正常取消", async () => {
    tx.order.findUnique.mockResolvedValue(orderSnapshot());
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    await cancelOrder("user-1", "order-1");

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "PENDING" },
      data: { status: "CANCELLED", cancelledAt: expect.any(Date) },
    });
    expect(tx.product.updateMany).toHaveBeenCalled();
  });

  it("查询到已支付（TRADE_SUCCESS 金额一致）→ 标记 PAID 并抛「已支付，无法取消」，绝不回补库存", async () => {
    tx.order.findUnique.mockResolvedValue(
      orderSnapshot({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }),
    );
    vi.mocked(paymentAdapter.queryPayment).mockResolvedValue({
      success: true,
      code: "10000",
      tradeStatus: "TRADE_SUCCESS",
      outTradeNo: "order-1",
      totalAmountFen: 100,
      alipayTradeNo: "alipay-xyz",
    });
    // markOrderPaid 幂等事务：读订单 → 金额核验 → 守卫命中 → 置 PAID
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    await expect(cancelOrder("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_STATUS_INVALID",
      message: expect.stringContaining("已支付"),
    });
    // 走 markOrderPaid 的 updateMany（置 PAID），而非取消的 updateMany（置 CANCELLED）
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "PENDING" },
      data: expect.objectContaining({ status: "PAID", outTradeNo: "order-1" }),
    });
    // 绝不含取消动作：不回补库存
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });

  it("订单已支付（PAID）→ 抛 ORDER_STATUS_INVALID「已支付订单不能直接取消」，不查支付宝", async () => {
    tx.order.findUnique.mockResolvedValue(orderSnapshot({ status: "PAID" }));

    await expect(cancelOrder("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_STATUS_INVALID",
      message: expect.stringContaining("已支付订单不能直接取消"),
    });
    expect(paymentAdapter.queryPayment).not.toHaveBeenCalled();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("支付宝未配置（开发环境）→ 跳过查询直接取消", async () => {
    for (const key of ALIPAY_ENV) delete process.env[key];
    tx.order.findUnique.mockResolvedValue(orderSnapshot());
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    await cancelOrder("user-1", "order-1");

    expect(paymentAdapter.queryPayment).not.toHaveBeenCalled();
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "PENDING" },
      data: { status: "CANCELLED", cancelledAt: expect.any(Date) },
    });
  });
});
