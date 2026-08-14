// 管理后台写入操作（CQS：本文件只写）
// 所有状态变更使用 updateMany + 状态守卫，防并发竞态（与订单模块同一策略）
// 状态变更与审计日志在同一 $transaction 内：审计失败则整体回滚，绝不出现「状态已变但无审计留痕」
import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { ORDER_STATUS } from "@/features/orders";
import { yuanToFen } from "@/shared/utils/money";
import { hashPassword } from "@/shared/utils/crypto";
import type { Prisma } from "@prisma/client";

export type ReviewDecision = "APPROVED" | "REJECTED";

// ── 审计日志（后台所有操作留痕） ──
// snapshot 可选：编辑类操作存 {before, after}，便于追溯变更前后

async function writeAuditLog(
  tx: Prisma.TransactionClient,
  targetType: string,
  targetId: string,
  action: string,
  operatorId: string,
  snapshot?: unknown,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      targetType,
      targetId,
      action,
      operatorId,
      ...(snapshot !== undefined ? { snapshot: snapshot as object } : {}),
    },
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
    // 仅 PENDING 商品可质检（状态守卫）；version bump 与后续编辑/下单乐观锁语义一致
    const updated = await tx.product.updateMany({
      where: { id: productId, status: "PENDING" },
      data: { status: decision, version: { increment: 1 } },
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

// ── 商品下架 / 重新上架 / 编辑（与品牌方同一套状态机，操作人是管理员） ──

export interface AdminProductUpdateInput {
  name?: string;
  description?: string | null;
  category?: string;
  subCategory?: string;
  price?: number; // 元
  stock?: number;
  images?: string[];
  specs?: Record<string, string>;
}

/** 基本信息变更判定（只读旧值比较）：
    价格/库存属运营信息，仅改它们不触发重审；整表单提交（前端全量字段）也不会误判 */
function basicInfoChanged(
  old: {
    name: string;
    category: string;
    subCategory: string | null;
    description: string | null;
    images: unknown;
    specs: unknown;
  },
  input: AdminProductUpdateInput,
): boolean {
  if (input.name !== undefined && input.name !== old.name) return true;
  if (input.category !== undefined && input.category !== old.category) return true;
  if (input.subCategory !== undefined && input.subCategory !== old.subCategory) return true;
  // description 传 ""（表单清空）归一化 null：与写侧 `input.description || null` 一致，
  // 旧值为 null 时清空不误判为重审
  if (input.description !== undefined && (input.description || null) !== old.description) return true;
  if (input.images !== undefined && JSON.stringify(input.images) !== JSON.stringify(old.images)) return true;
  if (input.specs !== undefined && JSON.stringify(input.specs) !== JSON.stringify(old.specs)) return true;
  return false;
}

export async function delistProduct(productId: string, operatorId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // 仅 APPROVED 可下架（状态守卫）
    const updated = await tx.product.updateMany({
      where: { id: productId, status: "APPROVED" },
      data: { status: "DELISTED", version: { increment: 1 } },
    });
    if (updated.count === 0) {
      const exists = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true },
      });
      throw new AppError(
        exists ? ERROR_CODES.PRODUCT_STATUS_INVALID : ERROR_CODES.PRODUCT_NOT_FOUND,
        exists ? "仅已上架商品可下架" : "商品不存在",
      );
    }
    await writeAuditLog(tx, "Product", productId, "PRODUCT_DELISTED", operatorId);
  });
}

export async function relistProduct(productId: string, operatorId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // 仅 DELISTED 可重新上架（状态守卫；不重质检，用户已确认）
    const updated = await tx.product.updateMany({
      where: { id: productId, status: "DELISTED" },
      data: { status: "APPROVED", version: { increment: 1 } },
    });
    if (updated.count === 0) {
      const exists = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true },
      });
      throw new AppError(
        exists ? ERROR_CODES.PRODUCT_STATUS_INVALID : ERROR_CODES.PRODUCT_NOT_FOUND,
        exists ? "仅已下架商品可重新上架" : "商品不存在",
      );
    }
    await writeAuditLog(tx, "Product", productId, "PRODUCT_RELISTED", operatorId);
  });
}

