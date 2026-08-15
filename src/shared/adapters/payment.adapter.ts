// 支付适配器接口 + 支付宝沙箱实现
// 策略：定义 PaymentAdapter 接口，支付宝实现，微信支付（二期）复用同一接口
//
// 环境变量（全部可选，未配置时优雅降级）：
//   ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY（PKCS1）/ ALIPAY_PUBLIC_KEY / ALIPAY_GATEWAY
//   NEXT_PUBLIC_BASE_URL（notifyUrl / returnUrl 基础地址）
//
// ⚠️ 时区陷阱：alipay-sdk 内部用 moment() 生成请求 timestamp（服务器本地时区），
// 而支付宝网关按「北京时间」校验时间戳，偏差超范围直接判验签失败（沙箱实测偏差 8h 必失败）。
// 服务器时区不可控（Vercel 是 UTC），故必须显式传入北京时间，覆盖 SDK 默认。

import AlipaySdk from "alipay-sdk";
import { fenToYuan, yuanToFen } from "@/shared/utils/money";

/**
 * 生成北京时间（UTC+8）的 `YYYY-MM-DD HH:mm:ss` 字符串
 * 供支付宝请求 timestamp 使用 — 不依赖服务器本地时区
 */
export function getBeijingTimestamp(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export interface CreatePaymentParams {
  orderId: string;
  total: number; // 分
  subject: string;
  /** 支付宝侧超时（如 "30m"）。缺省 "30m"；调用方按订单剩余支付时间传，避免「订单先被自动取消、支付后到」的资损空窗 */
  timeoutExpress?: string;
}

export interface CreatePaymentResult {
  success: boolean;
  /** 当面付二维码内容（alipay.trade.precreate 返回 qr_code），前端渲染二维码供支付宝 App 扫码 */
  qrCode?: string;
  tradeNo?: string;
  error?: string;
}

export interface QueryPaymentParams {
  outTradeNo: string;
}

export interface QueryPaymentResult {
  success: boolean;
  /** 网关返回码，10000 表示业务成功 */
  code?: string;
  /** 支付宝交易状态：TRADE_SUCCESS / TRADE_FINISHED / WAIT_BUYER_PAY / TRADE_CLOSED ... */
  tradeStatus?: string | null;
  /** 商户订单号（应等于查询入参 outTradeNo） */
  outTradeNo?: string | null;
  /** 实际支付金额（元 → 分），用于与订单快照核验，防止回调金额被篡改 */
  totalAmountFen?: number | null;
  /** 支付宝交易流水号（trade_no），区别于商户 outTradeNo */
  alipayTradeNo?: string | null;
  error?: string;
}

export interface PaymentAdapter {
  createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult>;
  verifyCallback(body: Record<string, string>): Promise<boolean>;
  queryPayment(params: QueryPaymentParams): Promise<QueryPaymentResult>;
}

// ── 支付宝 SDK 懒初始化 ──
// 环境变量未配置时不构造 SDK（模块加载阶段不抛错，下单流程可降级为 null qrCode）

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
    // ⚠️ SDK 默认 camelcase:true 会把 exec 响应字段转驼峰（qr_code→qrCode），
    // 而支付宝文档按 snake_case（out_trade_no/qr_code）描述，适配器按 snake_case 解析。
    // 显式关闭驼峰转换，避免响应字段读取落空（precreate 返回 qr_code 读成 undefined）
    camelcase: false,
  });
  return alipaySdk;
}

