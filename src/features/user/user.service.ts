// 用户写入操作 — 修改个人信息 / 改手机号 / 注销 / 头像（CQS：本文件只写不读）
import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { hashPhone, verifyPassword } from "@/shared/utils/crypto";
import { isOssUrlOwnedBy } from "@/shared/adapters/oss.adapter";
// 跨 feature 消费走 Public API（边界规则：feature-internal 不得直连其他 feature-internal）
import { authService } from "@/features/auth";

// ── 修改昵称 ──

export async function updateNickname(
  userId: string,
  nickname: string,
): Promise<{ nickname: string }> {
  const trimmed = nickname.trim();
  if (!trimmed) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "昵称不能为空");
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: { nickname: trimmed },
    select: { nickname: true },
  });

  return { nickname: user.nickname ?? "" };
}

// ── 修改头像 ──

/**
 * 设置/清除头像。
 * - avatarUrl 为空字符串 → 清除头像（置 null）
 * - avatarUrl 非空 → 必须是本人经 /api/upload 上传的 OSS URL
 *   （G4 归属校验：key 内嵌 userId，拒绝贴他人/伪造图片）
 */
export async function updateAvatar(
  userId: string,
  avatarUrl: string,
): Promise<{ avatarUrl: string | null }> {
  const trimmed = avatarUrl.trim();
  if (trimmed && !isOssUrlOwnedBy(trimmed, userId)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "头像必须是您上传的图片");
  }
  const user = await prisma.user.update({
    where: { id: userId },
    data: { avatarUrl: trimmed || null },
    select: { avatarUrl: true },
  });
  return { avatarUrl: user.avatarUrl };
}

// ── 修改手机号（新号短信验证） ──

/**
 * 换绑手机号。
 * 流程：旧凭证复验（有密码验旧密码；纯短信用户验旧号验证码）→ 新号验证码校验 →
 * 事务内更新 phoneHash + 清旧号验证码 + 吊销全部会话。
 * - 新号与当前相同 → VALIDATION_ERROR（无意义换绑）
 * - 旧凭证错误/缺失 → INVALID_CREDENTIALS（防会话被盗者换绑接管账号）
 * - 验证码错误/过期 → INVALID_CREDENTIALS（复用 auth 防爆破语义）
 * - phoneHash 唯一冲突（新号已被注册）→ 捕 P2002 → PHONE_ALREADY_EXISTS
 */
export async function changePhone(
  userId: string,
  newPhone: string,
  code: string,
  oldPassword?: string,
  oldPhone?: string,
  oldCode?: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { phoneHash: true, status: true, passwordHash: true },
  });
  if (!user) throw new AppError(ERROR_CODES.UNAUTHORIZED, "用户不存在");
  if (user.status === "DISABLED") {
    throw new AppError(ERROR_CODES.USER_DISABLED, "账号已被禁用，请联系管理员");
  }

  const newPhoneHash = hashPhone(newPhone);
  if (newPhoneHash === user.phoneHash) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "新手机号与当前手机号相同");
  }

  // 换绑前复验旧凭证：换绑后登录凭证（手机号）即变更，仅凭新号验证码就能换绑，
  // 会话被盗者（拿到 access 15min）可把账号换绑到自己手机号永久接管。
  // 有密码 → 验旧密码；纯短信用户（无密码）→ 验旧号短信验证码。
  if (user.passwordHash) {
    if (!oldPassword) {
      throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "请输入当前登录密码");
    }
    const ok = await verifyPassword(oldPassword, user.passwordHash);
    if (!ok) {
      throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "当前密码错误");
    }
  } else {
    if (!oldPhone || !oldCode) {
      throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "请输入旧手机号及验证码");
    }
    const oldValid = await authService.verifyAndConsumeCode(oldPhone, oldCode);
    if (!oldValid) {
      throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "旧手机号验证码错误或已过期");
    }
  }

  const valid = await authService.verifyAndConsumeCode(newPhone, code);
  if (!valid) {
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "新手机号验证码错误或已过期");
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { phoneHash: newPhoneHash },
      });
      // 旧号作废：清除旧号下未消费的验证码（新号验证码已被消费，无需处理）
      await tx.verificationCode.deleteMany({
        where: { phoneHash: user.phoneHash },
      });
      // 换绑后吊销全部会话：旧 access/refresh 立即失效，防止换绑操作后旧会话继续有效
      // （攻击者换绑成功时，受害者的旧会话也不能再续期，收窄接管窗口）
      await tx.refreshToken.deleteMany({ where: { userId } });
    });
  } catch (err) {
    // phoneHash 唯一约束冲突（并发场景下新号恰好被注册）
    if (
      err &&
      typeof err === "object" &&
      (err as { code?: string }).code === "P2002"
    ) {
      throw new AppError(ERROR_CODES.PHONE_ALREADY_EXISTS, "该手机号已被注册");
    }
    throw err;
  }
}

