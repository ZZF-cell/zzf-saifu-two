// 订单领域服务 — Prisma $transaction 业务流程
// 核心：乐观锁防超卖 + calculateOrderItems 优惠分摊 + 支付回调幂等

import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { multiplyFen, sumFen, distributeDiscount } from "@/shared/utils/money";
import {
  ORDER_STATUS,
  canTransitionTo,
  isCancellable,
  isRefundable,
  isPayable,
  isDestroyable,
} from "./orders.state-machine";
import type { OrderStatus } from "./orders.state-machine";

// ── 类型 ──

export interface CreateOrderItem {
  productId: string;
  qty: number;
}

export interface CreateOrderInput {
  items: CreateOrderItem[];
  shippingAddress: {
    name: string;
    phone: string;
    province: string;
    city: string;
    district: string;
    detail: string;
    zipCode?: string;
  };
  privacy: {
    anonymousPackaging: boolean;
    hideProductName: boolean;
  };
}

export interface CreateOrderResult {
  orderId: string;
  total: number;
  currency: string;
  status: string;
  payUrl: string | null;
  expiresAt: string;
}

// ── 优惠分摊 — 核心计算逻辑 ──

/**
 * 计算每个 OrderItem 的实付分摊价（含优惠券/满减按比例分摊）
 *
 * @param items    原始商品列表 { productId, unitPrice(分), qty }
 * @param discount 总优惠金额（分），MVP 阶段为 0
 * @returns         每个 item 的 { productId, productName, price(实付分摊), qty }
 *
 * 单元测试覆盖：
 * - 无优惠：分摊价 = 单价
 * - 有优惠：按金额比例分摊
 * - 全部退款：所有项 price > 0
 * - 部分退款：仅选中项参与退款计算
 * - 跨优惠门槛：分摊后总额 = 原总额 - 优惠
 */
export function calculateOrderItems(
  items: { productId: string; productName: string; unitPrice: number; qty: number }[],
  discount: number,
): { productId: string; productName: string; price: number; qty: number }[] {
  const amounts = items.map((item) => multiplyFen(item.unitPrice, item.qty));
  const distributed = distributeDiscount(amounts, discount);

  return items.map((item, i) => ({
    productId: item.productId,
    productName: item.productName,
    price: distributed[i],
    qty: item.qty,
  }));
}

// ── 序列化配送地址 ──

function serializeAddress(addr: CreateOrderInput["shippingAddress"]): string {
  // 现阶段 JSON 序列化，后续接入 AES-256-GCM 加密
  return JSON.stringify(addr);
}

// ── 创建订单（核心事务 + 乐观锁） ──

/**
 * 创建订单
 *
 * 流程（在单个 Prisma $transaction 中）：
 * 1. 逐商品校验库存 + 乐观锁扣减 (updateMany where version)
 * 2. 实时校验最新价格并快照到 OrderItem
 * 3. 创建 Order + OrderItem 记录
 * 4. 清空当前用户购物车
 *
 * 支付单创建在事务外进行（调用 payment 模块）
 */
export async function createOrder(
  userId: string,
  input: CreateOrderInput,
): Promise<CreateOrderResult> {
  if (input.items.length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "订单至少包含一个商品");
  }

  const result = await prisma.$transaction(async (tx) => {
    const orderItems: {
      productId: string;
      productName: string;
      price: number;
      qty: number;
    }[] = [];

    // Step 1: 逐商品校验 + 乐观锁扣减
    for (const item of input.items) {
      const product = await tx.product.findUnique({
        where: { id: item.productId },
        select: { id: true, name: true, price: true, stock: true, version: true, status: true },
      });

      if (!product || product.status !== "APPROVED") {
        throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, `商品「${item.productId}」不存在或已下架`);
      }

      // 乐观锁扣减库存
      const updated = await tx.product.updateMany({
        where: {
          id: item.productId,
          stock: { gte: item.qty },
          version: product.version,
        },
        data: {
          stock: { decrement: item.qty },
          version: { increment: 1 },
          sales: { increment: item.qty },
        },
      });

      if (updated.count === 0) {
        throw new AppError(
          ERROR_CODES.STOCK_CONFLICT,
          `商品「${product.name}」库存不足或并发冲突，请重试`,
        );
      }

      orderItems.push({
        productId: product.id,
        productName: product.name,
        price: product.price, // 暂存单价，calculateOrderItems 处理分摊
        qty: item.qty,
      });
    }

    // Step 2: 优惠分摊（MVP discount = 0）
    const discount = 0;
    const calculatedItems = calculateOrderItems(
      orderItems.map((oi) => ({
        productId: oi.productId,
        productName: oi.productName,
        unitPrice: oi.price,
        qty: oi.qty,
      })),
      discount,
    );

    const total = sumFen(calculatedItems.map((ci) => ci.price));

    // Step 3: 创建订单
    const order = await tx.order.create({
      data: {
        userId,
        total,
        status: ORDER_STATUS.PENDING,
        shippingAddress: serializeAddress(input.shippingAddress),
        privacy: input.privacy as unknown as object,
        items: {
          create: calculatedItems.map((ci) => ({
            productName: ci.productName,
            price: ci.price,
            qty: ci.qty,
            productId: ci.productId,
          })),
        },
      },
      include: { items: true },
    });

    // Step 4: 清空购物车
    await tx.cartItem.deleteMany({ where: { userId } });

    return order;
  });

  // Step 5: 调用支付模块创建支付单（事务外 — 支付失败不回滚订单）
  // 支付模块尚未实现，暂返回空 payUrl
  const payUrl: string | null = null;
  try {
    // TODO: 支付模块接入后替换为实际调用
    // import { paymentService } from "@/features/payment";
    // payUrl = await paymentService.createPayment({ orderId: result.id, total: result.total });
  } catch {
    // 支付单创建失败不阻塞下单
    console.error("[orders] 支付单创建失败:", result.id);
  }

  return {
    orderId: result.id,
    total: result.total,
    currency: "CNY",
    status: ORDER_STATUS.PENDING,
    payUrl,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 分钟支付过期
  };
}

