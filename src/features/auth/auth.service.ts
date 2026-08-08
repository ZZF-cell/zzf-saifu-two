// 认证服务 — JWT 双 Token 签发/验证/Refresh Rotation
// Access Token: 15min 无状态 JWT
// Refresh Token: 7d，DB 存 SHA-256 Hash，支持 Rotation

import { SignJWT, jwtVerify } from "jose";
import { prisma } from "@/shared/db/client";
import { hashPassword, verifyPassword, hashPhone, generateToken } from "@/shared/utils/crypto";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import type { AuthUser } from "@/shared/auth/middleware";

// ── 配置 ──

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "dev-secret-change-in-production",
);
const ACCESS_TTL = "15m";
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// ── 短信验证码（内存存储，生产换 Redis）──

const codeStore = new Map<string, { code: string; expiresAt: number }>();

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function storeCode(phone: string, code: string): void {
  codeStore.set(phone, { code, expiresAt: Date.now() + 5 * 60 * 1000 }); // 5 分钟有效
}

function verifyCode(phone: string, code: string): boolean {
  const stored = codeStore.get(phone);
  if (!stored) return false;
  if (Date.now() > stored.expiresAt) {
    codeStore.delete(phone);
    return false;
  }
  if (stored.code !== code) return false;
  codeStore.delete(phone); // 一次性消费
  return true;
}

// ── Token 签发 ──

async function signAccessToken(user: AuthUser): Promise<string> {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(JWT_SECRET);
}

async function signRefreshToken(userId: string): Promise<string> {
  const raw = generateToken(32);
  const tokenHash = hashPassword(raw); // 复用 salt+hash 逻辑存储
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return raw;
}

async function rotateRefreshToken(
  userId: string,
  oldTokenId?: string,
): Promise<string> {
  // 删除旧 Refresh Token（如果提供了 ID）
  if (oldTokenId) {
    // 找到并删除该用户的所有过期 token + 当前 token
    await prisma.refreshToken.deleteMany({
      where: {
        userId,
        expiresAt: { lt: new Date() },
      },
    });
  }
  return signRefreshToken(userId);
}

// ── 公开 API ──

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/** 发送短信验证码 */
export async function sendVerificationCode(phone: string): Promise<void> {
  // 频率限制：60 秒内同号码不可重复发送
  const existing = codeStore.get(phone);
  if (existing && Date.now() - (existing.expiresAt - 5 * 60 * 1000) < 60000) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "请 60 秒后再试");
  }

  const code = generateCode();
  storeCode(phone, code);

  // 短信发送在 API 层投递 Inngest（此处仅生成验证码）
  console.log(`[SMS] ${phone}: ${code}`);
}

/** 短信验证码登录（新用户自动注册） */
export async function loginWithCode(phone: string, code: string): Promise<AuthTokens> {
  if (!verifyCode(phone, code)) {
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "验证码错误或已过期");
  }

  const phoneHash = hashPhone(phone);
  let user = await prisma.user.findUnique({ where: { phoneHash } });

  if (!user) {
    // 新用户自动注册
    try {
      user = await prisma.user.create({
        data: { phoneHash, role: "USER" },
      });
    } catch {
      // 并发注册时可能冲突，重新查询
      user = await prisma.user.findUnique({ where: { phoneHash } });
      if (!user) throw new AppError(ERROR_CODES.INTERNAL_ERROR, "注册失败");
    }
  }

  const accessToken = await signAccessToken({
    userId: user.id,
    role: user.role as AuthUser["role"],
    phoneHash: user.phoneHash,
  });
  const refreshToken = await signRefreshToken(user.id);

  return { accessToken, refreshToken };
}

/** 密码注册 */
export async function registerWithPassword(
  phone: string,
  password: string,
  code: string,
): Promise<AuthTokens> {
  // 先验证短信验证码（防止机器人注册）
  if (!verifyCode(phone, code)) {
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "验证码错误或已过期");
  }

  const phoneHash = hashPhone(phone);
  const existing = await prisma.user.findUnique({ where: { phoneHash } });
  if (existing?.passwordHash) {
    throw new AppError(ERROR_CODES.PHONE_ALREADY_EXISTS, "该手机号已注册密码登录");
  }

  const passwordHash = hashPassword(password);
  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data: { passwordHash } })
    : await prisma.user.create({ data: { phoneHash, passwordHash, role: "USER" } });

  const accessToken = await signAccessToken({
    userId: user.id,
    role: user.role as AuthUser["role"],
    phoneHash: user.phoneHash,
  });
  const refreshToken = await signRefreshToken(user.id);

  return { accessToken, refreshToken };
}

/** 密码登录 */
export async function loginWithPassword(
  phone: string,
  password: string,
): Promise<AuthTokens> {
  const phoneHash = hashPhone(phone);
  const user = await prisma.user.findUnique({ where: { phoneHash } });

  if (!user || !user.passwordHash) {
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "该手机号未注册密码登录，请使用验证码登录");
  }

  if (!verifyPassword(password, user.passwordHash)) {
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "密码错误");
  }

  const accessToken = await signAccessToken({
    userId: user.id,
    role: user.role as AuthUser["role"],
    phoneHash: user.phoneHash,
  });
  const refreshToken = await signRefreshToken(user.id);

  return { accessToken, refreshToken };
}

/** 为短信登录用户设置密码 */
export async function setPassword(
  userId: string,
  password: string,
): Promise<void> {
  const passwordHash = hashPassword(password);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });
}

/** Refresh Token 轮换 */
export async function refreshAccessToken(
  rawRefreshToken: string,
): Promise<AuthTokens> {
  // 遍历查找匹配的 Refresh Token（因为 tokenHash 是 salted）
  const tokens = await prisma.refreshToken.findMany({
    where: { expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  let matchedToken: { id: string; userId: string } | null = null;
  for (const t of tokens) {
    if (verifyPassword(rawRefreshToken, t.tokenHash)) {
      matchedToken = { id: t.id, userId: t.userId };
      break;
    }
  }

  if (!matchedToken) {
    throw new AppError(ERROR_CODES.TOKEN_EXPIRED, "登录已过期，请重新登录");
  }

  // 删除当前 Refresh Token
  await prisma.refreshToken.delete({ where: { id: matchedToken.id } });

  const user = await prisma.user.findUnique({ where: { id: matchedToken.userId } });
  if (!user) throw new AppError(ERROR_CODES.UNAUTHORIZED, "用户不存在");

  const accessToken = await signAccessToken({
    userId: user.id,
    role: user.role as AuthUser["role"],
    phoneHash: user.phoneHash,
  });
  const refreshToken = await signRefreshToken(user.id);

  return { accessToken, refreshToken };
}

/** 退出登录 — 吊销所有 Refresh Token */
export async function logout(userId: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { userId } });
}

/** 验证 Access Token，返回当前用户 */
export async function verifyAccessToken(token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as unknown as AuthUser;
  } catch {
    return null;
  }
}

/** 获取用户信息（用于查询） */
export async function getUserById(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      phoneHash: true,
      nickname: true,
      role: true,
      ageVerified: true,
      createdAt: true,
    },
  });
}