// ── 自主注销（硬删除，不可逆） ──

/**
 * 硬删除账号（用户主动注销，不可逆）。
 * 拦截/校验顺序：
 * 1. SUPER 唯一账号不可注销 → FORBIDDEN
 * 2. 已入驻品牌 → 409 ACCOUNT_HAS_BRAND（品牌/商品数据无法匿名化，须先解约）
 * 3. 有密码 → 验旧密码（防被盗设备一键销毁账号）
 *
 * 数据处置（单事务）：
 * - 删除会话（RefreshToken）与购物车（CartItem）
 * - 历史数据匿名化保留：订单 / 邀请码 / 咨询工单的 userId、工单消息 senderId 置空
 * - 删除该手机号验证码记录 → 删除 User
 */
export async function deleteAccount(
  userId: string,
  password?: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      phoneHash: true,
      role: true,
      status: true,
      passwordHash: true,
      brand: { select: { id: true } },
    },
  });
  if (!user) throw new AppError(ERROR_CODES.UNAUTHORIZED, "用户不存在");

  // SUPER 唯一账号保护：不可被注销（与其他账号不可操作 SUPER 同源护栏）
  if (user.role === "SUPER") {
    throw new AppError(ERROR_CODES.FORBIDDEN, "最高权限者账号不可注销");
  }
  // 已入驻品牌：品牌/商品/检测记录等数据无法匿名化，注销前须先解约
  if (user.brand) {
    throw new AppError(
      ERROR_CODES.ACCOUNT_HAS_BRAND,
      "已入驻品牌，请先解约品牌后再注销",
    );
  }
  // 有密码 → 验旧密码（与改密同款门禁，防他人代注销）
  if (user.passwordHash) {
    if (!password) {
      throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "请输入登录密码");
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "密码错误");
    }
  }

  await prisma.$transaction(async (tx) => {
    // 1. 会话与购物车（级联依赖，显式删除保证事务内行为自文档化）
    await tx.refreshToken.deleteMany({ where: { userId } });
    await tx.cartItem.deleteMany({ where: { userId } });
    // 2. 历史数据匿名化：订单/邀请码/工单保留，user 关联置空
    await tx.order.updateMany({ where: { userId }, data: { userId: null } });
    await tx.inviteCode.updateMany({
      where: { createdBy: userId },
      data: { createdBy: null },
    });
    await tx.serviceTicket.updateMany({
      where: { userId },
      data: { userId: null },
    });
    await tx.serviceTicketMessage.updateMany({
      where: { senderId: userId },
      data: { senderId: null },
    });
    // 审计日志操作人置空（operatorId 无 FK，遗留悬空引用污染回溯；注销后审计留痕匿名）
    await tx.auditLog.updateMany({
      where: { operatorId: userId },
      data: { operatorId: null },
    });
    // 3. 删除验证码记录（按 phoneHash）+ 删除用户
    await tx.verificationCode.deleteMany({ where: { phoneHash: user.phoneHash } });
    await tx.user.delete({ where: { id: userId } });
  });
}
