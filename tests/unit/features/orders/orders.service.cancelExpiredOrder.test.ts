// cancelExpiredOrder 单元测试 — Inngest 支付超时自动取消（竞态安全 + 库存回补）
// mock 系统边界：prisma $transaction（交互事务内 order.findUnique / order.updateMany / product.updateMany）
// 只测公共 seam：orders.service.cancelExpiredOrder
//
// 关键回归点：
// - updateMany 状态守卫必须先于库存回补（回调抢先置 PAID → 命中 0 行 → 绝不回补，防资损）
// - D2：取消前必须查支付宝终态——查询失败（success=false 或网关非 10000）绝不取消，
//   支付状态未知时保持 PENDING 留待下次 sweep（此前「未配置」与「网关瞬时失败」同路径取消，成批取消已支付订单）

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
import { cancelExpiredOrder } from "@/features/orders/orders.service";

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
  // M1：cancelExpiredOrder 先「外层只读」用 prisma.order.findUnique（判断非 PENDING 即 no-op），
  // 事务内(markOrderPaid)再读 tx.order.findUnique —— 共享同一 mock，测试只需设置一次。
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

// ── cancelExpiredOrder：超时取消 + 库存回补 ──

describe("cancelExpiredOrder — 支付超时自动取消", () => {
  it("PENDING + 网关确认未支付 → 守卫命中 + 回补库存 + 置 CANCELLED，返回 cancelled:true", async () => {
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
    // 取消前必须先查支付宝确认未支付
    expect(paymentAdapter.queryPayment).toHaveBeenCalledWith({ outTradeNo: "order-1" });
    // 状态守卫携带 status=PENDING，防止把已支付订单覆写成 CANCELLED
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "PENDING" },
      data: { status: "CANCELLED", cancelledAt: expect.any(Date) },
    });
    // 回补库存：productId=null 的项跳过，仅回补 p1；
    // 每项拆两次 updateMany —— 库存回补（无守卫）+ 销量回减（sales ≥ qty 守卫，防脏数据减成负数）
    expect(tx.product.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.product.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "p1" },
      data: { stock: { increment: 2 } },
    });
    expect(tx.product.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "p1", sales: { gte: 2 } },
      data: { sales: { decrement: 2 } },
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

    // 每个商品拆两次 updateMany：先回补库存（无守卫）、再回减销量（sales ≥ qty 守卫）
    expect(tx.product.updateMany).toHaveBeenCalledTimes(4);
    expect(tx.product.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "p1" },
      data: { stock: { increment: 1 } },
    });
    expect(tx.product.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "p1", sales: { gte: 1 } },
      data: { sales: { decrement: 1 } },
    });
    expect(tx.product.updateMany).toHaveBeenNthCalledWith(3, {
      where: { id: "p2" },
      data: { stock: { increment: 3 } },
    });
    expect(tx.product.updateMany).toHaveBeenNthCalledWith(4, {
      where: { id: "p2", sales: { gte: 3 } },
      data: { sales: { decrement: 3 } },
    });
  });

  it("支付宝未配置（开发环境）→ 跳过查询直接取消（无支付可能，无资损风险）", async () => {
    // D2 语义：未配置 = 开发环境无真实支付，无需查网关直接取消；查询不应被调用
    for (const key of ALIPAY_ENV) delete process.env[key];
    tx.order.findUnique.mockResolvedValue({
      status: "PENDING",
      items: [{ productId: "p1", qty: 1 }],
    });
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    const result = await cancelExpiredOrder("order-1");

    expect(result).toEqual({ cancelled: true, status: "CANCELLED" });
    expect(paymentAdapter.queryPayment).not.toHaveBeenCalled();
  });

  it("D2：支付宝已配置但查询失败（success=false 网关超时）→ 保持 PENDING，绝不取消/不回补库存", async () => {
    // 用户可能已真实付款但异步通知丢失，此刻查询恰逢网关抖动——取消 = 「钱已扣、订单已取消」资损
    tx.order.findUnique.mockResolvedValue({
      status: "PENDING",
      total: 100,
      items: [{ productId: "p1", qty: 1 }],
    });
    vi.mocked(paymentAdapter.queryPayment).mockResolvedValue({
      success: false,
      error: "网络超时",
    });

    const result = await cancelExpiredOrder("order-1");

    expect(result).toEqual({ cancelled: false, status: "PENDING" });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });

  it("D2：支付宝已配置但网关非 10000（业务错误码）→ 支付状态未知，保持 PENDING 不取消", async () => {
    tx.order.findUnique.mockResolvedValue({
      status: "PENDING",
      total: 100,
      items: [{ productId: "p1", qty: 1 }],
    });
    vi.mocked(paymentAdapter.queryPayment).mockResolvedValue({
      success: true,
      code: "40004",
      tradeStatus: null,
    });

    const result = await cancelExpiredOrder("order-1");

    expect(result).toEqual({ cancelled: false, status: "PENDING" });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });

  it("M1：支付宝返回已支付且金额一致 → 幂等标记 PAID，绝不取消/不回补库存", async () => {
    // 用户已真实付款但异步通知丢失（notifyUrl 未到）——超时取消前必须先查支付，
    // 已支付订单被取消 = 「钱已扣、订单已取消」资损（本次修复的核心断言）
    tx.order.findUnique.mockResolvedValue({
      status: "PENDING",
      total: 100,
      items: [{ productId: "p1", qty: 1 }],
    });
    vi.mocked(paymentAdapter.queryPayment).mockResolvedValue({
      success: true,
      code: "10000",
      tradeStatus: "TRADE_SUCCESS",
      outTradeNo: "order-1",
      totalAmountFen: 100,
      alipayTradeNo: "alipay-xyz",
    });
    // markOrderPaid 的幂等事务：读订单 → 金额核验通过 → 状态守卫命中 → 写 PAID
    tx.order.findUnique.mockResolvedValue({
      status: "PENDING",
      total: 100,
      items: [{ productId: "p1", qty: 1 }],
    });
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    const result = await cancelExpiredOrder("order-1");

    expect(result).toEqual({ cancelled: false, status: "PAID" });
    // 走 markOrderPaid 的 updateMany（置 PAID），而非取消的 updateMany（置 CANCELLED）
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "PENDING" },
      data: expect.objectContaining({ status: "PAID", outTradeNo: "order-1" }),
    });
    // 绝不含取消动作：不回补库存
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    // 支付到账审计
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "PAID", operatorId: null }),
      }),
    );
  });

  it("M1：支付宝已支付但金额与订单快照不符 → 保持 PENDING，不取消也不标记（人工介入）", async () => {
    tx.order.findUnique.mockResolvedValue({
      status: "PENDING",
      total: 100,
      items: [{ productId: "p1", qty: 1 }],
    });
    vi.mocked(paymentAdapter.queryPayment).mockResolvedValue({
      success: true,
      code: "10000",
      tradeStatus: "TRADE_SUCCESS",
      outTradeNo: "order-1",
      totalAmountFen: 99, // 与订单 100 分不符 → 资损风险，拒绝标记也拒绝取消
      alipayTradeNo: "alipay-xyz",
    });

    const result = await cancelExpiredOrder("order-1");

    expect(result).toEqual({ cancelled: false, status: "PENDING" });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });
});