export async function updateProduct(
  productId: string,
  input: AdminProductUpdateInput,
  operatorId: string,
): Promise<{ id: string; status: string }> {
  return prisma.$transaction(async (tx) => {
    // 事务内读旧值：与写同一快照，比较结果与守卫一致
    const old = await tx.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        name: true,
        category: true,
        subCategory: true,
        description: true,
        images: true,
        specs: true,
        status: true,
      },
    });
    if (!old) throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, "商品不存在");

    const basicChanged = basicInfoChanged(old, input);

    // 状态机：已上架/已下架改基本信息 → 回待质检（保住品质关）；
    // 拒绝/撤回任意修改 → 重新提交；仅运营信息 → 状态不变
    let nextStatus = old.status;
    let action = "PRODUCT_UPDATE";
    if (basicChanged && (old.status === "APPROVED" || old.status === "DELISTED")) {
      nextStatus = "PENDING";
      action = "PRODUCT_UPDATE_REVIEW";
    } else if (old.status === "REJECTED" || old.status === "WITHDRAWN") {
      nextStatus = "PENDING";
      action = "PRODUCT_UPDATE_RESUBMIT";
    }

    const data: Prisma.ProductUpdateManyMutationInput = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      // description 清空：schema 为 optional 非 nullable，传 "" 归一化 null 防误判重审
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.subCategory !== undefined ? { subCategory: input.subCategory } : {}),
      ...(input.price !== undefined ? { price: yuanToFen(input.price) } : {}),
      ...(input.stock !== undefined ? { stock: input.stock } : {}),
      ...(input.images !== undefined ? { images: input.images as unknown as object } : {}),
      ...(input.specs !== undefined ? { specs: input.specs as unknown as object } : {}),
      ...(nextStatus !== old.status ? { status: nextStatus } : {}),
      version: { increment: 1 },
    };

    // 守卫 status: old.status：读后如有并发状态变更，本次写入整体失败，不覆盖他人决策
    const updated = await tx.product.updateMany({
      where: { id: productId, status: old.status },
      data,
    });
    if (updated.count === 0) {
      throw new AppError(ERROR_CODES.PRODUCT_STATUS_INVALID, "商品状态已变更，请刷新后重试");
    }

    await writeAuditLog(tx, "Product", productId, action, operatorId, {
      before: {
        name: old.name,
        category: old.category,
        subCategory: old.subCategory,
        status: old.status,
      },
      after: { status: nextStatus },
    });

    return { id: productId, status: nextStatus };
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

/** 删除质检模板 — 不存在 404；删除与审计同事务 */
export async function deleteAuditTemplate(categoryId: string, operatorId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const deleted = await tx.categoryAuditTemplate.deleteMany({
      where: { categoryId },
    });
    if (deleted.count === 0) {
      throw new AppError(ERROR_CODES.TEMPLATE_NOT_FOUND, "质检模板不存在");
    }
    await writeAuditLog(tx, "CategoryAuditTemplate", categoryId, "DELETE_TEMPLATE", operatorId);
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

// ── 用户管理：改角色 / 禁用启用 / 解锁 / 重置密码 / 清除年龄验证 ──
// 约束：管理员不能对自己操作（setRole / setStatus）；解锁仅限锁定用户（未锁定 409）；
// 全部状态变更沿用 updateMany + 同事务审计策略，防并发竞态

export type UserRoleOp = "USER" | "BRAND" | "ADMIN";
export type UserStatusOp = "ACTIVE" | "DISABLED";

/** 事务内取目标用户；不存在 → 404 */
async function getTargetUser(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<{ role: string; status: string; lockUntil: Date | null; ageVerified: boolean }> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { role: true, status: true, lockUntil: true, ageVerified: true },
  });
  if (!user) throw new AppError(ERROR_CODES.USER_NOT_FOUND, "用户不存在");
  return user;
}

