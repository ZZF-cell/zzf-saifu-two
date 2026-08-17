// User 模块 DTO 类型 — client-safe（纯类型，零依赖）
//
// M14 seam 加固（H）：把 user.queries 中供消费端使用的 DTO 类型收拢到独立 types 文件，
// 与实现（prisma 查询）物理隔离 —— client 组件可安全 `import type` 而不必触碰
// user.queries（imports prisma）。本文件禁止引入任何 server 依赖。

export interface OrderStats {
  totalOrders: number; // 全部订单
  pendingPayment: number; // 待付款
  paidOrders: number; // 已支付（含发货中/已完成）
  cancelledOrders: number; // 已取消/已退款
}

export interface UserProfile {
  nickname: string | null;
  role: string;
  ageVerified: boolean;
  createdAt: Date;
  stats: OrderStats;
}