// 回调基础地址 — README 标 NEXT_PUBLIC_BASE_URL 为必填
// 缺失时返回 null（createPayment 报错），不静默回退 localhost——
// 否则生产环境 notifyUrl 指向 localhost，回调永远收不到、订单卡 PENDING
function getBaseUrl(): string | null {
  return process.env.NEXT_PUBLIC_BASE_URL ?? null;
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
        if (!baseUrl) {
          return {
            success: false,
            error: "缺少 NEXT_PUBLIC_BASE_URL（支付回调地址基础域名），请在环境变量中配置",
          };
        }

        // 当面付扫码：exec 返回 JSON（qr_code 二维码内容），非 pageExec 的跳转 URL。
        // 为什么不用页面支付：支付宝沙箱 PC 收银台（alipay.trade.page.pay 跳转）在现代浏览器
        // 常因第三方 Cookie 拦截 / 沙箱老收银台兼容问题白屏，当面付二维码在沙箱环境稳定。
        // 无 returnUrl（扫码无页面回跳）—— 支付完成靠异步通知（生产）+ 主动查询（本地/兜底）。
        // timestamp 必须显式传北京时间（getBeijingTimestamp），否则服务器本地时区
        // （Vercel=UTC）生成的时间戳比支付宝晚 8h，网关验签必失败
        const result = (await sdk.exec("alipay.trade.precreate", {
          timestamp: getBeijingTimestamp(),
          // notifyUrl 放顶层（公共参数），不放 bizContent
          notifyUrl: `${baseUrl}/api/orders/${params.orderId}/paid`,
          bizContent: {
            outTradeNo: params.orderId,
            totalAmount: totalYuan,
            subject: params.subject,
            timeoutExpress: params.timeoutExpress ?? "30m",
          },
        })) as {
          code?: string;
          msg?: string;
          out_trade_no?: string;
          qr_code?: string;
        };

        // 业务成功码 10000 才返回二维码；其余（缺钱/限流/风控等）透传网关错误供上层提示
        if (result.code !== "10000") {
          return {
            success: false,
            error: `${result.code ?? "UNKNOWN"} ${result.msg ?? ""}`.trim(),
          };
        }
        return { success: true, qrCode: result.qr_code };
      } catch (error: unknown) {
        // alipay-sdk 对非业务错误会把 message 统一覆盖为 "[AlipaySdk]exec error"，
        // 真实原因在 error.data / error.serverResult / 网络层字段里，需完整打印定位
        console.error("[payment.adapter] createPayment 异常:", error);
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, error: msg };
      }
    },

    async verifyCallback(body) {
      const sdk = getAlipaySdk();
      // 未配置无法验签 — 一律拒绝（安全默认：宁可不处理也不放过伪造回调）
      if (!sdk) return false;

      // 二次核验 app_id：必须等于自身配置，防止跨应用伪造回调
      // （appId 属 adapter 配置域，统一在此读取 env，feature 层不再直读 process.env）
      if (body.app_id && body.app_id !== process.env.ALIPAY_APP_ID) {
        return false;
      }
      try {
        // raw=true：异步通知是 POST 表单，值已被 URLSearchParams 标准解码，
        // raw=false 会对值二次 decodeURIComponent（值含 % 时会抛错/验签失败）
        return sdk.checkNotifySign(body, true);
      } catch {
        return false;
      }
    },

    async queryPayment(params) {
      const sdk = getAlipaySdk();
      if (!sdk) {
        return { success: false, error: unavailableReason || "支付宝未配置" };
      }
      try {
        // exec 与 pageExec 同理由：timestamp 必须显式传北京时间，
        // 否则服务器本地时区（Vercel=UTC）生成的时间戳比支付宝晚 8h，网关验签必失败
        const result = (await sdk.exec("alipay.trade.query", {
          timestamp: getBeijingTimestamp(),
          bizContent: { outTradeNo: params.outTradeNo },
        })) as {
          code?: string;
          msg?: string;
          trade_status?: string;
          out_trade_no?: string;
          total_amount?: string;
          trade_no?: string;
        };
        return {
          success: true,
          code: result.code,
          tradeStatus: result.trade_status ?? null,
          outTradeNo: result.out_trade_no ?? null,
          // total_amount（元）→ 分，与订单快照核验；缺失置 null（调用方按不可用处理）
          totalAmountFen: result.total_amount ? yuanToFen(result.total_amount) : null,
          alipayTradeNo: result.trade_no ?? null,
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, error: msg };
      }
    },
  };
}

// 单例
export const paymentAdapter: PaymentAdapter = createAlipayAdapter();
