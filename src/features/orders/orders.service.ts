// 订单领域服务 — Prisma $transaction 业务流程
// 核心：乐观锁防超卖 + calculateOrderItems 优惠分摊 + 支付回调幂等

import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { multiplyFen, sumFen, distributeDiscount } from "@/shared/utils/money";
import {
  ORDER_STATUS,
  isCancellable,
  isRefundable,
  isConfirmable,
  isDestroyable,
} from "./orders.state-machine";
import type { OrderStatus } from "./orders.state-machine";
import { encrypt } from "@/shared/utils/crypto";
import { writeAuditLog } from "@/shared/utils/audit";
import { paymentService } from "@/features/payment";
import { captureMessage } from "@sentry/nextjs";
import type { Prisma } from "@prisma/client";
import type { CreateOrderInput, CreateOrderResult } from "./orders.types";
import { ORDER_PAYMENT_TIMEOUT_MS } from "./orders.constants";

// 常量源迁至 orders.constants（零依赖，orders.queries 也要算 expiresAt），
// re-export 保持 index.ts / inngest / payment 现有引用链不变
export { ORDER_PAYMENT_TIMEOUT_MS } from "./orders.constants";

/**
 * 送达后自动确认收货窗口（7 天）— 用户侧 confirmReceipt 与 Inngest
 * order-delivery-complete-sweep cron 共用：deliveredAt 起 7 天无手动确认，
 * 系统自动标记 COMPLETED（订单进入可销毁终态）
 */
export const AUTO_CONFIRM_RECEIPT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 单个 SKU 最大购买数量（M3）：防 qty 任意大造成
 * - stock/sales Int4 溢出（sales + qty > 2^31-1 → DB 报错 500）
 * - multiplyFen 计算异常放大
 * 下单 API zod 与 service 双层校验（service 是公共 seam，须自带防御）。
 */
export const MAX_ORDER_ITEM_QTY = 999;

/** 单笔订单最大行数（M3）：防超大数组拖垮事务/循环 */
export const MAX_ORDER_ITEMS = 100;

