// 订单查询 — 列表/详情（只读）
import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { decrypt } from "@/shared/utils/crypto";
import type { Prisma } from "@prisma/client";
import type { OrderListResult, OrderDetail, BrandOrderListResult } from "./orders.types";

function decryptAddress(shippingAddress: string): string {
  if (!process.env.ENCRYPTION_KEYS) return shippingAddress; // 开发环境明文
  try {
    return decrypt(shippingAddress);
  } catch {
    // 解密失败返回原始字符串（可能是旧数据或明文）
    return shippingAddress;
  }
}

// M12 隐私掩码：hideProductName=true 时，用户侧列表/详情统一显示「私密商品」。
// 掩码放查询层而非 UI 层——一处实现，列表/详情/任何消费端一致生效，且可单测。
// 品牌方订单列表/管理后台不经过此掩码（商家履约需要真实商品名）。
const MASKED_PRODUCT_NAME = "私密商品";

function maskProductName(privacy: unknown, name: string): string {
  const p = privacy as { hideProductName?: boolean } | null | undefined;
  return p?.hideProductName ? MASKED_PRODUCT_NAME : name;
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
    // 调用方（用户/品牌方）查询已带 destroyedAt: null 过滤，此处无需掩码——已销毁订单不可见。
    // M12：hideProductName=true 时首件商品名掩码为「私密商品」（仅用户列表；品牌列表独立查询不掩码）
    orders: orders.map((o) => ({
      id: o.id,
      total: o.total,
      status: o.status,
      itemCount: o._count.items,
      firstItemName: maskProductName(o.privacy, o.items[0]?.productName || "商品"),
      createdAt: o.createdAt,
      paidAt: o.paidAt,
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
  statuses?: string[],
): Promise<OrderListResult> {
  const where: Prisma.OrderWhereInput = {
    userId,
    // 已销毁订单用户不可见（destroyedAt IS NULL 才可见）；管理后台仍保留全部数据
    destroyedAt: null,
  };
  // ?status= 多状态筛选：statuses 传了（含空数组）即强制 in 条件；
  // 空数组 → in: [] → 显式空结果（API 层过滤后全非法值时不泄漏全量数据）；
  // 仅 undefined（URL 无 status 参数）才不加筛选。
  if (statuses !== undefined) {
    where.status = { in: statuses };
  }
  return queryOrderSummaries(where, page, pageSize);
}

// ── 品牌方订单列表（按品牌商品过滤，README 二期：品牌后台查看自己的订单） ──

/**
 * 品牌方订单列表 — 返回本品牌商品行的聚合，绝不泄漏整单金额/其他品牌商品名
 *
 * 关键隐私边界：多品牌混合订单中，品牌 A 只能看到自己商品行的
 * brandSubtotal（本品牌行 price 之和，price 为行总额）与本品牌首个商品名，
 * 不返回 Order.total（含其他品牌金额）也不返回其他品牌的 firstItemName。
 */
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
    // 已销毁订单品牌方同样不可见（隐私对用户与品牌一视同仁）；管理后台仍保留
    destroyedAt: null,
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
    // 已销毁订单已被 where.destroyedAt: null 过滤，此处无需掩码
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

  // E2 隐私边界：非本人订单与已销毁订单一律 404「订单不存在」。
  // 若先抛 403 ORDER_NOT_OWNED，攻击者可探测任意订单 id 是否存在（成人用品
  // 订单号即隐私）。统一 404 让订单对外不可枚举；管理后台走独立查询不受影响。
  if (
    !order ||
    order.destroyedAt ||
    order.userId !== userId
  ) {
    throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
  }

  return {
    id: order.id,
    total: order.total,
    status: order.status,
    // 配送地址 AES-256-GCM 加密存储，此处解密；解密失败返回原始字符串（可能是旧数据或明文）
    shippingAddress: decryptAddress(order.shippingAddress),
    privacy: order.privacy,
    outTradeNo: order.outTradeNo,
    paidAt: order.paidAt,
    shippedAt: order.shippedAt,
    deliveredAt: order.deliveredAt,
    completedAt: order.completedAt,
    cancelledAt: order.cancelledAt,
    refundedAt: order.refundedAt,
    createdAt: order.createdAt,
    // M12：hideProductName=true 时逐行掩码商品名（用户侧详情；商家后台独立查询不受影响）
    items: order.items.map((i) => ({
      ...i,
      productName: maskProductName(order.privacy, i.productName),
    })),
  };
}
