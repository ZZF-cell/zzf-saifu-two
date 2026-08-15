// paymentAdapter.queryPayment 单元测试 — 支付宝交易状态查询（alipay.trade.query）
// mock alipay-sdk 类，验证：
//   - exec 参数（method + 北京时间 timestamp + bizContent.outTradeNo）
//   - 字段映射（trade_status / total_amount 元→分 / trade_no）
//   - exec 抛错 → success:false 优雅降级
//   - 支付宝未配置 → success:false 降级
//
// 用 vi.resetModules() + 动态 import 每次重建 adapter 单例：
// getAlipaySdk 会把「未配置」原因缓存在模块级 unavailableReason，单例不重建会污染后续用例

import { describe, it, expect, beforeEach, vi } from "vitest";
import AlipaySdk from "alipay-sdk";

// mock alipay-sdk 默认导出类：exec 用原型方法，便于 vi.spyOn 按用例覆写
vi.mock("alipay-sdk", () => {
  class AlipaySdkMock {
    constructor(_opts: unknown) {}
    async pageExec() {
      return "https://openapi-sandbox.dl.alipaydev.com/gateway.do?...";
    }
    async exec() {
      throw new Error("not mocked");
    }
    async checkNotifySign() {
      return true;
    }
  }
  return { default: AlipaySdkMock };
});

// 假密钥：detectKeyType 仅按 PEM 头正则识别 PKCS1/PKCS8，不会真实解析，无需合法 RSA 内容
const PKCS1_KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7\n-----END RSA PRIVATE KEY-----";
const PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0B\n-----END PUBLIC KEY-----";

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.ALIPAY_APP_ID = "2021000000000000";
  process.env.ALIPAY_PRIVATE_KEY = PKCS1_KEY;
  process.env.ALIPAY_PUBLIC_KEY = PUBLIC_KEY;
});

/** 重载 adapter 模块（resetModules 让 getAlipaySdk 的单例 / 降级缓存全部重建） */
async function loadAdapter() {
  vi.resetModules();
  const mod = await import("@/shared/adapters/payment.adapter");
  return mod.paymentAdapter;
}

describe("paymentAdapter.queryPayment — alipay.trade.query 交易状态查询", () => {
  it("以北京时间 timestamp + bizContent.outTradeNo 调 exec，TRADE_SUCCESS 字段正确映射", async () => {
    const adapter = await loadAdapter();
    const execSpy = vi.spyOn(AlipaySdk.prototype, "exec").mockResolvedValue({
      code: "10000",
      msg: "Success",
      trade_status: "TRADE_SUCCESS",
      out_trade_no: "order-1",
      total_amount: "59.00",
      trade_no: "202608122200000000001",
    });

    const result = await adapter.queryPayment({ outTradeNo: "order-1" });

    // exec 参数：方法与 bizContent 精确断言；timestamp 必须是北京时间格式（时区陷阱回归）
    expect(execSpy).toHaveBeenCalledWith("alipay.trade.query", {
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      bizContent: { outTradeNo: "order-1" },
    });
    // 字段映射：total_amount（元）→ 分（59.00 → 5900）；trade_no 映射 alipayTradeNo
    expect(result).toEqual({
      success: true,
      code: "10000",
      tradeStatus: "TRADE_SUCCESS",
      outTradeNo: "order-1",
      totalAmountFen: 5900,
      alipayTradeNo: "202608122200000000001",
    });
  });

  it("业务失败响应（code=40004，无 trade_status）→ tradeStatus/totalAmountFen/alipayTradeNo 为 null，不抛错", async () => {
    const adapter = await loadAdapter();
    vi.spyOn(AlipaySdk.prototype, "exec").mockResolvedValue({
      code: "40004", // 业务失败（如 out_trade_no 不存在）
      msg: "Business Failed",
      sub_code: "isv.out-trade-no-not-exist",
    });

    const result = await adapter.queryPayment({ outTradeNo: "order-1" });

    expect(result.success).toBe(true);
    expect(result.tradeStatus).toBeNull();
    expect(result.totalAmountFen).toBeNull();
    expect(result.alipayTradeNo).toBeNull();
  });

  it("exec 抛错（网关异常）→ success:false + 错误信息，不向上抛", async () => {
    const adapter = await loadAdapter();
    vi.spyOn(AlipaySdk.prototype, "exec").mockRejectedValue(
      new Error("network timeout"),
    );

    const result = await adapter.queryPayment({ outTradeNo: "order-1" });

    expect(result).toEqual({ success: false, error: "network timeout" });
  });

  it("支付宝未配置 → success:false 降级（不抛错）", async () => {
    delete process.env.ALIPAY_APP_ID;
    delete process.env.ALIPAY_PRIVATE_KEY;
    delete process.env.ALIPAY_PUBLIC_KEY;

    const adapter = await loadAdapter();
    const result = await adapter.queryPayment({ outTradeNo: "order-1" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("支付宝未配置");
  });
});
