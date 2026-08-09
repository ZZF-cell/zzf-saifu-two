// 支付适配器接口 + 支付宝沙箱实现
// 策略：定义 PaymentAdapter 接口，支付宝实现，微信支付（二期）复用同一接口
//
// 环境变量（全部可选，未配置时优雅降级）：
//   ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY（PKCS1）/ ALIPAY_PUBLIC_KEY / ALIPAY_GATEWAY
//   NEXT_PUBLIC_BASE_URL（notifyUrl / returnUrl 基础地址）

import AlipaySdk from "alipay-sdk";
import { fenToYuan } from "@/shared/utils/money";

export interface CreatePaymentParams {
  orderId: string;
  total: number; // 分
  subject: string;
}

export interface CreatePaymentResult {
  success: boolean;
  payUrl?: string;
  tradeNo?: string;
  error?: string;
}

export interface PaymentAdapter {
  createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult>;
  verifyCallback(body: Record<string, string>): Promise<boolean>;
}

// ── 支付宝 SDK 懒初始化 ──
// 环境变量未配置时不构造 SDK（模块加载阶段不抛错，下单流程可降级为 null payUrl）

let alipaySdk: AlipaySdk | null = null;
let unavailableReason: string | null = null;

function detectKeyType(privateKey: string): "PKCS1" | "PKCS8" {
  // SDK 默认按 PKCS1（BEGIN RSA PRIVATE KEY）解析，官方密钥工具默认生成 PKCS8（BEGIN PRIVATE KEY）
  // 通过 PEM 头自动识别，避免用户手动配置 keyType
  return /BEGIN PRIVATE KEY/i.test(privateKey) &&
    !/BEGIN RSA PRIVATE KEY/i.test(privateKey)
    ? "PKCS8"
    : "PKCS1";
}

function getAlipaySdk(): AlipaySdk | null {
  if (alipaySdk) return alipaySdk;
  if (unavailableReason) return null;

  const appId = process.env.ALIPAY_APP_ID;
  const privateKey = process.env.ALIPAY_PRIVATE_KEY;
  const alipayPublicKey = process.env.ALIPAY_PUBLIC_KEY;

  if (!appId || !privateKey || !alipayPublicKey) {
    const missing = ["ALIPAY_APP_ID", "ALIPAY_PRIVATE_KEY", "ALIPAY_PUBLIC_KEY"]
      .filter((key) => !process.env[key])
      .join(", ");
    unavailableReason = `支付宝未配置，缺少环境变量: ${missing}`;
    return null;
  }

  alipaySdk = new AlipaySdk({
    appId,
    privateKey,
    // 支付宝公钥必须是平台返回的 SPKI 格式（BEGIN PUBLIC KEY），误传 PKCS1 会导致验签静默失败
    alipayPublicKey,
    keyType: detectKeyType(privateKey),
    gateway:
      process.env.ALIPAY_GATEWAY ||
      "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
    signType: "RSA2",
  });
  return alipaySdk;
}

function getBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL ||
    `http://localhost:${process.env.PORT || 3000}`
  );
}

// ── 支付宝沙箱适配器 ──

export function createAlipayAdapter(): PaymentAdapter {
  return {
    async createPayment(params) {
      const sdk = getAlipaySdk();
      if (!sdk) {
        return { success: false, error: unavailableReason || "支付宝未配置" };
      }

      try {
        // 金额（分 → 元字符串）必须经 money 工具，禁止原生除法
        const totalYuan = fenToYuan(params.total);
        const baseUrl = getBaseUrl();

        // 页面支付：method:'GET' 返回带 RSA2 签名的网关跳转 URL
        // ⚠️ 不传 method 时 pageExec 默认返回 POST 自动提交的 HTML 表单，不是 URL
        const payUrl = sdk.pageExec("alipay.trade.page.pay", {
          method: "GET",
          // notifyUrl/returnUrl 必须放顶层（公共参数），不放 bizContent
          notifyUrl: `${baseUrl}/api/orders/${params.orderId}/paid`,
          returnUrl: `${baseUrl}/orders/${params.orderId}`,
          bizContent: {
            outTradeNo: params.orderId,
            productCode: "FAST_INSTANT_TRADE_PAY",
            totalAmount: totalYuan,
            subject: params.subject,
            timeoutExpress: "30m",
          },
        });

        return { success: true, payUrl };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, error: msg };
      }
    },

    async verifyCallback(body) {
      const sdk = getAlipaySdk();
      // 未配置无法验签 — 一律拒绝（安全默认：宁可不处理也不放过伪造回调）
      if (!sdk) return false;
      try {
        // raw=true：异步通知是 POST 表单，值已被 URLSearchParams 标准解码，
        // raw=false 会对值二次 decodeURIComponent（值含 % 时会抛错/验签失败）
        return sdk.checkNotifySign(body, true);
      } catch {
        return false;
      }
    },
  };
}

// 单例
export const paymentAdapter: PaymentAdapter = createAlipayAdapter();
