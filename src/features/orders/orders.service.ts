// 订单领域服务 — Prisma $transaction 业务流程
// 核心：乐观锁防超卖 + calculateOrderItems 优惠分摊 + 支付回调幂等

import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { multiplyFen, sumFen, distributeDiscount } from "@/shared/utils/money";
import {
  ORDER_STATUS,
  isCancellable,
  isRefundable,
  isDestroyable,
} from "./orders.state-machine";
import type { OrderStatus } from "./orders.state-machine";
import { encrypt } from "@/shared/utils/crypto";
import { writeAuditLog } from "@/shared/utils/audit";
import { paymentService } from "@/features/payment";
import { captureMessage } from "@sentry/nextjs";
import type { Prisma } from "@prisma/client";

/** 支付超时时间（30 分钟）— 下单 expiresAt 与 Inngest 超时取消共用，防止展示倒计时与实际取消时机不一致 */
export const ORDER_PAYMENT_TIMEOUT_MS = 30 * 60 * 1000;

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
  /** 当面付二维码内容（支付宝 App 扫码支付）；未配置时 null（订单已创建，可稍后到详情页续付） */
  qrCode: string | null;
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
  // AES-256-GCM 加密配送地址（README 隐私承诺）
  // ENCRYPTION_KEYS 未配置时仅开发环境允许明文（带告警）；
  // 生产环境 fail-fast，绝不静默明文落库
  const json = JSON.stringify(addr);
  if (!process.env.ENCRYPTION_KEYS) {
    if (process.env.NODE_ENV === "production") {
      throw new AppError(
        ERROR_CODES.INTERNAL_ERROR,
        "服务器未配置 ENCRYPTION_KEYS，无法加密配送地址",
      );
    }
    console.warn("[orders] ENCRYPTION_KEYS 未配置，配送地址明文存储（仅限开发环境）");
    return json;
  }
  return encrypt(json);
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

    // Step 4: 清空购物车（仅删除本次下单的商品，保留部分结算时未购买的商品）
    const purchasedProductIds = calculatedItems.map((ci) => ci.productId);
    await tx.cartItem.deleteMany({
      where: { userId, productId: { in: purchasedProductIds } },
    });

    return order;
  });

  // Step 5: 调用支付模块创建支付单（事务外 — 支付失败不回滚订单）
  // 未配置支付宝环境变量时 createPayment 抛 PAYMENT_FAILED → 捕获后降级为 null qrCode（不阻塞下单）
  let qrCode: string | null = null;
  try {
    const payment = await paymentService.createPayment(userId, result.id);
    qrCode = payment.qrCode;
  } catch (error) {
    console.error("[orders] 支付单创建失败:", result.id, error);
  }

  return {
    orderId: result.id,
    total: result.total,
    currency: "CNY",
    status: ORDER_STATUS.PENDING,
    qrCode,
    expiresAt: new Date(Date.now() + ORDER_PAYMENT_TIMEOUT_MS).toISOString(),
  };
}

// ── 恢复库存（取消订单 / 超时取消共用） ──

/** 回补库存 + 回减销量（取消/超时取消/确认退款共用，须在同一事务内调用） */
export async function restoreStock(
  tx: Prisma.TransactionClient,
  items: { productId: string | null; qty: number }[],
): Promise<void> {
  for (const item of items) {
    if (!item.productId) continue;
    await tx.product.updateMany({
      where: { id: item.productId },
      data: {
        stock: { increment: item.qty },
        sales: { decrement: item.qty },
      },
    });
  }
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
    throw new AppError(
      ERROR_CODES.ORDER_STATUS_INVALID,
      currentStatus === ORDER_STATUS.PAID
        ? "已支付订单不能直接取消，请使用「申请退款」"
        : `订单状态「${currentStatus}」不允许取消（仅未支付的 PENDING 订单可取消）`,
    );
  }

  // 仅 PENDING 可取消：回补库存/回减销量 + 置 CANCELLED。
  // 状态守卫（where 带 status=PENDING）：与支付宝支付回调并发时，
  // 若回调已先将订单置为 PAID，updateMany 命中 0 行 → 抛错整体回滚，
  // 库存恢复一并撤销，绝不把已支付订单覆写成 CANCELLED（防资损）。
  // 反向竞态（本事务先提交 CANCELLED，回调后到）→ 回调走 conflict 分支告警需人工退款。
  await prisma.$transaction(async (tx) => {
    await restoreStock(tx, order.items);

    const updated = await tx.order.updateMany({
      where: { id: orderId, status: ORDER_STATUS.PENDING },
      data: {
        status: ORDER_STATUS.CANCELLED,
        cancelledAt: new Date(),
      },
    });

    if (updated.count === 0) {
      throw new AppError(
        ERROR_CODES.ORDER_STATUS_INVALID,
        "订单状态已变更（可能已支付），无法取消",
      );
    }

    // 审计留痕：用户取消与状态变更同事务（与服务侧 CANCEL/REFUND 全链路可追溯）
    await writeAuditLog(tx, "Order", orderId, "USER_CANCELLED", userId, {
      before: ORDER_STATUS.PENDING,
      after: ORDER_STATUS.CANCELLED,
    });
  });
}

