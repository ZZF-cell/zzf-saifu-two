// 支付模块单元测试 — mock 系统边界（prisma DB + paymentAdapter 外部支付 + orders 超时取消）
// 只测公共 seam：payment.service.createPayment / payment.callback.verifyNotifySignature

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── 系统边界 mock ──

vi.mock("@/shared/db/client", () => ({
  prisma: {
    order: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/shared/adapters/payment.adapter", () => ({
  paymentAdapter: {
    createPayment: vi.fn(),
    verifyCallback: vi.fn(),
    queryPayment: vi.fn(),
  },
}));

// 全量 stub orders Public API：payment.service 仅用其状态常量 + 幂等取消函数。
// 不 importOriginal——真实 orders 链会反向加载 payment 造成循环依赖（stub 即隔离）。
vi.mock("@/features/orders", () => ({
  ORDER_STATUS: {
    PENDING: "PENDING",
    PAID: "PAID",
    SHIPPED: "SHIPPED",
    DELIVERED: "DELIVERED",
    COMPLETED: "COMPLETED",
    CANCELLED: "CANCELLED",
    REFUND_REQUESTED: "REFUND_REQUESTED",
    REFUNDED: "REFUNDED",
  },
  ORDER_PAYMENT_TIMEOUT_MS: 30 * 60 * 1000,
  cancelExpiredOrder: vi.fn(),
}));

import { prisma } from "@/shared/db/client";
import { paymentAdapter } from "@/shared/adapters/payment.adapter";
import { cancelExpiredOrder } from "@/features/orders";
import { createPayment, queryAlipayTrade } from "@/features/payment/payment.service";
import { verifyNotifySignature } from "@/features/payment/payment.callback";

// prisma.order.findUnique 的真实类型是完整 Order，mock 只覆盖 service 用到的字段
const findUniqueMock = vi.mocked(prisma.order.findUnique) as unknown as {
  mockResolvedValue: (value: {
    id: string;
    userId: string;
    status: string;
    total: number;
    createdAt: Date;
  } | null) => unknown;
};
const adapterCreateMock = vi.mocked(paymentAdapter.createPayment);
const adapterVerifyMock = vi.mocked(paymentAdapter.verifyCallback);
const adapterQueryMock = vi.mocked(paymentAdapter.queryPayment);
const cancelExpiredMock = vi.mocked(cancelExpiredOrder);

/** 未过期订单快照（createdAt = 现在；需断言 timeoutExpress 的用例应显式锚定 createdAt 以免疫时钟抖动） */
function pendingOrder(
  overrides: Partial<{ id: string; userId: string; status: string; total: number; createdAt: Date }> = {},
) {
  return {
    id: "order-1",
    userId: "user-1",
    status: "PENDING",
    total: 29900,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 默认视为支付宝已配置（isPaymentConfigured() 读 ALIPAY_* env）——成功路径/超时路径均可达 adapter
  process.env.ALIPAY_APP_ID = "test-app";
  process.env.ALIPAY_PRIVATE_KEY = "test-private";
  process.env.ALIPAY_PUBLIC_KEY = "test-public";
  cancelExpiredMock.mockResolvedValue({ cancelled: true, status: "CANCELLED" });
});

// ── createPayment：订单归属 + 状态校验 + 超时兜底 + 动态支付宝超时 ──

describe("createPayment — 订单校验与支付创建", () => {
  it("订单不存在 → 抛 ORDER_NOT_FOUND", async () => {
    findUniqueMock.mockResolvedValue(null);

    await expect(createPayment("user-1", "order-x")).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
    });
    expect(adapterCreateMock).not.toHaveBeenCalled();
  });

  it("订单不属于当前用户 → 统一 404 ORDER_NOT_FOUND（防订单号枚举，F2）", async () => {
    findUniqueMock.mockResolvedValue(pendingOrder({ userId: "user-other" }));

    await expect(createPayment("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
      statusCode: 404,
    });
    expect(adapterCreateMock).not.toHaveBeenCalled();
  });

  it("订单非 PENDING（已支付）→ 抛 ORDER_STATUS_INVALID", async () => {
    findUniqueMock.mockResolvedValue(pendingOrder({ ...pendingOrder(), status: "PAID" }));

    await expect(createPayment("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_STATUS_INVALID",
    });
    expect(adapterCreateMock).not.toHaveBeenCalled();
  });

  it("订单已超时（createdAt 超过 30min）→ 惰性取消并拒付 ORDER_STATUS_INVALID", async () => {
    findUniqueMock.mockResolvedValue(
      pendingOrder({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }),
    );

    await expect(createPayment("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_STATUS_INVALID",
      message: expect.stringContaining("超时"),
    });
    // 兜底取消确实被触发（幂等，状态守卫），且绝不创建支付
    expect(cancelExpiredMock).toHaveBeenCalledWith("order-1");
    expect(adapterCreateMock).not.toHaveBeenCalled();
  });

  it("订单即将超时（剩余 < 1 分钟）→ 拒付，不创建支付", async () => {
    // createdAt 距今 29.5min → expiresAt(createdAt+30min) 距今仅 30s < 1min
    findUniqueMock.mockResolvedValue(
      pendingOrder({ createdAt: new Date(Date.now() - 29.5 * 60 * 1000) }),
    );

    await expect(createPayment("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_STATUS_INVALID",
      message: expect.stringContaining("即将超时"),
    });
    expect(cancelExpiredMock).not.toHaveBeenCalled();
    expect(adapterCreateMock).not.toHaveBeenCalled();
  });

  it("成功路径 → 以订单快照金额/通用主题 + 剩余时间钳制的 timeoutExpress 调用 adapter，返回 qrCode", async () => {
    // createdAt 锚定 5min 前 → remaining 精确 25min（floor 对亚毫秒抖动免疫，杜绝时钟竞态 flake）
    findUniqueMock.mockResolvedValue(pendingOrder({ createdAt: new Date(Date.now() - 5 * 60 * 1000) }));
    adapterCreateMock.mockResolvedValue({ success: true, qrCode: "https://qr.alipay.com/bax0451xyz", tradeNo: "t-1" });

    const result = await createPayment("user-1", "order-1");

    // adapter 收到的 total 必须是订单快照金额（分），subject 为隐私友好的通用名
    expect(adapterCreateMock).toHaveBeenCalledWith({
      orderId: "order-1",
      total: 29900,
      subject: "赛夫严选",
      timeoutExpress: "25m", // floor：remaining=25min → 25m（≤ 订单剩余时间，杜绝支付后到落空窗）
    });
    expect(result).toEqual({ qrCode: "https://qr.alipay.com/bax0451xyz" });
  });

  it("D5：支付宝未配置 → 抛 PAYMENT_NOT_CONFIGURED(503)，不调 adapter", async () => {
    // 语义：未配置 = 「功能不可用」应 503（独立 GET /api/pay/[orderId] 直连此路径），而非 402「需付款」
    delete process.env.ALIPAY_APP_ID;
    findUniqueMock.mockResolvedValue(pendingOrder());

    await expect(createPayment("user-1", "order-1")).rejects.toMatchObject({
      code: "PAYMENT_NOT_CONFIGURED",
    });
    expect(adapterCreateMock).not.toHaveBeenCalled();
  });

  it("已配置但 adapter 创建失败 → 抛 PAYMENT_FAILED(402)，透传错误信息", async () => {
    findUniqueMock.mockResolvedValue(pendingOrder());
    adapterCreateMock.mockResolvedValue({
      success: false,
      error: "支付宝网关拒绝: 风控拦截",
    });

    await expect(createPayment("user-1", "order-1")).rejects.toMatchObject({
      code: "PAYMENT_FAILED",
      message: expect.stringContaining("支付宝网关拒绝"),
    });
  });

  it("D1：剩余 90s（floor→1m）→ timeoutExpress 为 1m，绝不向上取整制造落空窗", async () => {
    // ceil 修复回归：remaining∈(60s,120s] 时 ceil(remaining/60s)=2 → "2m" > 订单剩余时间，
    // 支付宝仍允许支付到订单自动取消之后 → 支付后到落空窗资损。floor 保证窗口 ≤ 剩余时间。
    const order = pendingOrder({ createdAt: new Date(Date.now() - 28.5 * 60 * 1000) });
    findUniqueMock.mockResolvedValue(order);
    adapterCreateMock.mockResolvedValue({ success: true, qrCode: "https://qr.alipay.com/x" });

    await createPayment("user-1", "order-1");

    expect(adapterCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutExpress: "1m" }),
    );
  });

  it("adapter 成功但无 qrCode → 返回 { qrCode: null }（不抛错，下游降级）", async () => {
    findUniqueMock.mockResolvedValue(pendingOrder());
    adapterCreateMock.mockResolvedValue({ success: true });

    const result = await createPayment("user-1", "order-1");
    expect(result).toEqual({ qrCode: null });
  });
});

