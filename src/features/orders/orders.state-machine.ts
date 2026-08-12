// 订单状态机 — 纯函数，零依赖，100% 可单元测试
// 定义合法状态转换，所有订单状态变更必须经过此模块

export const ORDER_STATUS = {
  PENDING: "PENDING",
  PAID: "PAID",
  SHIPPED: "SHIPPED",
  DELIVERED: "DELIVERED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  REFUND_REQUESTED: "REFUND_REQUESTED",
  REFUNDED: "REFUNDED",
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

/**
 * 合法状态转换表
 *
 * 契约来源 README API 表：取消订单仅 PENDING、申请退款仅 PAID。
 * 已发货/已完成/已退款的订单不可直接「取消」——实物已出库，需走退款/售后流程。
 * 销毁（destroy）不改变 status，仅擦除用户端隐私字段，故不在转换表中。
 *
 * PENDING ──→ PAID ──→ SHIPPED ──→ DELIVERED ──→ COMPLETED
 *    │
 *    └──→ CANCELLED（仅 PENDING 可取消）
 *
 * REFUND_REQUESTED ←── PAID（用户申请退款）
 *    │
 *    └──→ REFUNDED（管理员同意退款）
 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [ORDER_STATUS.PENDING]: [
    ORDER_STATUS.PAID,
    ORDER_STATUS.CANCELLED,
  ],
  [ORDER_STATUS.PAID]: [
    ORDER_STATUS.SHIPPED,
    ORDER_STATUS.REFUND_REQUESTED,
  ],
  [ORDER_STATUS.SHIPPED]: [
    ORDER_STATUS.DELIVERED,
  ],
  [ORDER_STATUS.DELIVERED]: [
    ORDER_STATUS.COMPLETED,
  ],
  [ORDER_STATUS.COMPLETED]: [], // 终态（销毁不改变状态）
  [ORDER_STATUS.CANCELLED]: [], // 终态
  [ORDER_STATUS.REFUND_REQUESTED]: [
    ORDER_STATUS.REFUNDED,
  ],
  [ORDER_STATUS.REFUNDED]: [], // 终态（销毁不改变状态）
};

/** 允许取消的状态（用户或系统发起）— 仅 PENDING，实物未出库，可安全回补库存 */
const CANCELLABLE_STATUSES: OrderStatus[] = [
  ORDER_STATUS.PENDING,
];

/** 允许申请退款的状态 — 仅 PAID（README API 契约） */
export const REFUNDABLE_STATUSES: OrderStatus[] = [
  ORDER_STATUS.PAID,
];

/** 允许支付回调更新为 PAID 的状态（仅 PENDING） */
const PAYABLE_STATUSES: OrderStatus[] = [ORDER_STATUS.PENDING];

/** 允许支付查询的状态 */
export const PAY_QUERYABLE_STATUSES: OrderStatus[] = [
  ORDER_STATUS.PENDING,
];

/**
 * 检查是否可以从 current 转换到 target
 */
export function canTransitionTo(
  current: OrderStatus,
  target: OrderStatus,
): boolean {
  const allowed = ALLOWED_TRANSITIONS[current];
  if (!allowed) return false;
  return allowed.includes(target);
}

/**
 * 断言状态转换合法性，非法时抛出
 */
export function assertTransition(
  current: OrderStatus,
  target: OrderStatus,
  orderId: string,
): void {
  if (!canTransitionTo(current, target)) {
    throw new Error(
      `订单 ${orderId} 状态转换非法: ${current} → ${target}`,
    );
  }
}

/**
 * 获取一个状态的所有合法目标状态
 */
export function getAllowedTransitions(current: OrderStatus): OrderStatus[] {
  return ALLOWED_TRANSITIONS[current] || [];
}

/**
 * 判断订单是否可取消
 */
export function isCancellable(status: OrderStatus): boolean {
  return CANCELLABLE_STATUSES.includes(status);
}

/**
 * 判断订单是否可申请退款
 */
export function isRefundable(status: OrderStatus): boolean {
  return REFUNDABLE_STATUSES.includes(status);
}

/**
 * 判断订单是否可被支付宝回调标记为已支付
 * 仅 PENDING 状态的订单可被支付（回调幂等）
 */
export function isPayable(status: OrderStatus): boolean {
  return PAYABLE_STATUSES.includes(status);
}

/**
 * 判断订单是否可销毁（用户隐私擦除）
 * 后台保留数据，仅用户端不可见
 */
export function isDestroyable(status: OrderStatus): boolean {
  return (["CANCELLED", "COMPLETED", "REFUNDED"] as readonly string[]).includes(status);
}
