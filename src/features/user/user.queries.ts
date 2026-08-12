// 用户查询 — 个人信息 + 订单统计（只读）
import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { ORDER_STATUS } from "@/features/orders";

// ── 类型 ──

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

// ── 个人信息 + 订单统计 ──

export async function getProfile(userId: string): Promise<UserProfile> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { nickname: true, role: true, ageVerified: true, createdAt: true },
  });

  if (!user) throw new AppError(ERROR_CODES.UNAUTHORIZED, "用户不存在");

  // 订单统计：按状态分组计数，避免 N+1
  const grouped = await prisma.order.groupBy({
    by: ["status"],
    where: { userId },
    _count: { _all: true },
  });

  const countByStatus = (status: string) =>
    grouped.find((g) => g.status === status)?._count._all ?? 0;

  const paidFamily = [
    ORDER_STATUS.PAID,
    ORDER_STATUS.SHIPPED,
    ORDER_STATUS.DELIVERED,
    ORDER_STATUS.COMPLETED,
  ];

  return {
    ...user,
    stats: {
      totalOrders: grouped.reduce((sum, g) => sum + g._count._all, 0),
      pendingPayment: countByStatus(ORDER_STATUS.PENDING),
      paidOrders: paidFamily.reduce((sum, s) => sum + countByStatus(s), 0),
      cancelledOrders:
        countByStatus(ORDER_STATUS.CANCELLED) +
        countByStatus(ORDER_STATUS.REFUND_REQUESTED) +
        countByStatus(ORDER_STATUS.REFUNDED),
    },
  };
}
