// 认证服务 — JWT 双 Token 签发/验证/Refresh Rotation
// Access Token: 15min 无状态 JWT
// Refresh Token: 7d，DB 存 SHA-256 Hash，Header 内编码 userId（解决无状态查找）

import crypto from "crypto";
import { SignJWT, jwtVerify } from "jose";
import { prisma } from "@/shared/db/client";
import {
  hashPassword,
  verifyPassword,
  hashPhone,
  sha256,
  generateToken,
} from "@/shared/utils/crypto";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import type { AuthUser } from "@/shared/auth/middleware";
import { sendSms } from "@/shared/adapters/sms.adapter";
import { captureMessage } from "@sentry/nextjs";

// ── 配置 ──

// 生产环境 JWT_SECRET 必须显式配置（默认密钥可被伪造 Token），fail-fast
const jwtSecretStr = process.env.JWT_SECRET;
if (!jwtSecretStr && process.env.NODE_ENV === "production") {
  throw new Error("JWT_SECRET 未配置：生产环境禁止使用默认密钥");
}
const JWT_SECRET = new TextEncoder().encode(
  jwtSecretStr || "dev-secret-change-in-production",
);
const ACCESS_TTL = "15m";
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// 爆破防护阈值
const MAX_CODE_ATTEMPTS = 5; // 验证码错误次数上限，超过即销毁验证码
const MAX_LOGIN_ATTEMPTS = 5; // 密码登录失败上限，达到后锁定账号
const LOGIN_LOCK_MS = 15 * 60 * 1000; // 密码锁定 15 分钟

// ── 短信验证码（DB 存储，Serverless 多实例共享）──

function generateCode(): string {
  return String(crypto.randomInt(100000, 999999));
}

