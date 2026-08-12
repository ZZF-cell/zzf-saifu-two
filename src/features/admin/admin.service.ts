// 管理后台写入操作（CQS：本文件只写）
// 所有状态变更使用 updateMany + 状态守卫，防并发竞态（与订单模块同一策略）
// 状态变更与审计日志在同一 $transaction 内：审计失败则整体回滚，绝不出现「状态已变但无审计留痕」
import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { ORDER_STATUS } from "@/features/orders";
import type { Prisma } from "@prisma/client";

export type ReviewDecision = "APPROVED" | "REJECTED";

// ── 审计日志（后台所有操作留痕） ──

async function writeAuditLog(
  tx: Prisma.TransactionClient,
  targetType: string,
  targetId: string,
  action: string,
  operatorId: string,
): Promise<void> {
  await tx.auditLog.create({
    data: { targetType, targetId, action, operatorId },
  });
}

// ── 品牌审核 ──

export async function reviewBrand(
  brandId: string,
  decision: ReviewDecision,
  operatorId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // 仅 PENDING 品牌可审核（状态守卫，防重复审核）
    const updated = await tx.brand.updateMany({
      where: { id: brandId, status: "PENDING" },
      data: { status: decision },
    });
    if (updated.count === 0) {
      // 区分「不存在」(404) 与「已审核」(409) —— 实体存在却返回 404 会误导调用方
      const exists = await tx.brand.findUnique({
        where: { id: brandId },
        select: { id: true },
      });
      throw new AppError(
        exists ? ERROR_CODES.BRAND_ALREADY_REVIEWED : ERROR_CODES.BRAND_NOT_FOUND,
        exists ? "品牌已被审核" : "品牌不存在",
      );
    }
    await writeAuditLog(tx, "Brand", brandId, `REVIEW_${decision}`, operatorId);
  });
}

// ── 商品质检 ──

export async function reviewProduct(
  productId: string,
  decision: ReviewDecision,
  operatorId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // 仅 PENDING 商品可质检（状态守卫）
    const updated = await tx.product.updateMany({
      where: { id: productId, status: "PENDING" },
      data: { status: decision },
    });
    if (updated.count === 0) {
      const exists = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true },
      });
      throw new AppError(
        exists ? ERROR_CODES.PRODUCT_ALREADY_REVIEWED : ERROR_CODES.PRODUCT_NOT_FOUND,
        exists ? "商品已被质检" : "商品不存在",
      );
    }
    await writeAuditLog(tx, "Product", productId, `REVIEW_${decision}`, operatorId);
  });
}

// ── 订单管理：发货 ──

export async function shipOrder(orderId: string, operatorId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // PAID → SHIPPED（状态守卫，防与退款申请并发冲突）
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: ORDER_STATUS.PAID },
      data: { status: ORDER_STATUS.SHIPPED, shippedAt: new Date() },
    });
    if (updated.count === 0) {
      throw new AppError(ERROR_CODES.ORDER_STATUS_INVALID, "仅已支付订单可发货");
    }
    await writeAuditLog(tx, "Order", orderId, "SHIPPED", operatorId);
  });
}

// ── 订单管理：标记送达 ──

export async function deliverOrder(orderId: string, operatorId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // SHIPPED → DELIVERED（状态守卫）
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: ORDER_STATUS.SHIPPED },
      data: { status: ORDER_STATUS.DELIVERED, deliveredAt: new Date() },
    });
    if (updated.count === 0) {
      throw new AppError(ERROR_CODES.ORDER_STATUS_INVALID, "仅已发货订单可标记送达");
    }
    await writeAuditLog(tx, "Order", orderId, "DELIVERED", operatorId);
  });
}

// ── 订单管理：完成 ──

export async function completeOrder(orderId: string, operatorId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // DELIVERED → COMPLETED（状态守卫，终态）
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: ORDER_STATUS.DELIVERED },
      data: { status: ORDER_STATUS.COMPLETED, completedAt: new Date() },
    });
    if (updated.count === 0) {
      throw new AppError(ERROR_CODES.ORDER_STATUS_INVALID, "仅已送达订单可标记完成");
    }
    await writeAuditLog(tx, "Order", orderId, "COMPLETED", operatorId);
  });
}

// ── 订单管理：确认退款 ──

/**
 * 确认退款 — REFUND_REQUESTED → REFUNDED
 *
 * MVP 阶段仅标记订单状态（后台数据留痕）；实际资金原路退回由
 * 支付渠道侧人工/财务操作完成（支付宝退款 API 属三期，见 README 微信/退款规划）。
 */
export async function confirmRefund(orderId: string, operatorId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: ORDER_STATUS.REFUND_REQUESTED },
      data: { status: ORDER_STATUS.REFUNDED, refundedAt: new Date() },
    });
    if (updated.count === 0) {
      throw new AppError(ERROR_CODES.ORDER_STATUS_INVALID, "仅退款申请中的订单可确认退款");
    }
    await writeAuditLog(tx, "Order", orderId, "REFUND_CONFIRMED", operatorId);
  });
}

// ── 质检模板管理 ──

export async function upsertAuditTemplate(
  input: { categoryId: string; requiredDocs?: string[]; checkPoints?: string[] },
  operatorId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const data = {
      requiredDocs: (input.requiredDocs ?? []) as unknown as object,
      checkPoints: (input.checkPoints ?? []) as unknown as object,
    };
    await tx.categoryAuditTemplate.upsert({
      where: { categoryId: input.categoryId },
      update: data,
      create: { categoryId: input.categoryId, ...data },
    });
    await writeAuditLog(tx, "CategoryAuditTemplate", input.categoryId, "UPSERT_TEMPLATE", operatorId);
  });
}
