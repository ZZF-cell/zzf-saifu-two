// paymentAdapter.queryPayment / createPayment 单元测试
// - queryPayment：支付宝交易状态查询（alipay.trade.query）
// - createPayment：当面付扫码（alipay.trade.precreate，返回 qr_code 二维码内容）
// mock alipay-sdk 类，验证：
//   - exec 参数（method + 北京时间 timestamp + notifyUrl + bizContent）
//   - 字段映射（qr_code / trade_status / total_amount 元→分 / trade_no）
//   - 业务失败码（code≠10000）→ success:false
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
  // createPayment 的 notifyUrl 依赖 baseUrl；缺省时 adapter 返回「缺少 NEXT_PUBLIC_BASE_URL」
  process.env.NEXT_PUBLIC_BASE_URL = "https://saifu.e9888.cn";
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

// ── createPayment：当面付扫码（alipay.trade.precreate） ──

describe("paymentAdapter.createPayment — alipay.trade.precreate 当面付", () => {
  it("调 exec precreate：notifyUrl 含 orderId + 北京时间 timestamp + bizContent（金额元串/主题/超时）", async () => {
    const adapter = await loadAdapter();
    const execSpy = vi.spyOn(AlipaySdk.prototype, "exec").mockResolvedValue({
      code: "10000",
      msg: "Success",
      out_trade_no: "order-1",
      qr_code: "https://qr.alipay.com/bax0451xyz",
    });

    const result = await adapter.createPayment({
      orderId: "order-1",
      total: 8900,
      subject: "赛夫严选",
      timeoutExpress: "30m",
    });

    // 当面付用 exec（返回 JSON qr_code），非 pageExec（返回跳转 URL）
    expect(execSpy).toHaveBeenCalledWith("alipay.trade.precreate", {
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      notifyUrl: "https://saifu.e9888.cn/api/orders/order-1/paid",
      bizContent: {
        outTradeNo: "order-1",
        totalAmount: "89.00",
        subject: "赛夫严选",
        timeoutExpress: "30m",
      },
    });
    // 成功码 10000 + qr_code → success:true + qrCode
    expect(result).toEqual({ success: true, qrCode: "https://qr.alipay.com/bax0451xyz" });
  });

  it("业务失败（code≠10000）→ success:false + 网关错误信息，不返回 qrCode", async () => {
    const adapter = await loadAdapter();
    vi.spyOn(AlipaySdk.prototype, "exec").mockResolvedValue({
      code: "40004",
      msg: "Business Failed",
      sub_code: "isv.invalid-signature",
    });

    const result = await adapter.createPayment({
      orderId: "order-1",
      total: 8900,
      subject: "赛夫严选",
    });

    expect(result).toEqual({ success: false, error: "40004 Business Failed" });
  });

  it("缺少 NEXT_PUBLIC_BASE_URL → success:false，不调 exec（notifyUrl 无法拼装）", async () => {
    delete process.env.NEXT_PUBLIC_BASE_URL;
    const adapter = await loadAdapter();
    const execSpy = vi.spyOn(AlipaySdk.prototype, "exec");

    const result = await adapter.createPayment({
      orderId: "order-1",
      total: 8900,
      subject: "赛夫严选",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("NEXT_PUBLIC_BASE_URL");
    expect(execSpy).not.toHaveBeenCalled();
  });

  it("支付宝未配置 → success:false 降级（不抛错）", async () => {
    delete process.env.ALIPAY_APP_ID;
    delete process.env.ALIPAY_PRIVATE_KEY;
    delete process.env.ALIPAY_PUBLIC_KEY;

    const adapter = await loadAdapter();
    const result = await adapter.createPayment({
      orderId: "order-1",
      total: 8900,
      subject: "赛夫严选",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("支付宝未配置");
  });
});

// ── verifyCallback：验签前 app_id 归属强校验（D4）──

describe("paymentAdapter.verifyCallback — app_id 归属核验", () => {
  it("app_id 匹配自身配置 → 走 checkNotifySign 验签（返回 true）", async () => {
    const adapter = await loadAdapter();
    const checkSpy = vi.spyOn(AlipaySdk.prototype, "checkNotifySign").mockResolvedValue(true);

    const result = await adapter.verifyCallback({ app_id: "2021000000000000", sign: "abc" });

    expect(result).toBe(true);
    expect(checkSpy).toHaveBeenCalled();
  });

  it("app_id 与自身配置不符（跨应用伪造）→ 直接拒绝，不调 checkNotifySign", async () => {
    const adapter = await loadAdapter();
    const checkSpy = vi.spyOn(AlipaySdk.prototype, "checkNotifySign");

    const result = await adapter.verifyCallback({ app_id: "9999999999", sign: "abc" });

    expect(result).toBe(false);
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it("D4：app_id 缺失 → 直接拒绝（无条件强校验，不再跳过归属核验）", async () => {
    // 修复前 `body.app_id &&` 条件判断在缺失时整体跳过，依赖 checkNotifySign 的签名覆盖兜底；
    // 修复后无条件强校验，缺失一律拒绝（支付宝通知必带 app_id）。
    const adapter = await loadAdapter();
    const checkSpy = vi.spyOn(AlipaySdk.prototype, "checkNotifySign");

    const result = await adapter.verifyCallback({ sign: "abc" });

    expect(result).toBe(false);
    expect(checkSpy).not.toHaveBeenCalled();
  });
});