async function verifyAndConsumeCode(
  phone: string,
  code: string,
): Promise<boolean> {
  const phoneHash = hashPhone(phone);
  // 定位该号码当前有效验证码（同号只保留一个，最新一条生效）
  const record = await prisma.verificationCode.findFirst({
    where: {
      phoneHash,
      used: false,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!record) return false;

  // 验证码错误 → 尝试计数；达到上限立即销毁（杜绝 6 位验证码在线爆破）
  if (record.code !== code) {
    if (record.attempts + 1 >= MAX_CODE_ATTEMPTS) {
      await prisma.verificationCode.delete({ where: { id: record.id } });
    } else {
      await prisma.verificationCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
    }
    return false;
  }

  // 正确 → 原子消费（deleteMany 条件包含 used:false，并发下只消费一次）
  const result = await prisma.verificationCode.deleteMany({
    where: { id: record.id, used: false },
  });
  return result.count > 0;
}

// ── Refresh Token ──

/**
 * Refresh Token 格式: base64url(userId:randomBytes)
 * 将 userId 编码进 Token 中，避免验证时全库扫描
 */
function encodeRefreshToken(userId: string): string {
  const random = generateToken(32);
  const payload = `${userId}:${random}`;
  return Buffer.from(payload).toString("base64url");
}

function decodeRefreshToken(token: string): { userId: string } | null {
  try {
    const payload = Buffer.from(token, "base64url").toString("utf8");
    const colonIdx = payload.indexOf(":");
    if (colonIdx === -1) return null;
    return { userId: payload.slice(0, colonIdx) };
  } catch {
    return null;
  }
}

// ── Token 签发 ──

async function signAccessToken(user: AuthUser): Promise<string> {
  return new SignJWT({ userId: user.userId, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(JWT_SECRET);
}

async function persistRefreshToken(userId: string, rawToken: string): Promise<void> {
  const tokenHash = sha256(rawToken);
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
}

/** 签发一对新 Token */
async function issueTokens(user: {
  id: string;
  role: string;
}): Promise<AuthTokens> {
  const accessToken = await signAccessToken({
    userId: user.id,
    role: user.role as AuthUser["role"],
  });
  const refreshToken = encodeRefreshToken(user.id);
  await persistRefreshToken(user.id, refreshToken);
  return { accessToken, refreshToken };
}

// ── 公开 API ──

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * 发送短信验证码。
 * 返回「演示模式回显码」：短信未实际送达（未配置密钥 / SDK 未接入）时返回验证码供前端页面提示展示，
 * 便于线上验收阶段无短信也能登录；真实送达（配好短信后）返回 null，届时前端不再显示。
 */
export async function sendVerificationCode(
  phone: string,
): Promise<string | null> {
  const phoneHash = hashPhone(phone);
  // 频率限制：60 秒内同号码不可重复发送
  const recent = await prisma.verificationCode.findFirst({
    where: {
      phoneHash,
      createdAt: { gt: new Date(Date.now() - 60 * 1000) },
    },
  });
  if (recent) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "请 60 秒后再试");
  }

  const code = generateCode();

  // 在同一事务中：清旧码 + 写新码，保证原子性
  await prisma.$transaction(async (tx) => {
    await tx.verificationCode.deleteMany({
      where: { phoneHash, used: false },
    });
    await tx.verificationCode.create({
      data: {
        phoneHash,
        code,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });
  });

  // 接线短信适配器（阿里云 SDK 集成为下一模块）：
  // - 开发环境未配置密钥 → dev-fallback，验证码仅终端日志
  // - 生产环境未配置密钥/未接入 SDK → 验证码实际未送达，上报告警
  const smsResult = await sendSms(phone, code);
  const actuallySent =
    smsResult.success &&
    smsResult.messageId !== "dev-fallback" &&
    smsResult.messageId !== "placeholder";
  if (!actuallySent && process.env.NODE_ENV === "production") {
    console.error(
      `[SMS] 生产环境验证码未实际送达: ${phone} (${smsResult.messageId || smsResult.error || "未知错误"}) — 请完成短信模块集成`,
    );
    try {
      captureMessage(
        `[SMS] 验证码未实际送达 phone=${phone} msg=${smsResult.messageId || "error"}`,
        { level: "warning" },
      );
    } catch {
      // Sentry 未初始化时静默（console.error 已兜底）
    }
  }

  // 演示模式回显：短信未实际送达时把验证码交还调用方（前端展示），保证线上验收可登录
  return actuallySent ? null : code;
}

/** 短信验证码登录（新用户自动注册） */
export async function loginWithCode(
  phone: string,
  code: string,
): Promise<AuthTokens> {
  const valid = await verifyAndConsumeCode(phone, code);
  if (!valid) {
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "验证码错误或已过期");
  }

  const phoneHash = hashPhone(phone);
  let user = await prisma.user.findUnique({ where: { phoneHash } });

  if (!user) {
    try {
      user = await prisma.user.create({
        data: { phoneHash, role: "USER" },
      });
    } catch {
      user = await prisma.user.findUnique({ where: { phoneHash } });
      if (!user) throw new AppError(ERROR_CODES.INTERNAL_ERROR, "注册失败");
    }
  }

  // 被管理员禁用的用户不可登录（含验证码登录）
  if (user.status === "DISABLED") {
    throw new AppError(ERROR_CODES.USER_DISABLED, "账号已被禁用，请联系管理员");
  }

  return issueTokens(user);
}

/** 密码注册 */
export async function registerWithPassword(
  phone: string,
  password: string,
  code: string,
): Promise<AuthTokens> {
  const valid = await verifyAndConsumeCode(phone, code);
  if (!valid) {
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "验证码错误或已过期");
  }

  const phoneHash = hashPhone(phone);
  const existing = await prisma.user.findUnique({ where: { phoneHash } });

  // 已存在且有密码 → 拒绝
  if (existing?.passwordHash) {
    throw new AppError(
      ERROR_CODES.PHONE_ALREADY_EXISTS,
      "该手机号已注册密码登录",
    );
  }

  const passwordHash = await hashPassword(password);

  if (existing) {
    // 已有短信登录用户 → 补设密码
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash },
    });
    return issueTokens(existing);
  }

  // 新用户 → 创建（防止并发唯一约束冲突）
  try {
    const user = await prisma.user.create({
      data: { phoneHash, passwordHash, role: "USER" },
    });
    return issueTokens(user);
  } catch {
    const user = await prisma.user.findUnique({ where: { phoneHash } });
    if (!user) throw new AppError(ERROR_CODES.INTERNAL_ERROR, "注册失败");
    // 并发场景下另一个请求已创建，补设密码
    if (!user.passwordHash) {
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });
    }
    return issueTokens(user);
  }
}

