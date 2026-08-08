// 订单查询 — 列表/详情（只读）
import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import type { Prisma } from "@prisma/client";

// ── 类型 ──

export interface OrderListResult {
  orders: OrderSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OrderSummary {
  id: string;
  total: number;
  status: string;
  itemCount: number;
  firstItemName: string;
  createdAt: Date;
  paidAt: Date | null;
  isDestroyed: boolean;
}

export interface OrderDetail {
  id: string;
  total: number;
  status: string;
  shippingAddress: string;
  privacy: unknown;
  outTradeNo: string | null;
  paidAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  refundedAt: Date | null;
  createdAt: Date;
  isDestroyed: boolean;
  items: {
    id: string;
    productName: string;
    price: number;
    qty: number;
    productId: string | null;
  }[];
}

// ── 我的订单列表 ──

export async function getOrderList(
  userId: string,
  page = 1,
  pageSize = 20,
): Promise<OrderListResult> {
  const where: Prisma.OrderWhereInput = {
    userId,
    // 不排除已销毁订单，用户可看到「已销毁」标记
  };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      select: {
        id: true,
        total: true,
        status: true,
        privacy: true,
        createdAt: true,
        paidAt: true,
        items: { select: { productName: true }, take: 1, orderBy: { id: "asc" } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  return {
    orders: orders.map((o) => ({
      id: o.id,
      total: o.total,
      status: o.status,
      itemCount: 0, // 由前端或单独查询获取
      firstItemName: o.items[0]?.productName || "商品",
      createdAt: o.createdAt,
      paidAt: o.paidAt,
      isDestroyed: isOrderDestroyed(o.privacy as Record<string, unknown> | null),
    })),
    total,
    page,
    pageSize,
  };
}

// ── 订单详情 ──

export async function getOrderDetail(
  userId: string,
  orderId: string,
): Promise<OrderDetail> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: {
        select: {
          id: true,
          productName: true,
          price: true,
          qty: true,
          productId: true,
        },
        orderBy: { id: "asc" },
      },
    },
  });

  if (!order) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
  if (order.userId !== userId) throw new AppError(ERROR_CODES.ORDER_NOT_OWNED, "无权查看该订单");

  const destroyed = isOrderDestroyed(order.privacy as Record<string, unknown> | null);

  return {
    id: order.id,
    total: order.total,
    status: order.status,
    // 已销毁订单不展示收货地址
    shippingAddress: destroyed ? "[DESTROYED]" : order.shippingAddress,
    privacy: order.privacy,
    outTradeNo: order.outTradeNo,
    paidAt: order.paidAt,
    shippedAt: order.shippedAt,
    deliveredAt: order.deliveredAt,
    completedAt: order.completedAt,
    cancelledAt: order.cancelledAt,
    refundedAt: order.refundedAt,
    createdAt: order.createdAt,
    isDestroyed: destroyed,
    items: order.items,
  };
}

// ── 辅助 ──

function isOrderDestroyed(privacy: Record<string, unknown> | null): boolean {
  return !!(privacy && (privacy as { destroyed?: boolean }).destroyed);
}