// ── 支付超时自动取消（Inngest 定时任务调用） ──

/**
 * 支付超时自动取消 — 由 Inngest `order-timeout-cancel` 函数在等待 ORDER_PAYMENT_TIMEOUT_MS 后调用
 *
 * 与用户主动取消 cancelOrder 的区别：
 * - 无用户归属校验（系统发起）
 * - 订单非 PENDING（已支付/已取消）时静默返回 no-op，不抛错、不触发重试
 *
 * 竞态安全：状态读取与库存回补/状态更新在同一 $transaction 内完成；
 * updateMany 带 status=PENDING 守卫 — 与支付回调并发时，若回调先置 PAID，
 * 本事务命中 0 行 → 返回未取消，绝不回补已支付订单的库存（防资损）。
 */
export async function cancelExpiredOrder(
  orderId: string,
): Promise<{ cancelled: boolean; status: string }> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        status: true,
        items: { select: { productId: true, qty: true } },
      },
    });

    // 订单不存在或已非 PENDING（已支付/已取消）→ no-op
    if (!order || order.status !== ORDER_STATUS.PENDING) {
      return { cancelled: false, status: order?.status ?? "NOT_FOUND" };
    }

    // 状态守卫必须先于库存回补：
    // updateMany 带 status=PENDING，与支付回调并发时若回调抢先置 PAID，
    // 命中 0 行 → 提前 return（事务无写入提交），绝不回补已支付订单的库存（防资损）
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: ORDER_STATUS.PENDING },
      data: { status: ORDER_STATUS.CANCELLED, cancelledAt: new Date() },
    });

    if (updated.count === 0) {
      return { cancelled: false, status: "ALREADY_CHANGED" };
    }

    // 成功取消后才回补库存（同一事务，原子提交）
    await restoreStock(tx, order.items);

    return { cancelled: true, status: ORDER_STATUS.CANCELLED };
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
    throw new AppError(
      ERROR_CODES.ORDER_STATUS_INVALID,
      `仅已支付(PAID)订单可申请退款（当前状态「${currentStatus}」）`,
    );
  }

  // 状态守卫：与发货等并发时若状态已变更则拒绝，避免从非 PAID 状态进入 REFUND_REQUESTED
  // 审计留痕与状态变更同事务（退款是资金敏感路径，全链路留痕）
  await prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: ORDER_STATUS.PAID },
      data: { status: ORDER_STATUS.REFUND_REQUESTED },
    });
    if (updated.count === 0) {
      throw new AppError(ERROR_CODES.ORDER_STATUS_INVALID, "订单状态已变更，无法申请退款");
    }
    await writeAuditLog(tx, "Order", orderId, "REFUND_REQUESTED", userId, {
      before: ORDER_STATUS.PAID,
      after: ORDER_STATUS.REFUND_REQUESTED,
    });
  });
}

// ── 支付回调（幂等） ──

/**
 * 支付宝异步回调 — 幂等处理
 *
 * 支付回调的状态更新必须整体在 $transaction 内完成（README 同步策略：
 * "幂等性需和状态更新在同一事务"），金额核验的读取与状态写入同事务，避免读到过期快照。
 *
 * 仅 PENDING 状态的订单可更新为 PAID（updateMany 保证并发安全 + 幂等）
 * 回调金额（分）必传，必须与订单快照 total 一致，否则拒绝标记（防资损）
 *
 * @param outTradeNo    商户订单号（= 订单 id，回调幂等键）
 * @param alipayTradeNo 支付宝真实交易流水号（trade_no），区别于商户 out_trade_no
 */
