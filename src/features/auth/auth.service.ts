// 认证服务 — JWT 双 Token 签发/验证/Refresh Rotation
// Access Token: 15min 无状态 JWT
// Refresh Token: 7d，DB 存 SHA-256 Hash，Header 内编码 userId（解决无状态查找）

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

// ── 配置 ──

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "dev-secret-change-in-production",
);
const ACCESS_TTL = "15m";
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// ── 短信验证码（DB 存储，Serverless 多实例共享）──

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function storeCode(phone: string, code: string): Promise<void> {
  // 清理该号码旧的未使用验证码
  await prisma.verificationCode.deleteMany({
    where: { phone, used: false },
  });
  await prisma.verificationCode.create({
    data: {
      phone,
      code,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 分钟有效
    },
  });
}

async function verifyAndConsumeCode(
  phone: string,
  code: string,
): Promise<boolean> {
  const record = await prisma.verificationCode.findFirst({
    where: {
      phone,
      code,
      used: false,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!record) return false;

  await prisma.verificationCode.update({
    where: { id: record.id },
    data: { used: true },
  });
  return true;
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
  return new SignJWT({ ...user })
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
  phoneHash: string;
}): Promise<AuthTokens> {
  const accessToken = await signAccessToken({
    userId: user.id,
    role: user.role as AuthUser["role"],
    phoneHash: user.phoneHash,
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

/** 发送短信验证码 */
export async function sendVerificationCode(phone: string): Promise<void> {
  // 频率限制：60 秒内同号码不可重复发送
  const recent = await prisma.verificationCode.findFirst({
    where: {
      phone,
      createdAt: { gt: new Date(Date.now() - 60 * 1000) },
    },
  });
  if (recent) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "请 60 秒后再试");
  }

  const code = generateCode();
  await storeCode(phone, code);

  // 短信发送在 API 层投递 Inngest（此处仅生成验证码）
  console.log(`[SMS] ${phone}: ${code}`);
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
  if (existing?.passwordHash) {
    throw new AppError(
      ERROR_CODES.PHONE_ALREADY_EXISTS,
      "该手机号已注册密码登录",
    );
  }

  const passwordHash = hashPassword(password);
  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash },
      })
    : await prisma.user.create({
        data: { phoneHash, passwordHash, role: "USER" },
      });

  return issueTokens(user);
}

/** 密码登录 */
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

  if (!verifyPassword(password, user.passwordHash)) {
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "密码错误");
  }

  return issueTokens(user);
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

  // Rotation：删除旧 Token
  await prisma.refreshToken.delete({ where: { id: token.id } });

  const user = await prisma.user.findUnique({
    where: { id: decoded.userId },
  });
  if (!user) throw new AppError(ERROR_CODES.UNAUTHORIZED, "用户不存在");

  return issueTokens(user);
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