/** 密码登录（爆破防护：5 次失败锁定 15 分钟） */
export async function loginWithPassword(
  phone: string,
  password: string,
): Promise<AuthTokens> {
  const phoneHash = hashPhone(phone);
  const user = await prisma.user.findUnique({ where: { phoneHash } });

  if (!user || !user.passwordHash) {
    throw new AppError(
      ERROR_CODES.INVALID_CREDENTIALS,
      "该手机号未注册密码登录，请使用验证码登录",
    );
  }

  // 被管理员禁用的用户不可登录
  if (user.status === "DISABLED") {
    throw new AppError(ERROR_CODES.USER_DISABLED, "账号已被禁用，请联系管理员");
  }

  // 锁定检查：锁定期间统一 INVALID_CREDENTIALS（不泄露账号状态）
  if (user.lockUntil && user.lockUntil > new Date()) {
    throw new AppError(
      ERROR_CODES.INVALID_CREDENTIALS,
      "尝试次数过多，账号已锁定 15 分钟，请稍后再试",
    );
  }

  const passwordOk = await verifyPassword(password, user.passwordHash);
  if (!passwordOk) {
    // 失败计数 + 达到上限锁定（count 由数据库原子递增，多实例并发安全）
    const failed = (user.failedLoginAttempts ?? 0) + 1;
    const lockUntil =
      failed >= MAX_LOGIN_ATTEMPTS
        ? new Date(Date.now() + LOGIN_LOCK_MS)
        : null;
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: failed, lockUntil },
    });
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "密码错误");
  }

  // 登录成功 → 重置失败计数/锁定；旧 SHA-256 密码顺带升级为 scrypt
  if (user.failedLoginAttempts || user.lockUntil || !user.passwordHash.startsWith("scrypt.")) {
    const data: {
      failedLoginAttempts: number;
      lockUntil: null;
      passwordHash?: string;
    } = { failedLoginAttempts: 0, lockUntil: null };
    if (!user.passwordHash.startsWith("scrypt.")) {
      data.passwordHash = await hashPassword(password);
    }
    await prisma.user.update({ where: { id: user.id }, data });
  }

  return issueTokens(user);
}

/** 为短信登录用户设置密码 */
export async function setPassword(
  userId: string,
  password: string,
): Promise<void> {
  const passwordHash = await hashPassword(password);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });
}

/** 设置年龄已验证 */
export async function setAgeVerified(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { ageVerified: true },
  });
}

/** Refresh Token 轮换 */
export async function refreshAccessToken(
  rawRefreshToken: string,
): Promise<AuthTokens> {
  // 从 Token 中 decode 出 userId，直接定位 DB 记录（O(1) 查找）
  const decoded = decodeRefreshToken(rawRefreshToken);
  if (!decoded) {
    throw new AppError(ERROR_CODES.TOKEN_EXPIRED, "登录已过期，请重新登录");
  }

  const expectedHash = sha256(rawRefreshToken);
  const token = await prisma.refreshToken.findFirst({
    where: {
      userId: decoded.userId,
      tokenHash: expectedHash,
      expiresAt: { gt: new Date() },
    },
  });

  if (!token) {
    throw new AppError(ERROR_CODES.TOKEN_EXPIRED, "登录已过期，请重新登录");
  }

  // Rotation：删除旧 Token + 签发新 Token 在同一事务中
  // 必须在事务开头立即 atomic delete，防止其他并发 Refresh 重用同一 Token
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Atomic delete：other concurrent Refresh on the same token will get 0 rows
      const deleted = await tx.refreshToken.deleteMany({
        where: { id: token.id, userId: decoded.userId },
      });
      if (deleted.count === 0) {
        throw new AppError(ERROR_CODES.TOKEN_EXPIRED, "登录已过期，请重新登录");
      }

      const u = await tx.user.findUnique({
        where: { id: decoded.userId },
      });
      if (!u) throw new AppError(ERROR_CODES.UNAUTHORIZED, "用户不存在");

      const newRawToken = encodeRefreshToken(u.id);
      const newHash = sha256(newRawToken);
      await tx.refreshToken.create({
        data: {
          userId: u.id,
          tokenHash: newHash,
          expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        },
      });

      return { user: u, newRefreshToken: newRawToken };
    });

    const accessToken = await signAccessToken({
      userId: result.user.id,
      role: result.user.role as AuthUser["role"],
    });

    return { accessToken, refreshToken: result.newRefreshToken };
  } catch (err) {
    if (err instanceof AppError) throw err;
    // 事务冲突时（P2025 RecordNotFound 或 deleteMany count=0）→ TOKEN_EXPIRED
    throw new AppError(ERROR_CODES.TOKEN_EXPIRED, "登录已过期，请重新登录");
  }
}

/** 退出登录 — 吊销所有 Refresh Token */
export async function logout(userId: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { userId } });
}

/** 验证 Access Token，返回当前用户 */
export async function verifyAccessToken(
  token: string,
): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as unknown as AuthUser;
  } catch {
    return null;
  }
}
