// 支付模块单元测试 — mock 系统边界（prisma DB + paymentAdapter 外部支付）
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
  },
}));

import { prisma } from "@/shared/db/client";
import { paymentAdapter } from "@/shared/adapters/payment.adapter";
import { createPayment } from "@/features/payment/payment.service";
import { verifyNotifySignature } from "@/features/payment/payment.callback";

// prisma.order.findUnique 的真实类型是完整 Order，mock 只覆盖 service 用到的字段
const findUniqueMock = vi.mocked(prisma.order.findUnique) as unknown as {
  mockResolvedValue: (value: {
    id: string;
    userId: string;
    status: string;
    total: number;
  } | null) => unknown;
};
const adapterCreateMock = vi.mocked(paymentAdapter.createPayment);
const adapterVerifyMock = vi.mocked(paymentAdapter.verifyCallback);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── createPayment：订单归属 + 状态校验 + 支付创建 ──

describe("createPayment — 订单校验与支付创建", () => {
  it("订单不存在 → 抛 ORDER_NOT_FOUND", async () => {
    findUniqueMock.mockResolvedValue(null);

    await expect(createPayment("user-1", "order-x")).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
    });
    expect(adapterCreateMock).not.toHaveBeenCalled();
  });

  it("订单不属于当前用户 → 抛 ORDER_NOT_OWNED", async () => {
    findUniqueMock.mockResolvedValue({
      id: "order-1",
      userId: "user-other",
      status: "PENDING",
      total: 29900,
    });

    await expect(createPayment("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_NOT_OWNED",
    });
    expect(adapterCreateMock).not.toHaveBeenCalled();
  });

  it("订单非 PENDING（已支付）→ 抛 ORDER_STATUS_INVALID", async () => {
    findUniqueMock.mockResolvedValue({
      id: "order-1",
      userId: "user-1",
      status: "PAID",
      total: 29900,
    });

    await expect(createPayment("user-1", "order-1")).rejects.toMatchObject({
      code: "ORDER_STATUS_INVALID",
    });
    expect(adapterCreateMock).not.toHaveBeenCalled();
  });

  it("成功路径 → 以订单快照金额/通用主题调用 adapter，返回 payUrl", async () => {
    findUniqueMock.mockResolvedValue({
      id: "order-1",
      userId: "user-1",
      status: "PENDING",
      total: 29900,
    });
    adapterCreateMock.mockResolvedValue({ success: true, payUrl: "https://openapi-sandbox.alipay.com/gateway.do?...", tradeNo: "t-1" });

    const result = await createPayment("user-1", "order-1");

    // adapter 收到的 total 必须是订单快照金额（分），subject 为隐私友好的通用名
    expect(adapterCreateMock).toHaveBeenCalledWith({
      orderId: "order-1",
      total: 29900,
      subject: "赛夫严选",
    });
    expect(result).toEqual({ payUrl: "https://openapi-sandbox.alipay.com/gateway.do?..." });
  });

  it("支付宝未配置（adapter 失败）→ 抛 PAYMENT_FAILED，透传错误信息", async () => {
    findUniqueMock.mockResolvedValue({
      id: "order-1",
      userId: "user-1",
      status: "PENDING",
      total: 29900,
    });
    adapterCreateMock.mockResolvedValue({
      success: false,
      error: "支付宝未配置，缺少环境变量: ALIPAY_APP_ID, ALIPAY_PRIVATE_KEY, ALIPAY_PUBLIC_KEY",
    });

    await expect(createPayment("user-1", "order-1")).rejects.toMatchObject({
      code: "PAYMENT_FAILED",
      message: expect.stringContaining("支付宝未配置"),
    });
  });

  it("adapter 成功但无 payUrl → 返回 { payUrl: null }（不抛错，下游降级）", async () => {
    findUniqueMock.mockResolvedValue({
      id: "order-1",
      userId: "user-1",
      status: "PENDING",
      total: 29900,
    });
    adapterCreateMock.mockResolvedValue({ success: true });

    const result = await createPayment("user-1", "order-1");
    expect(result).toEqual({ payUrl: null });
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