// ── 类型 ──

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
  if (input.items.length > MAX_ORDER_ITEMS) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      `单笔订单最多 ${MAX_ORDER_ITEMS} 种商品`,
    );
  }

  // M2 去重：同一 productId 多行（[{A,2},{A,3}]）合并为单行 qty=5。
  // 否则每个重复行都独立校验库存并扣减，可能「逐行均足、合计超卖」，
  // 且生成两条同商品 OrderItem 使对账混乱。合并后 qty 才是该 SKU 的真实需求。
  const mergedMap = new Map<string, number>();
  for (const item of input.items) {
    mergedMap.set(item.productId, (mergedMap.get(item.productId) ?? 0) + item.qty);
  }
  // M3 防御：qty 上限（zod 在 API 层已拦，service 是公共 seam 须自带校验）+ Int32 预检。
  // Int4 列（stock/sales）最大 2^31-1，qty 合并后需 ≤ MAX_ORDER_ITEM_QTY，
  // 否则 sales: increment 可能溢出报错（500 而非业务错误）。
  for (const [productId, qty] of mergedMap) {
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_ORDER_ITEM_QTY) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `商品「${productId}」购买数量需在 1~${MAX_ORDER_ITEM_QTY} 之间`,
      );
    }
  }
  const items = [...mergedMap].map(([productId, qty]) => ({ productId, qty }));

  const result = await prisma.$transaction(async (tx) => {
    const orderItems: {
      productId: string;
      productName: string;
      price: number;
      qty: number;
    }[] = [];

    // Step 0: 下单商品必须是当前用户购物车中的商品（防前端「无 ?items= 回退全量」误删
    // 整张购物车、以及恶意提交任意商品组合；当前唯一结算入口是购物车勾选）
    const cartRows = await tx.cartItem.findMany({
      where: { userId },
      select: { productId: true, qty: true },
    });
    const cartQtyMap = new Map(cartRows.map((c) => [c.productId, c.qty]));
    const notInCart = items.find((i) => !cartQtyMap.has(i.productId));
    if (notInCart) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `商品「${notInCart.productId}」不在购物车中，请先加购后再结算`,
      );
    }
    // 下单数量不得超过购物车数量（购物车为唯一结算入口）——防恶意改参超量下单
    const overQty = items.find((i) => (cartQtyMap.get(i.productId) ?? 0) < i.qty);
    if (overQty) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `商品「${overQty.productId}」下单数量超过购物车数量，请先调整购物车`,
      );
    }

    // Step 1: 逐商品校验 + 乐观锁扣减
    for (const item of items) {
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

    // F5 privacy 白名单化：只落 anonymousPackaging / hideProductName 两个业务字段，
    // 丢弃前端可能注入的任意额外字段（如伪造 destroyed 标记干扰管理后台审计显示）。
    const sanitizedPrivacy = {
      anonymousPackaging: Boolean(input.privacy.anonymousPackaging),
      hideProductName: Boolean(input.privacy.hideProductName),
    };

    // Step 3: 创建订单
    const order = await tx.order.create({
      data: {
        userId,
        total,
        status: ORDER_STATUS.PENDING,
        shippingAddress: serializeAddress(input.shippingAddress),
        privacy: sanitizedPrivacy as unknown as object,
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

    // Step 4: 购物车差额扣减 —— 部分结算（购物车 A×5 只买 A×2）时按购买数量扣减，
    // 剩余数量保留在购物车；购买数量 ≥ 购物车数量才整行删除。
    // 修复前 deleteMany 整行删除：前端「购物车勾选部分 → 结算 → 回到购物车」时
    // 未被购买的剩余数量一并消失，体验断层且易被误解为丢单。
    for (const ci of calculatedItems) {
      const cart = await tx.cartItem.findUnique({
        where: { userId_productId: { userId, productId: ci.productId } },
        select: { id: true, qty: true },
      });
      // Step 0 已保证购物车存在，此处防御并发移除（另一终端删除该商品）
      if (!cart) continue;
      if (cart.qty <= ci.qty) {
        await tx.cartItem.delete({ where: { id: cart.id } });
      } else {
        await tx.cartItem.update({
          where: { id: cart.id },
          data: { qty: cart.qty - ci.qty },
        });
      }
    }

    return order;
  });

  // Step 5: 调用支付模块创建支付单（事务外 — 支付失败不回滚订单）
  // 未配置支付宝环境变量时 createPayment 抛 PAYMENT_FAILED → 捕获后降级为 null qrCode（不阻塞下单）
  // E1: paymentState 区分「未配置(dev 降级)」与「已配置但失败(真实异常)」，
  //     前端据此决定提示文案与是否给「去详情重试支付」入口，绝不静默。
  let qrCode: string | null = null;
  let paymentState: CreateOrderResult["paymentState"] = "unavailable";
  if (paymentService.isPaymentConfigured()) {
    try {
      const payment = await paymentService.createPayment(userId, result.id);
      qrCode = payment.qrCode;
      paymentState = qrCode ? "ok" : "failed";
    } catch (error) {
      console.error("[orders] 支付单创建失败:", result.id, error);
      paymentState = "failed";
    }
  }

  return {
    orderId: result.id,
    total: result.total,
    currency: "CNY",
    status: ORDER_STATUS.PENDING,
    qrCode,
    paymentState,
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
    // 库存必须回补（少了会实际损失可售库存）；销量回减带守卫——
    // 正常流程下单时 sales 已 increment qty，此处必然 ≥ qty；异常脏数据
    // （如历史订单 sales 记录缺失）不允许把销量减成负数（展示口径污染）。
    // 两个 update 在同一事务内，整体原子提交。
    await tx.product.updateMany({
      where: { id: item.productId },
      data: { stock: { increment: item.qty } },
    });
    await tx.product.updateMany({
      where: { id: item.productId, sales: { gte: item.qty } },
      data: { sales: { decrement: item.qty } },
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
    select: {
      id: true,
      userId: true,
      status: true,
      total: true,
      items: { select: { productId: true, qty: true } },
    },
  });

  if (!order) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
  // F2 归属失败统一 404（防订单号枚举，与 checkPaymentStatus/orders.queries 语义一致）
  if (order.userId !== userId) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");

  const currentStatus = order.status as OrderStatus;
  if (!isCancellable(currentStatus)) {
    throw new AppError(
      ERROR_CODES.ORDER_STATUS_INVALID,
      currentStatus === ORDER_STATUS.PAID
        ? "已支付订单不能直接取消，请使用「申请退款」"
        : `订单状态「${currentStatus}」不允许取消（仅未支付的 PENDING 订单可取消）`,
    );
  }

  // 取消前先向支付宝确认交易未完成（与 cancelExpiredOrder 同源防护）：
  // 用户可能已真实付款但异步通知丢失（notifyUrl 未到/沙箱环境），此时订单仍是
  // PENDING，直接取消 = 「钱已扣、订单已取消」资损。先 query 终态：
  // - 未配置支付宝（开发环境）→ 无支付可能，直接进入取消
  // - 已配置且查询明确未支付 → 进入取消
  // - 已支付（金额与快照一致）→ 幂等标记 PAID，拒绝取消（提示走退款）
  // - 已支付但金额不符 → 支付状态未知，不取消（保持 PENDING 人工介入）
  // - 查询失败（网关瞬时故障/网络异常）→ 放行取消：用户主动点「取消订单」= 放弃支付的
  //   明确意图，不再阻塞（曾按是否超时区分——未超时保守保持 PENDING → 用户点取消永远报
  //   「支付状态确认中，请稍后重试」取消不了，体验死局；用户报障要求点击即已取消）。
  //   资损防护仍保留：只有查询成功确认已支付才拒绝取消，查询失败时无「已付款」证据。
  if (paymentService.isPaymentConfigured()) {
    const query = await paymentService.queryAlipayTrade(orderId);
    if (!query.success || query.code !== "10000") {
      console.error(
        `[orders] 手动取消前支付宝查询失败(放行取消) 订单=${orderId} success=${query.success} code=${query.code}`,
      );
    } else {
      const terminalSuccess =
        query.tradeStatus === "TRADE_SUCCESS" || query.tradeStatus === "TRADE_FINISHED";
      if (terminalSuccess) {
        const paidFen = query.totalAmountFen;
        if (paidFen !== null && paidFen === order.total) {
          const result = await markOrderPaid(
            orderId,
            query.outTradeNo ?? orderId,
            paidFen,
            query.alipayTradeNo,
          );
          if (result.success) {
            throw new AppError(
              ERROR_CODES.ORDER_STATUS_INVALID,
              "订单已支付，无法取消，请使用「申请退款」",
            );
          }
        }
        // 金额不符 / 标记冲突：不取消，保持 PENDING（人工介入）
        throw new AppError(
          ERROR_CODES.ORDER_STATUS_INVALID,
          "订单支付状态异常，暂无法取消，请联系客服",
        );
      }
      // code=10000 且非终态（TRADE_NOT_EXIST/WAIT_BUYER_PAY/TRADE_CLOSED）→ 确认未支付，进入取消
    }
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
  // 先只读订单状态（不占事务）：已非 PENDING 直接 no-op，不发起无谓的支付查询
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      status: true,
      total: true,
      items: { select: { productId: true, qty: true } },
    },
  });
  if (!order || order.status !== ORDER_STATUS.PENDING) {
    return { cancelled: false, status: order?.status ?? "NOT_FOUND" };
  }

  // M1 超时先查支付：取消前必须向支付宝确认交易未完成。
  // 用户可能已真实付款但异步通知丢失（notifyUrl 未到/沙箱环境），直接取消
  // = 「钱已扣、订单已取消」资损。先 query 终态：
  // - 未配置支付宝（开发环境）→ 无支付可能，直接进入取消（无资损风险）
  // - 已配置 → 仅当网关 code=10000 且交易明确未支付时才取消：
  //   * 已支付(TRADE_SUCCESS/FINISHED) 且金额与快照一致 → 幂等标记 PAID，绝不取消
  //   * 已支付但金额不符 → 资损风险，保持 PENDING 交人工介入，不取消
  //   * 查询失败（success=false 或网关非 10000，含网络抖动/限流）→ 支付状态未知，
  //     绝不静默取消——用户可能已付款但通知丢失，取消即资损；保持 PENDING 留待下次 sweep 重查
  // D2 修复：此前「未配置」与「网关瞬时失败」被同等对待都进入取消，成批取消已支付订单。
  if (paymentService.isPaymentConfigured()) {
    const query = await paymentService.queryAlipayTrade(orderId);
    if (!query.success || query.code !== "10000") {
      // 查询失败放行取消：本函数仅在订单已超时时被调用（Inngest 定时 + 支付/查询支付
      // 入口的超时兜底），而 createPayment 把支付宝 timeoutExpress 钳制到 ≤ 订单剩余时间，
      // 超时后支付宝侧允许支付窗口已关闭、收款不可能再发生——查询失败不阻塞取消，
      // 否则超时订单永远卡 PENDING 死锁（用户取消不了、系统也取消不了）。
      // 「已付款但通知丢失」仅可能发生在超时前的窄窗口；且能查到 TRADE_SUCCESS 时会
      // 走下方「标记 PAID 不取消」分支防护，查询失败按已超时放行，优先解除死锁。
      console.error(
        `[orders] 超时取消前支付宝查询失败(订单已超时，放行取消): 订单=${orderId} ${query.error ?? `code=${query.code ?? "?"}`}`,
      );
    } else {
      const terminalSuccess =
        query.tradeStatus === "TRADE_SUCCESS" || query.tradeStatus === "TRADE_FINISHED";
      if (terminalSuccess) {
        const paidFen = query.totalAmountFen;
        if (paidFen !== null && paidFen === order.total) {
          const result = await markOrderPaid(
            orderId,
            query.outTradeNo ?? orderId,
            paidFen,
            query.alipayTradeNo,
          );
          if (result.success) return { cancelled: false, status: ORDER_STATUS.PAID };
        }
        // 金额不符 / 标记冲突：不取消，保持 PENDING（人工介入）
        return { cancelled: false, status: order.status };
      }
      // code=10000 且非终态（TRADE_NOT_EXIST/WAIT_BUYER_PAY/TRADE_CLOSED）→ 确认未支付，进入取消
    }
  }

  // 未支付 / 未配置 → 事务内取消（状态守卫必须先于库存回补：
  // updateMany 带 status=PENDING，与支付回调并发时若回调抢先置 PAID，
  // 命中 0 行 → 提前 return（事务无写入提交），绝不回补已支付订单的库存（防资损））
  return prisma.$transaction(async (tx) => {
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
  // F2 归属失败统一 404（防订单号枚举）
  if (order.userId !== userId) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");

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

// ── 确认收货（用户） ──

/**
 * 用户确认收货 — DELIVERED → COMPLETED（进入可销毁终态）
 *
 * 三入口之一（用户确认收货 / 管理后台 completeOrder / 送达 7 天自动确认）：
 * 全部用 updateMany 带 status=DELIVERED 状态守卫，并发时只命中一次，
 * 绝不把非已送达订单覆写为 COMPLETED（防与其他流转并发冲突）。
 *
 * 归属校验：订单不存在→ORDER_NOT_FOUND；非本人→ORDER_NOT_OWNED；
 * 非 DELIVERED→ORDER_STATUS_INVALID（提示先等待送达）。
 */
export async function confirmReceipt(userId: string, orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, userId: true, status: true },
  });

  if (!order) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
  // F2 归属失败统一 404（防订单号枚举）
  if (order.userId !== userId) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");

  const currentStatus = order.status as OrderStatus;
  if (!isConfirmable(currentStatus)) {
    throw new AppError(
      ERROR_CODES.ORDER_STATUS_INVALID,
      `订单状态「${currentStatus}」不可确认收货（仅已送达 DELIVERED 可确认）`,
    );
  }

  await prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: ORDER_STATUS.DELIVERED },
      data: {
        status: ORDER_STATUS.COMPLETED,
        completedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      throw new AppError(ERROR_CODES.ORDER_STATUS_INVALID, "订单状态已变更，无法确认收货");
    }

    await writeAuditLog(tx, "Order", orderId, "CONFIRMED_RECEIPT", userId, {
      before: ORDER_STATUS.DELIVERED,
      after: ORDER_STATUS.COMPLETED,
    });
  });
}

