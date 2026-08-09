// 支付模块 — 业务逻辑（支付宝对接 + 幂等校验）
// 模块边界：orders → payment（单向）；payment → orders 仅经 Public API 取状态常量

import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { paymentAdapter } from "@/shared/adapters/payment.adapter";
import { ORDER_STATUS } from "@/features/orders";

export interface CreatePaymentResult {
  payUrl: string | null;
}

/**
 * 为指定订单创建支付宝支付（生成签名后的支付跳转 URL）
 *
 * 校验：
 * - 订单存在、属于当前用户
 * - 状态必须为 PENDING（已支付/已取消/已退款订单不可重复支付）
 *
 * 支付宝未配置时抛 PAYMENT_FAILED —— 下单流程会捕获该错误并降级为 null payUrl（不阻塞下单）
 */
export async function createPayment(
  userId: string,
  orderId: string,
): Promise<CreatePaymentResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, userId: true, status: true, total: true },
  });

  if (!order) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
  if (order.userId !== userId) throw new AppError(ERROR_CODES.ORDER_NOT_OWNED, "无权操作该订单");
  if (order.status !== ORDER_STATUS.PENDING) {
    throw new AppError(
      ERROR_CODES.ORDER_STATUS_INVALID,
      `订单状态「${order.status}」不允许支付`,
    );
  }

  const result = await paymentAdapter.createPayment({
    orderId: order.id,
    total: order.total,
    // 隐私优先：成人用品平台支付描述不展示商品名
    subject: "赛夫严选",
  });

  if (!result.success) {
    throw new AppError(ERROR_CODES.PAYMENT_FAILED, result.error || "支付创建失败");
  }

  return { payUrl: result.payUrl ?? null };
}
