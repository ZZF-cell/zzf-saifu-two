// 支付适配器接口 + 支付宝沙箱实现
// 策略：定义 PaymentAdapter 接口，支付宝实现，微信支付（二期）复用同一接口

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

export interface PaymentCallbackParams {
  tradeNo: string;
  outTradeNo: string;
  totalAmount: string;
  sellerId: string;
  appId: string;
}

export interface PaymentAdapter {
  createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult>;
  verifyCallback(params: PaymentCallbackParams): Promise<boolean>;
}

// ── 支付宝沙箱适配器 ──

export function createAlipayAdapter(): PaymentAdapter {
  const gateway =
    process.env.ALIPAY_GATEWAY ||
    "https://openapi-sandbox.dl.alipaydev.com/gateway.do";
  const appId = process.env.ALIPAY_APP_ID;
  const privateKey = process.env.ALIPAY_PRIVATE_KEY;

  return {
    async createPayment(params) {
      try {
        if (!appId || !privateKey) {
          return { success: false, error: "支付宝未配置: ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY" };
        }
        // TODO: 初始化 alipay-sdk 并调用 alipay.trade.page.pay
        const totalYuan = (params.total / 100).toFixed(2);
        const payUrl = `${gateway}?app_id=${appId}&out_trade_no=${params.orderId}&total_amount=${totalYuan}&subject=${encodeURIComponent(params.subject)}`;
        return { success: true, payUrl };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, error: msg };
      }
    },

    async verifyCallback(_params) {
      // TODO: 实现签名验证
      // const result = alipaySdk.checkNotifySign(params);
      return true;
    },
  };
}

// 单例
export const paymentAdapter: PaymentAdapter = createAlipayAdapter();
