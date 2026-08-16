// 共享状态徽标 — 合并品牌/管理后台重复实现，统一状态文案与配色
// 覆盖：品牌/商品/订单/邀请码状态 + 商品生命周期新增 DELISTED/WITHDRAWN。
// 注意：PENDING 在订单语境下实为「待付款」，但徽标只看状态字符串无法区分业务域，
// 订单详情页已有 OrderStatusBadge（orders.components）做精确文案，此处沿用既有泛化文案。
"use client";

export const STATUS_LABEL: Record<string, string> = {
  // 品牌 / 商品
  PENDING: "待审核",
  APPROVED: "已通过",
  REJECTED: "已拒绝",
  DELISTED: "已下架",
  WITHDRAWN: "已撤回",
  // 订单
  PAID: "已支付",
  SHIPPED: "已发货",
  TO_SHIP: "待发货", // 组合筛选（PAID+SHIPPED），非真实订单状态，仅看板/筛选标签用
  DELIVERED: "已送达",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  REFUND_REQUESTED: "退款中",
  REFUNDED: "已退款",
  // 邀请码
  UNUSED: "待使用",
  USED: "已使用",
  EXPIRED: "已过期",
  DISABLED: "已作废",
};

export function StatusBadge({ status }: { status: string }) {
  const color =
    status === "APPROVED" || status === "PAID" || status === "COMPLETED"
      ? "bg-green-100 text-green-700"
      : status === "PENDING" || status === "REFUND_REQUESTED"
        ? "bg-yellow-100 text-yellow-700"
        : "bg-gray-100 text-gray-600";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${color}`}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}
