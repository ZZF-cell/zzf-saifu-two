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
    // 先取品牌以获 ownerId（审核通过需升级其角色为 BRAND）；不存在 → 404
    const brand = await tx.brand.findUnique({
      where: { id: brandId },
      select: { ownerId: true },
    });
    if (!brand) {
      throw new AppError(ERROR_CODES.BRAND_NOT_FOUND, "品牌不存在");
    }

    // 仅 PENDING 品牌可审核（状态守卫，防重复审核）
    const updated = await tx.brand.updateMany({
      where: { id: brandId, status: "PENDING" },
      data: { status: decision },
    });
    if (updated.count === 0) {
      throw new AppError(ERROR_CODES.BRAND_ALREADY_REVIEWED, "品牌已被审核");
    }

    // 审核通过 → 负责人升级 BRAND 角色（同事务：品牌已过但角色未升是笔错账）
    if (decision === "APPROVED") {
      await tx.user.update({
        where: { id: brand.ownerId },
        data: { role: "BRAND" },
      });
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

// ── 邀请码管理 ──

// 邀请码字符集：剔除易混淆的 0/O/1/I，余 32 字符（2^5）
const INVITE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** 生成 INV-XXXX-XXXX 格式邀请码（组内字符可重复） */
function generateInviteCodeValue(): string {
  const group = () => {
    let s = "";
    for (let i = 0; i < 4; i++) {
      s += INVITE_CODE_ALPHABET[Math.floor(Math.random() * INVITE_CODE_ALPHABET.length)];
    }
    return s;
  };
  return `INV-${group()}-${group()}`;
}

export interface GenerateInviteInput {
  count: number;
  expiresAt?: Date | null;
}

/**
 * 批量生成邀请码 — 同事务内逐码落库 + 逐码审计
 * 唯一性：INV 码空间 32^4×32^4 ≈ 2^40，碰撞概率可忽略；内存 Set 兜底本次批内去重
 * （InviteCode.code @unique 是最终兜底，极端碰撞时整事务回滚报错）
 */
export async function generateInviteCodes(
  input: GenerateInviteInput,
  operatorId: string,
): Promise<string[]> {
  const { count, expiresAt = null } = input;
  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < count) {
    const code = generateInviteCodeValue();
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }

  await prisma.$transaction(async (tx) => {
    for (const code of codes) {
      await tx.inviteCode.create({
        data: { code, createdBy: operatorId, expiresAt },
      });
    }
    for (const code of codes) {
      await writeAuditLog(tx, "InviteCode", code, "INVITE_GENERATED", operatorId);
    }
  });

  return codes;
}