// ── 取消订单 ──

export async function cancelOrder(
  userId: string,
  orderId: string,
): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, userId: true, status: true, items: { select: { productId: true, qty: true } } },
  });

  if (!order) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
  if (order.userId !== userId) throw new AppError(ERROR_CODES.ORDER_NOT_OWNED, "无权操作该订单");

  const currentStatus = order.status as OrderStatus;
  if (!isCancellable(currentStatus)) {
    throw new AppError(ERROR_CODES.ORDER_STATUS_INVALID, `订单状态「${currentStatus}」不允许取消`);
  }

  await prisma.$transaction(async (tx) => {
    // 恢复库存
    for (const item of order.items) {
      if (!item.productId) continue;
      await tx.product.updateMany({
        where: { id: item.productId },
        data: {
          stock: { increment: item.qty },
          sales: { decrement: item.qty },
        },
      });
    }

    await tx.order.update({
      where: { id: orderId },
      data: { status: ORDER_STATUS.CANCELLED, cancelledAt: new Date() },
    });
  });
}

// ── 申请退款 ──

export async function requestRefund(
  userId: string,
  orderId: string,
): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, userId: true, status: true },
  });

  if (!order) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
  if (order.userId !== userId) throw new AppError(ERROR_CODES.ORDER_NOT_OWNED, "无权操作该订单");

  const currentStatus = order.status as OrderStatus;
  if (!isRefundable(currentStatus)) {
    throw new AppError(ERROR_CODES.ORDER_STATUS_INVALID, `订单状态「${currentStatus}」不允许申请退款`);
  }

  await prisma.order.update({
    where: { id: orderId },
    data: { status: ORDER_STATUS.REFUND_REQUESTED },
  });
}

// ── 支付回调（幂等） ──

/**
 * 支付宝异步回调 — 幂等处理
 *
 * 仅 PENDING 状态的订单可更新为 PAID
 * 使用 updateMany 保证并发安全 + 幂等
 */
export async function markOrderPaid(
  orderId: string,
  outTradeNo: string,
): Promise<{ success: boolean; conflict: boolean }> {
  const result = await prisma.order.updateMany({
    where: {
      id: orderId,
      status: ORDER_STATUS.PENDING,
    },
    data: {
      status: ORDER_STATUS.PAID,
      outTradeNo,
      paidAt: new Date(),
    },
  });

  if (result.count > 0) {
    return { success: true, conflict: false };
  }

  // 未更新 — 检查是否已支付（幂等正常）还是状态冲突
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true },
  });

  if (!order) {
    throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
  }

  if (order.status === ORDER_STATUS.PAID) {
    // 已支付，幂等返回成功
    return { success: true, conflict: false };
  }

  // CANCELLED / REFUNDED 等异常状态 — 支付成功但订单不可支付
  console.error(`[orders] 支付回调异常: ${orderId} 状态=${order.status} 无法标记为 PAID`);
  return { success: false, conflict: true };
}

// ── 查询支付状态 ──

export async function checkPaymentStatus(
  userId: string,
  orderId: string,
): Promise<{ status: string }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { userId: true, status: true },
  });

  if (!order) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
  if (order.userId !== userId) throw new AppError(ERROR_CODES.ORDER_NOT_OWNED, "无权操作该订单");

  return { status: order.status };
}

// ── 销毁订单（用户隐私擦除） ──

/**
 * 一键销毁 — 从用户视角擦除订单
 *
 * 实现方式：
 * - 用户端：shippingAddress 和 privacy 字段覆盖为 [DESTROYED]
 * - 后台保留：Order 记录不物理删除，OrderItem 保留供审计/退款核验
 * - 仅 COMPLETED / CANCELLED / REFUNDED 可销毁
 */
export async function destroyOrder(
  userId: string,
  orderId: string,
): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, userId: true, status: true },
  });

  if (!order) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
  if (order.userId !== userId) throw new AppError(ERROR_CODES.ORDER_NOT_OWNED, "无权操作该订单");

  const currentStatus = order.status as OrderStatus;
  if (!isDestroyable(currentStatus)) {
    throw new AppError(
      ERROR_CODES.ORDER_STATUS_INVALID,
      `订单状态「${currentStatus}」不允许销毁，请先完成或取消订单`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: {
        shippingAddress: "[DESTROYED]",
        privacy: { destroyed: true, destroyedAt: new Date().toISOString() } as unknown as object,
      },
    });

    // 审计日志（异步 Inngest，此处同步写入）
    await tx.auditLog.create({
      data: {
        targetType: "Order",
        targetId: orderId,
        action: "DESTROYED",
        operatorId: userId,
      },
    });
  });
}
