// 支付 API Route Handlers
import { NextResponse } from "next/server";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
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
      // 走统一 ERROR_CODES + apiError，避免散落裸字符串错误码
      throw new AppError(ERROR_CODES.PAYMENT_NOT_CONFIGURED, "支付功能暂未配置");
    }

    return NextResponse.json({ payUrl });
  } catch (error) {
    return apiError(error);
  }
}