/** 改角色 — USER/BRAND/ADMIN 互转；不可操作自己 */
export async function setUserRole(
  userId: string,
  role: UserRoleOp,
  operatorId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (userId === operatorId) {
      throw new AppError(ERROR_CODES.CANNOT_OPERATE_SELF, "不能修改自己的角色");
    }
    const target = await getTargetUser(tx, userId);
    if (target.role === role) return; // 幂等：角色未变不落审计
    const updated = await tx.user.updateMany({
      where: { id: userId, role: target.role }, // 读后守卫，防并发覆盖他人修改
      data: { role },
    });
    if (updated.count === 0) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, "用户状态已变更，请刷新后重试");
    }
    await writeAuditLog(tx, "User", userId, "SET_ROLE", operatorId, {
      before: target.role,
      after: role,
    });
  });
}

/** 禁用/启用 — 不可操作自己 */
export async function setUserStatus(
  userId: string,
  status: UserStatusOp,
  operatorId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (userId === operatorId) {
      throw new AppError(ERROR_CODES.CANNOT_OPERATE_SELF, "不能禁用/启用自己");
    }
    const target = await getTargetUser(tx, userId);
    if (target.status === status) return;
    const updated = await tx.user.updateMany({
      where: { id: userId, status: target.status },
      data: { status },
    });
    if (updated.count === 0) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, "用户状态已变更，请刷新后重试");
    }
    await writeAuditLog(tx, "User", userId, status === "DISABLED" ? "USER_DISABLED" : "USER_ENABLED", operatorId, {
      before: target.status,
      after: status,
    });
  });
}

/** 解锁 — 仅锁定（lockUntil 未过期）用户可解锁；未锁定 409 */
export async function unlockUser(userId: string, operatorId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const target = await getTargetUser(tx, userId);
    if (!target.lockUntil || target.lockUntil <= new Date()) {
      throw new AppError(ERROR_CODES.USER_NOT_LOCKED, "该用户未处于锁定状态");
    }
    const updated = await tx.user.updateMany({
      where: { id: userId, lockUntil: target.lockUntil },
      data: { lockUntil: null, failedLoginAttempts: 0 },
    });
    if (updated.count === 0) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, "用户状态已变更，请刷新后重试");
    }
    await writeAuditLog(tx, "User", userId, "USER_UNLOCKED", operatorId);
  });
}

/** 重置密码 — 覆盖 passwordHash（scrypt 哈希），同时解除锁定状态；返回临时密码由管理员转达 */
export async function resetPassword(
  userId: string,
  tempPassword: string,
  operatorId: string,
): Promise<{ tempPassword: string }> {
  if (!/^.{6,20}$/.test(tempPassword)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "临时密码需 6-20 位");
  }
  const passwordHash = await hashPassword(tempPassword);
  await prisma.$transaction(async (tx) => {
    await getTargetUser(tx, userId); // 不存在 → 404，避免对不存在用户「成功」
    await tx.user.updateMany({
      where: { id: userId },
      data: { passwordHash, failedLoginAttempts: 0, lockUntil: null },
    });
    await writeAuditLog(tx, "User", userId, "PASSWORD_RESET", operatorId);
  });
  return { tempPassword };
}

/** 清除年龄验证 — ageVerified → false（用户下次需重新过年龄门禁） */
export async function clearAgeVerification(userId: string, operatorId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const target = await getTargetUser(tx, userId);
    if (!target.ageVerified) return; // 幂等：已未验证不落审计
    const updated = await tx.user.updateMany({
      where: { id: userId, ageVerified: true },
      data: { ageVerified: false },
    });
    if (updated.count === 0) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, "用户状态已变更，请刷新后重试");
    }
    await writeAuditLog(tx, "User", userId, "CLEAR_AGE_VERIFICATION", operatorId, {
      before: true,
      after: false,
    });
  });
}
