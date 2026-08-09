// 支付 API Route Handlers
import { NextResponse } from "next/server";
import { apiError } from "@/shared/utils/api";
import { authenticate } from "@/shared/api/auth";
import * as paymentService from "./payment.service";

/**
 * GET /api/pay/[orderId] — 获取支付跳转 URL
 * 校验订单归属 + PENDING 状态后返回支付宝网关跳转地址
 */
export async function getPay(
  req: Request,
  ctx: { params: Promise<{ orderId: string }> },
) {
  try {
    const userId = await authenticate(req);
    const { orderId } = await ctx.params;

    const { payUrl } = await paymentService.createPayment(userId, orderId);

    if (!payUrl) {
      return NextResponse.json(
        { error: "PAYMENT_NOT_CONFIGURED", message: "支付功能暂未配置" },
        { status: 503 },
      );
    }

    return NextResponse.json({ payUrl });
  } catch (error) {
    return apiError(error);
  }
}
