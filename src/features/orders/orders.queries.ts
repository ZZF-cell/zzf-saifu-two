// 订单查询 — 列表/详情（只读）
import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { decrypt } from "@/shared/utils/crypto";
import type { Prisma } from "@prisma/client";

function decryptAddress(shippingAddress: string): string {
  if (!process.env.ENCRYPTION_KEYS) return shippingAddress; // 开发环境明文
  try {
    return decrypt(shippingAddress);
  } catch {
    // 解密失败返回原始字符串（可能是旧数据或明文）
    return shippingAddress;
  }
}

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

// ── 订单摘要查询（用户列表 / 品牌方订单列表共用） ──

async function queryOrderSummaries(
  where: Prisma.OrderWhereInput,
  page: number,
  pageSize: number,
): Promise<OrderListResult> {
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
        _count: { select: { items: true } },
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
      itemCount: o._count.items, // 真实商品行数（_count 聚合，不再硬编码 0）
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

// ── 我的订单列表 ──

export async function getOrderList(
  userId: string,
  page = 1,
  pageSize = 20,
): Promise<OrderListResult> {
  return queryOrderSummaries(
    {
      userId,
      // 不排除已销毁订单，用户可看到「已销毁」标记
    },
    page,
    pageSize,
  );
}

// ── 品牌方订单列表（按品牌商品过滤，README 二期：品牌后台查看自己的订单） ──

/**
 * 品牌方订单列表 — 返回本品牌商品行的聚合，绝不泄漏整单金额/其他品牌商品名
 *
 * 关键隐私边界：多品牌混合订单中，品牌 A 只能看到自己商品行的
 * brandSubtotal（本品牌行 price 之和，price 为行总额）与本品牌首个商品名，
 * 不返回 Order.total（含其他品牌金额）也不返回其他品牌的 firstItemName。
 */
export interface BrandOrderRow {
  id: string;
  status: string;
  createdAt: Date;
  paidAt: Date | null;
  isDestroyed: boolean;
  brandSubtotal: number; // 本品牌商品行小计（分）= 各行 price 之和（price 已含 qty）
  firstItemName: string; // 本品牌首个商品名
}

export interface BrandOrderListResult {
  orders: BrandOrderRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function getOrderListByBrand(
  brandProductIds: string[],
  page = 1,
  pageSize = 20,
): Promise<BrandOrderListResult> {
  if (brandProductIds.length === 0) {
    return { orders: [], total: 0, page, pageSize };
  }

  const where: Prisma.OrderWhereInput = {
    items: { some: { productId: { in: brandProductIds } } },
  };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      select: {
        id: true,
        status: true,
        createdAt: true,
        paidAt: true,
        privacy: true,
        // 只取本品牌商品行：跨品牌行的金额/名称不进入品牌方视图
        items: {
          where: { productId: { in: brandProductIds } },
          select: { productName: true, price: true, qty: true },
          orderBy: { id: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  return {
    orders: orders.map((o) => {
      const brandItems = o.items;
      // OrderItem.price 为「实付分摊后的行总额」（已含 ×qty，见 calculateOrderItems），
      // 小计直接求和即可，不可再乘 qty（否则膨胀 qty 倍）
      const brandSubtotal = brandItems.reduce(
        (sum, it) => sum + it.price,
        0,
      );
      return {
        id: o.id,
        status: o.status,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        isDestroyed: isOrderDestroyed(o.privacy as Record<string, unknown> | null),
        brandSubtotal,
        firstItemName: brandItems[0]?.productName || "商品",
      };
    }),
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
    // 已销毁订单不展示收货地址；正常订单先尝试解密
    shippingAddress: destroyed ? "[DESTROYED]" : decryptAddress(order.shippingAddress),
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