// ── verifyNotifySignature：回调签名校验 ──

describe("verifyNotifySignature — 回调签名校验", () => {
  it("缺少 sign 字段 → 抛 PAYMENT_SIGNATURE_INVALID，不调 adapter", async () => {
    await expect(verifyNotifySignature({ out_trade_no: "order-1" })).rejects.toMatchObject({
      code: "PAYMENT_SIGNATURE_INVALID",
    });
    expect(adapterVerifyMock).not.toHaveBeenCalled();
  });

  it("验签失败 → 抛 PAYMENT_SIGNATURE_INVALID", async () => {
    adapterVerifyMock.mockResolvedValue(false);

    await expect(
      verifyNotifySignature({ out_trade_no: "order-1", sign: "abc", sign_type: "RSA2" }),
    ).rejects.toMatchObject({
      code: "PAYMENT_SIGNATURE_INVALID",
    });
  });

  it("验签通过 → 正常返回，adapter 收到完整表单", async () => {
    adapterVerifyMock.mockResolvedValue(true);
    const body = {
      out_trade_no: "order-1",
      trade_no: "2026080922000000000001",
      total_amount: "299.00",
      app_id: "2021000000000000",
      sign: "signed-value",
      sign_type: "RSA2",
    };

    await expect(verifyNotifySignature(body)).resolves.toBeUndefined();
    expect(adapterVerifyMock).toHaveBeenCalledWith(body);
  });
});

// ── queryAlipayTrade：主动查询支付宝交易状态（透传 adapter 结果）──

describe("queryAlipayTrade — 支付宝交易状态查询", () => {
  it("透传 outTradeNo 给 adapter，返回网关查询结果", async () => {
    const gatewayResult = {
      success: true,
      code: "10000",
      tradeStatus: "TRADE_SUCCESS",
      outTradeNo: "order-1",
      totalAmountFen: 29900,
      alipayTradeNo: "202608122200000000001",
    };
    adapterQueryMock.mockResolvedValue(gatewayResult);

    const result = await queryAlipayTrade("order-1");

    expect(adapterQueryMock).toHaveBeenCalledWith({ outTradeNo: "order-1" });
    expect(result).toEqual(gatewayResult);
  });

  it("支付宝未配置 / 网关异常（success:false）→ 原样透传，不抛错", async () => {
    adapterQueryMock.mockResolvedValue({
      success: false,
      error: "支付宝未配置，缺少环境变量: ALIPAY_APP_ID",
    });

    const result = await queryAlipayTrade("order-1");

    expect(result.success).toBe(false);
    expect(result.error).toContain("支付宝未配置");
  });
});
