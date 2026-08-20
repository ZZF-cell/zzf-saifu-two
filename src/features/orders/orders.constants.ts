// 订单纯常量 + 纯函数 — 零依赖，client/server 双侧可安全 import
//
// 独立于 orders.service（后者 import prisma/alipay-sdk，经 index barrel 会拉进 client 图）。
// orders.queries 与前端倒计时都要算「支付截止时间」，统一在此提供唯一真相源，
// 防止「展示倒计时」与「实际取消时机」（Inngest sweep / check-paid 惰性取消）不一致。

/** 支付超时时间（30 分钟）— 下单 expiresAt 与 Inngest 超时取消共用 */
export const ORDER_PAYMENT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 订单支付截止时间（ISO 字符串）— 过期口径 = 下单 createdAt + ORDER_PAYMENT_TIMEOUT_MS，
 * 不落库列，由 createdAt 派生（与 orders.service.checkPaymentStatus / cancelExpiredOrder 一致）。
 * toISOString()（UTC）序列化，前端 Date.parse 差值计算，无时区偏移。
 */
export function getExpiresAt(createdAt: Date): string {
  return new Date(createdAt.getTime() + ORDER_PAYMENT_TIMEOUT_MS).toISOString();
}

/**
 * 距支付截止的剩余毫秒（负值钳为 0）— 用绝对时间差而非累计计时，后台标签冻结后切回仍准。
 * now 参数由调用方注入（倒计时组件传每秒 tick 的时钟），不传则取 Date.now()，纯函数可直测。
 */
export function getRemainingMs(expiresAt: string, now = Date.now()): number {
  return Math.max(0, new Date(expiresAt).getTime() - now);
}

/** 倒计时展示格式；最后 60 秒 urgent=true 触发警示样式 */
export function formatCountdown(msLeft: number): { text: string; urgent: boolean } {
  const totalSec = Math.ceil(msLeft / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return {
    text: `支付剩余 ${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`,
    urgent: totalSec <= 60,
  };
}
