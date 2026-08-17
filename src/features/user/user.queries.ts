// 用户查询 — 个人信息 + 订单统计（只读）
import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { ORDER_STATUS, ORDER_STATUS_GROUPS } from "@/features/orders";
import type { UserProfile } from "./user.types";

// ── 个人信息 + 订单统计 ──

export async function getProfile(userId: string): Promise<UserProfile> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { nickname: true, role: true, ageVerified: true, createdAt: true },
  });

  if (!user) throw new AppError(ERROR_CODES.UNAUTHORIZED, "用户不存在");

  // 订单统计：按状态分组计数，避免 N+1。
  // destroyedAt: null — 已销毁订单用户侧不可见（隐私契约，README §销毁），
  // 统计口径与订单列表一致，否则「个人中心卡片数字 ≠ 列表条数」。
  const grouped = await prisma.order.groupBy({
    by: ["status"],
    where: { userId, destroyedAt: null },
    _count: { _all: true },
  });

  const countByStatus = (status: string) =>
    grouped.find((g) => g.status === status)?._count._all ?? 0;

  return {
    ...user,
    stats: {
      totalOrders: grouped.reduce((sum, g) => sum + g._count._all, 0),
      pendingPayment: countByStatus(ORDER_STATUS.PENDING),
      // 与订单列表 Tab / ORDER_STATUS_GROUPS 同口径（单一事实来源），
      // 保证「个人中心卡片数字 = 对应状态订单列表条数」
      paidOrders: ORDER_STATUS_GROUPS.paid.reduce(
        (sum, s) => sum + countByStatus(s),
        0,
      ),
      cancelledOrders: ORDER_STATUS_GROUPS.cancelled.reduce(
        (sum, s) => sum + countByStatus(s),
        0,
      ),
    },
  };
}