// ── 自动确认收货（送达 7 天，Inngest cron 调用） ──

/**
 * 自动确认收货 — 送达 7 天（AUTO_CONFIRM_RECEIPT_MS）无手动确认，系统自动 DELIVERED → COMPLETED
 *
 * 与用户确认收货 confirmReceipt / 管理后台 completeOrder 的区别：
 * - 无用户归属校验（系统发起）
 * - 订单非 DELIVERED 时静默返回 no-op，不抛错、不触发重试
 *
 * 状态守卫：updateMany 带 status=DELIVERED — 与用户确认/后台标记并发时若状态已变，
 * 命中 0 行 → 返回未完成，绝不把已变更订单覆写成 COMPLETED。
 */
export async function autoCompleteDeliveredOrder(
  orderId: string,
): Promise<{ completed: boolean; status: string }> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });

    if (!order || order.status !== ORDER_STATUS.DELIVERED) {
      return { completed: false, status: order?.status ?? "NOT_FOUND" };
    }

    const updated = await tx.order.updateMany({
      where: { id: orderId, status: ORDER_STATUS.DELIVERED },
      data: {
        status: ORDER_STATUS.COMPLETED,
        completedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      return { completed: false, status: "ALREADY_CHANGED" };
    }

    // 系统动作审计（operatorId=null，与支付回调 markOrderPaid 的 PAID 审计一致）
    await writeAuditLog(tx, "Order", orderId, "AUTO_COMPLETED", null, {
      before: ORDER_STATUS.DELIVERED,
      after: ORDER_STATUS.COMPLETED,
    });

    return { completed: true, status: ORDER_STATUS.COMPLETED };
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
      // 已支付，幂等返回成功。D3 修复：幂等重放分支补金额复验 + 告警（纵深防御）——
      // 事务开头的金额校验（order.total !== paidAmountFen）已覆盖所有路径，此处再显式
      // 复验并留痕，绝不静默吞掉不一致的重复通知（如未来出现部分退款/金额修正通知）。
      if (order.total !== paidAmountFen) {
        console.error(
          `[orders] 幂等回调金额异常: 订单=${orderId} 快照=${order.total} 回调=${paidAmountFen}`,
        );
        alertPaymentConflict("幂等回调金额不一致", { orderId, paidAmountFen });
      }
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
    select: { userId: true, status: true, total: true, createdAt: true, destroyedAt: true },
  });

  if (!order) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
  // F3：已销毁订单对用户侧视为不存在（用户列表已消失、详情 404），查询支付一并过滤，
  // 否则销毁后仍可通过 check-paid 探测到订单存在痕迹。
  if (order.destroyedAt) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
  // F2 归属失败统一 404：非本人订单对当前用户「不可见」——403 会泄露订单存在性，
  // 攻击者可逐 id 探测（与 orders.queries 的 404 语义一致，防订单号枚举）。
  if (order.userId !== userId) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");

  // 超时兜底：Inngest 事件丢失/未配置时，这里在用户每次查看支付状态时惰性取消过期订单
  // （过期时间 = 下单 createdAt + ORDER_PAYMENT_TIMEOUT_MS，不落库列；cancelExpiredOrder
  //   自带状态守卫，非 PENDING 静默 no-op，幂等安全）
  const expiresAt = new Date(order.createdAt.getTime() + ORDER_PAYMENT_TIMEOUT_MS);
  if (order.status === ORDER_STATUS.PENDING && expiresAt.getTime() <= Date.now()) {
    const result = await cancelExpiredOrder(orderId);
    // 只回传合法业务状态，不透出内部枚举（NOT_FOUND/ALREADY_CHANGED）
    if (result.cancelled) return { status: ORDER_STATUS.CANCELLED };
    if (result.status === ORDER_STATUS.PAID) return { status: ORDER_STATUS.PAID };
    return { status: ORDER_STATUS.PENDING };
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
    select: {
      id: true,
      userId: true,
      status: true,
      total: true,
      privacy: true,
      items: {
        select: { id: true, productId: true, productName: true, qty: true, price: true },
      },
    },
  });

  if (!order) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
  // F2 归属失败统一 404（防订单号枚举）
  if (order.userId !== userId) throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");

  const currentStatus = order.status as OrderStatus;
  if (!isDestroyable(currentStatus)) {
    throw new AppError(
      ERROR_CODES.ORDER_STATUS_INVALID,
      `订单状态「${currentStatus}」不允许销毁，请先完成或取消订单`,
    );
  }

  await prisma.$transaction(async (tx) => {
    // F1 幂等守卫：updateMany where destroyedAt:null —— 并发重复销毁（双击/重试）时
    // 已销毁订单命中 0 行 → 静默 no-op（幂等，不重复写审计、不覆盖已擦除状态）。
    // E3 保留原隐私选项：合并而非整体覆盖 —— 后台仍能读到
    // anonymousPackaging/hideProductName 等原值（丢失会让后台无法识别
    // 「曾匿名包装」的订单），只追加 destroyed 标记。
    const originalPrivacy = (order.privacy as Record<string, unknown> | null) ?? {};
    const result = await tx.order.updateMany({
      where: { id: orderId, destroyedAt: null },
      data: {
        shippingAddress: "[DESTROYED]",
        privacy: {
          ...originalPrivacy,
          destroyed: true,
          destroyedAt: new Date().toISOString(),
        } as unknown as object,
        // destroyedAt 列是用户/品牌侧查询过滤的唯一依据（destroyedAt IS NULL 才可见），
        // privacy.destroyed 保留供管理后台显示「已销毁」标记
        destroyedAt: new Date(),
      },
    });
    if (result.count === 0) return;

    // 审计快照（E3）：记录销毁前订单元数据（状态/金额/商品行），不含配送地址
    // （隐私承诺：地址随销毁一并擦除，审计不得回存 PII）。后台可据此核验
    // 「谁在何时销毁了哪笔订单、销毁了什么」，且订单行本身仍保留供退款核验。
    await tx.auditLog.create({
      data: {
        targetType: "Order",
        targetId: orderId,
        action: "DESTROYED",
        operatorId: userId,
        snapshot: {
          status: order.status,
          total: order.total,
          itemCount: order.items.length,
          items: order.items.map((i) => ({
            id: i.id,
            productId: i.productId,
            productName: i.productName,
            qty: i.qty,
            price: i.price,
          })),
        },
      },
    });
  });
}
