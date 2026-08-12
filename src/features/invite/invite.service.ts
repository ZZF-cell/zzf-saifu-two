// Invite 模块 Service — 品牌入驻激活（CQS：本文件只写）
//
// 核心契约：
// - 激活 = 原子消耗邀请码 + 创建 PENDING 品牌，单 $transaction
// - 邀请码消耗用 updateMany 状态守卫（防并发重复激活），Brand.ownerId @unique 兜底
// - 过期（UNUSED + expiresAt < now）码在 WHERE 中直接排除，绝不消耗
// - 角色升级放在管理员审核通过时（admin.service.reviewBrand），本模块不触碰 auth 角色
//   —— 保证「审核未通过前，品牌方无 BRAND 权限，无法进入 /brand 提交商品」

import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";

export interface ActivateInviteInput {
  code: string;
  name: string;
  logo?: string;
}

export interface ActivateInviteResult {
  brandId: string;
}

/** 邀请码状态守卫（原子消耗）：仅 UNUSED 且未过期的码可被消耗 */
export function consumeInviteCodeWhere(code: string, now: Date) {
  return {
    code,
    status: "UNUSED",
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

export async function activateInviteCode(
  input: ActivateInviteInput,
  userId: string,
): Promise<ActivateInviteResult> {
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();

  return prisma.$transaction(async (tx) => {
    // a. 一人一品牌 + 角色守卫（激活面向普通用户，ADMIN 与已有品牌者拦截）
    const existingBrand = await tx.brand.findUnique({
      where: { ownerId: userId },
      select: { id: true },
    });
    if (existingBrand) {
      throw new AppError(ERROR_CODES.BRAND_ALREADY_EXISTS, "您已拥有品牌");
    }
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, "用户不存在");
    }
    if (user.role !== "USER") {
      // ADMIN/BRAND 均不可走入驻激活（BRAND 已在上面被品牌存在性拦截）
      throw new AppError(ERROR_CODES.FORBIDDEN, "当前账号无需激活品牌");
    }

    // b. 原子消耗邀请码（并发下两个请求只有一个 updateMany 命中 count=1）
    const now = new Date();
    const consumed = await tx.inviteCode.updateMany({
      where: consumeInviteCodeWhere(code, now),
      data: { status: "USED", usedAt: now, usedBy: userId },
    });

    // 未命中：区分 已用(409) / 过期(410) / 无效(400)
    // 注意：激活侧不向品牌用户暴露「码是否存在」，无效一律 400（防枚举探测）
    if (consumed.count === 0) {
      const ic = await tx.inviteCode.findUnique({
        where: { code },
        select: { status: true, expiresAt: true },
      });
      if (!ic) throw new AppError(ERROR_CODES.INVITE_CODE_INVALID, "邀请码无效");
      if (ic.status === "USED") {
        throw new AppError(ERROR_CODES.INVITE_CODE_USED, "邀请码已被使用");
      }
      if (ic.expiresAt && ic.expiresAt < now) {
        throw new AppError(ERROR_CODES.INVITE_CODE_EXPIRED, "邀请码已过期");
      }
      throw new AppError(ERROR_CODES.INVITE_CODE_INVALID, "邀请码无效");
    }

    // c. 创建 PENDING 品牌（ownerId @unique 是并发的最终兜底）
    try {
      const brand = await tx.brand.create({
        data: {
          name,
          logo: input.logo?.trim() || null,
          status: "PENDING",
          inviteCode: code,
          ownerId: userId,
        },
        select: { id: true },
      });
      return { brandId: brand.id };
    } catch (error) {
      // 并发窗口内另一激活已抢建品牌 → ownerId 唯一约束冲突
      const ownerHasBrand = await tx.brand.findUnique({
        where: { ownerId: userId },
        select: { id: true },
      });
      if (ownerHasBrand) {
        throw new AppError(ERROR_CODES.BRAND_ALREADY_EXISTS, "您已拥有品牌");
      }
      throw error;
    }
  });
}
