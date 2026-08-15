// 支付模块 — 业务逻辑（支付宝对接 + 幂等校验）
// 模块边界：orders → payment（单向）；payment → orders 经 Public API 取状态常量与幂等的超时取消函数

import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { paymentAdapter } from "@/shared/adapters/payment.adapter";
import type { QueryPaymentResult } from "@/shared/adapters/payment.adapter";
import { ORDER_STATUS, cancelExpiredOrder, ORDER_PAYMENT_TIMEOUT_MS } from "@/features/orders";

export interface CreatePaymentResult {
  /** 当面付二维码内容（支付宝 App 扫码支付），未配置时 null */
  qrCode: string | null;
}

/**
 * 为指定订单创建支付宝支付（生成当面付二维码内容，支付宝 App 扫码支付）
 *
 * 校验：
 * - 订单存在、属于当前用户
 * - 状态必须为 PENDING（已支付/已取消/已退款订单不可重复支付）
 *
 * 支付宝未配置时抛 PAYMENT_FAILED —— 下单流程会捕获该错误并降级为 null qrCode（不阻塞下单）
 */
export async function createPayment(
  userId: string,
  orderId: string,
): Promise<CreatePaymentResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, userId: true, status: true, total: true, createdAt: true },
  });

  if (!order) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
  if (order.userId !== userId) throw new AppError(ERROR_CODES.ORDER_NOT_OWNED, "无权操作该订单");
  if (order.status !== ORDER_STATUS.PENDING) {
    throw new AppError(
      ERROR_CODES.ORDER_STATUS_INVALID,
      `订单状态「${order.status}」不允许支付`,
    );
  }

  // 超时兜底：Inngest 事件丢失/未配置时，支付入口惰性取消过期订单（幂等，状态守卫）
  // 避免「订单早已过期、用户仍能拉起支付」——过期支付会落空窗需人工退款
  // 过期时间 = 下单 createdAt + ORDER_PAYMENT_TIMEOUT_MS（不落库列，与下单/取消口径一致）
  const expiresAt = new Date(order.createdAt.getTime() + ORDER_PAYMENT_TIMEOUT_MS);
  if (expiresAt.getTime() <= Date.now()) {
    await cancelExpiredOrder(orderId);
    throw new AppError(ERROR_CODES.ORDER_STATUS_INVALID, "订单已超时未支付，已自动取消，请重新下单");
  }

  // 支付宝 timeoutExpress 从支付页拉起起算，而订单自动取消从创建起算：
  // 剩余不足 1 分钟直接拒付（马上过期），否则把支付宝超时钳制到 ≤ 订单剩余时间，
  // 保证「订单被自动取消」必然发生在「支付宝允许支付」之后，杜绝支付后到落空窗
  const remaining = expiresAt.getTime() - Date.now();
  if (remaining < 60_000) {
    throw new AppError(ERROR_CODES.ORDER_STATUS_INVALID, "订单即将超时，请重新下单");
  }
  const timeoutExpress = `${Math.min(30, Math.ceil(remaining / 60_000))}m`;

  const result = await paymentAdapter.createPayment({
    orderId: order.id,
    total: order.total,
    // 隐私优先：成人用品平台支付描述不展示商品名
    subject: "赛夫严选",
    timeoutExpress,
  });

  if (!result.success) {
    throw new AppError(ERROR_CODES.PAYMENT_FAILED, result.error || "支付创建失败");
  }

  return { qrCode: result.qrCode ?? null };
}

/**
 * 主动查询支付宝交易状态（alipay.trade.query）
 *
 * 场景：本地沙箱异步通知（notifyUrl=localhost）收不到，用户点「查询支付」/支付回跳页
 * 自动查询时使用 —— 真正向支付宝网关核对交易终态，而非只读本地 DB。
 *
 * 透传 adapter 结果；支付宝未配置 / 网关异常时 success=false（调用方优雅降级，不抛错）。
 */
export async function queryAlipayTrade(
  outTradeNo: string,
): Promise<QueryPaymentResult> {
  return paymentAdapter.queryPayment({ outTradeNo });
}