export async function markOrderPaid(
  orderId: string,
  outTradeNo: string,
  paidAmountFen: number,
  alipayTradeNo?: string | null,
): Promise<{ success: boolean; conflict: boolean }> {
  return prisma.$transaction(async (tx) => {
    // 金额核验：回调金额必须与下单时快照一致，否则视为异常拒绝标记
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { total: true },
    });
    if (!order) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
    if (order.total !== paidAmountFen) {
      console.error(
        `[orders] 支付回调金额不匹配: 订单=${orderId} 订单金额=${order.total} 回调金额=${paidAmountFen}`,
      );
      alertPaymentConflict("金额不匹配", { orderId, paidAmountFen });
      return { success: false, conflict: true };
    }

    const result = await tx.order.updateMany({
      where: {
        id: orderId,
        status: ORDER_STATUS.PENDING,
      },
      data: {
        status: ORDER_STATUS.PAID,
        outTradeNo,
        alipayTradeNo: alipayTradeNo ?? null,
        paidAt: new Date(),
      },
    });

    if (result.count > 0) {
      // 支付到账审计（operatorId=null：系统回调，非人工操作）；与状态更新同事务，支付全链路可追溯
      await writeAuditLog(tx, "Order", orderId, "PAID", null, {
        before: ORDER_STATUS.PENDING,
        after: ORDER_STATUS.PAID,
        outTradeNo,
        alipayTradeNo: alipayTradeNo ?? null,
        paidAmountFen,
      });
      return { success: true, conflict: false };
    }

    // 未更新 — 检查是否已支付（幂等正常）还是状态冲突
    const current = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });

    if (!current) {
      throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
    }

    if (current.status === ORDER_STATUS.PAID) {
      // 已支付，幂等返回成功
      return { success: true, conflict: false };
    }

    // CANCELLED / REFUNDED 等异常状态 — 支付成功但订单不可支付（需人工退款）
    // README 监控章节将该场景列为告警（CANCELLED_PAYMENT_ARRIVED）
    console.error(
      `[orders] 支付回调异常: 订单=${orderId} 状态=${current.status} 无法标记为 PAID（支付成功但订单已不可支付，需人工退款）`,
    );
    alertPaymentConflict(`支付到达但订单已不可支付（状态=${current.status}）`, { orderId });
    return { success: false, conflict: true };
  });
}

/**
 * 支付冲突告警 — 支付成功但订单无法标记 PAID 的场景（需人工退款）
 * 接入 Sentry（配置 SENTRY_DSN 时上报 CANCELLED_PAYMENT_ARRIVED 错误码）
 */
function alertPaymentConflict(
  reason: string,
  context: { orderId: string; paidAmountFen?: number },
): void {
  if (!process.env.SENTRY_DSN) return;
  try {
    captureMessage(
      `${ERROR_CODES.CANCELLED_PAYMENT_ARRIVED.code}: ${reason} orderId=${context.orderId}${context.paidAmountFen ? ` paidAmountFen=${context.paidAmountFen}` : ""}`,
      { level: "error" },
    );
  } catch {
    // Sentry 未初始化时静默忽略，日志已由 console.error 兜底
  }
}

// ── 查询支付状态 ──

export async function checkPaymentStatus(
  userId: string,
  orderId: string,
): Promise<{ status: string }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { userId: true, status: true, total: true, createdAt: true },
  });

  if (!order) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
  if (order.userId !== userId) throw new AppError(ERROR_CODES.ORDER_NOT_OWNED, "无权操作该订单");

  // 超时兜底：Inngest 事件丢失/未配置时，这里在用户每次查看支付状态时惰性取消过期订单
  // （过期时间 = 下单 createdAt + ORDER_PAYMENT_TIMEOUT_MS，不落库列；cancelExpiredOrder
  //   自带状态守卫，非 PENDING 静默 no-op，幂等安全）
  const expiresAt = new Date(order.createdAt.getTime() + ORDER_PAYMENT_TIMEOUT_MS);
  if (order.status === ORDER_STATUS.PENDING && expiresAt.getTime() <= Date.now()) {
    const result = await cancelExpiredOrder(orderId);
    return { status: result.status };
  }

  // 非 PENDING → 无支付可查，直接返回当前状态
  if (order.status !== ORDER_STATUS.PENDING) {
    return { status: order.status };
  }

  // PENDING → 真正向支付宝核对交易终态（本地沙箱异步通知 notifyUrl=localhost 收不到，
  // 订单状态只能靠主动查询推进；只读本地 DB 会让「查询支付」永远返回待支付）
  const query = await paymentService.queryAlipayTrade(orderId);
  const terminalSuccess =
    query.success &&
    (query.tradeStatus === "TRADE_SUCCESS" || query.tradeStatus === "TRADE_FINISHED");

  if (terminalSuccess) {
    // 金额核验：支付宝返回实付金额（分）必须与订单快照一致，否则拒绝标记（防资损）
    const paidFen = query.totalAmountFen;
    if (paidFen === null || paidFen !== order.total) {
      console.error(
        `[orders] 支付查询金额不匹配: 订单=${orderId} 订单金额=${order.total} 查询金额=${paidFen}`,
      );
      return { status: order.status };
    }
    // 幂等标记 PAID（markOrderPaid 带金额校验 + updateMany 状态守卫，重复查询安全）
    const result = await markOrderPaid(
      orderId,
      query.outTradeNo ?? orderId,
      paidFen,
      query.alipayTradeNo,
    );
    if (result.success) return { status: ORDER_STATUS.PAID };
  }

  // 查询失败 / 未支付（WAIT_BUYER_PAY 等）/ 金额不符 → 保持当前状态，优雅不抛错
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
