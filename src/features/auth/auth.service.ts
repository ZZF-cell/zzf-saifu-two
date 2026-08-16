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
import { hitRateLimit, hashKey } from "@/shared/utils/rate-limit";

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

// 限流窗口常量（RateLimitBucket 原子桶）
const SMS_PHONE_WINDOW_MS = 60 * 1000; // 同号 60s 窗口
const SMS_IP_MINUTE_WINDOW_MS = 60 * 1000; // 同 IP 每分钟窗口
const SMS_IP_MINUTE_MAX = 10; // 同 IP 每分钟最多 10 次（防瞬时短信轰炸）
const SMS_IP_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000; // 同 IP 每日窗口
const SMS_IP_DAILY_MAX = 200; // 同 IP 每日最多 200 次（防持久轮换手机号刷量）

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
  // 并发安全：用 updateMany 条件（attempts < MAX-1）把「计数上限」并入原子更新，
  // 杜绝并发错误请求各自读到同一旧值、绕过上限的竞态（回归护栏：并发下也不可超 MAX 次尝试）。
  if (record.code !== code) {
    const updated = await prisma.verificationCode.updateMany({
      where: { id: record.id, used: false, attempts: { lt: MAX_CODE_ATTEMPTS - 1 } },
      data: { attempts: { increment: 1 } },
    });
    // 未命中（attempts 已触顶 MAX-1）→ 本次为第 MAX 次错误，销毁验证码
    if (updated.count === 0) {
      await prisma.verificationCode.deleteMany({ where: { id: record.id, used: false } });
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
 * @param ip 客户端 IP（防短信轰炸的 IP 维度限流；未传则只做同号限流）
 * @returns 「演示模式回显码」：短信未实际送达（未配置密钥 / SDK 未接入）时返回验证码供前端页面提示展示，
 *          便于线上验收阶段无短信也能登录；真实送达（配好短信后）返回 null，届时前端不再显示。
 */
export async function sendVerificationCode(
  phone: string,
  ip?: string,
): Promise<string | null> {
  const phoneHash = hashPhone(phone);
  // 原子限流：同一手机号 60s 窗口最多 1 次。
  // 原 check-then-act（findFirst 60s 内记录在事务外）有竞态——并发请求各自读到
  // 「无近期记录」后同时放行，绕过频率限制；upsert 编译为 INSERT..ON CONFLICT
  // 单语句原子递增，同窗口并发由 DB 串行化，计数只增一次（major② 修复）。
  const phoneLimit = await hitRateLimit("sms:phone", phoneHash, {
    windowMs: SMS_PHONE_WINDOW_MS,
    max: 1,
  });
  if (!phoneLimit.allowed) {
    throw new AppError(
      ERROR_CODES.RATE_LIMITED,
      `发送太频繁，请 ${Math.max(1, Math.ceil(phoneLimit.retryAfterMs / 1000))} 秒后再试`,
    );
  }

  // IP 维度过量防护：send-code 为未登录接口，攻击者可轮换手机号刷接口轰炸任意号码。
  // 双窗口互补：分钟窗口防瞬时轰炸，日窗口防持久刷量（bucketKey 为哈希后的 IP）。
  if (ip) {
    const ipKey = hashKey(ip);
    const ipMinute = await hitRateLimit("sms:ip:minute", ipKey, {
      windowMs: SMS_IP_MINUTE_WINDOW_MS,
      max: SMS_IP_MINUTE_MAX,
    });
    if (!ipMinute.allowed) {
      throw new AppError(ERROR_CODES.RATE_LIMITED, "发送过于频繁，请稍后再试");
    }
    const ipDaily = await hitRateLimit("sms:ip:daily", ipKey, {
      windowMs: SMS_IP_DAILY_WINDOW_MS,
      max: SMS_IP_DAILY_MAX,
    });
    if (!ipDaily.allowed) {
      throw new AppError(ERROR_CODES.RATE_LIMITED, "今日发送次数已达上限，请明天再试");
    }
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

  // 演示模式回显：短信未实际送达时把验证码交还调用方（前端展示），保证线上验收可登录。
  // ⚠️ 安全门禁：生产环境绝不回显 —— 短信未接通时响应回显验证码，等于把任意手机号账号的
  // 控制权交给任何人（POST send-code → 响应拿验证码 → verify-code 即接管/注册该手机号）。
  // 生产环境要启用短信登录，必须完成真实短信集成（actuallySent=true），否则一律返回 null。
  if (process.env.NODE_ENV === "production") return null;
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

  // 被禁用用户禁止通过「补设密码/注册」获取新会话（与 loginWithCode/loginWithPassword 门禁一致）
  if (existing?.status === "DISABLED") {
    throw new AppError(ERROR_CODES.USER_DISABLED, "账号已被禁用，请联系管理员");
  }

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
    // 并发场景下另一个请求已创建，补设密码（并发用户若已被禁用同样拒绝）
    if (user.status === "DISABLED") {
      throw new AppError(ERROR_CODES.USER_DISABLED, "账号已被禁用，请联系管理员");
    }
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
    // 统一文案：不区分「未注册」与「密码错误」，防手机号枚举（探测号码是否注册）
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "手机号或密码错误");
  }

  // 被管理员禁用的用户不可登录
  if (user.status === "DISABLED") {
    throw new AppError(ERROR_CODES.USER_DISABLED, "账号已被禁用，请联系管理员");
  }

  // 锁定检查：文案与普通失败一致（锁定状态本身也是「账号存在」信号，统一防枚举）
  if (user.lockUntil && user.lockUntil > new Date()) {
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "手机号或密码错误");
  }

  const passwordOk = await verifyPassword(password, user.passwordHash);
  if (!passwordOk) {
    // 失败计数原子递增（increment 由 DB 执行，多实例并发不丢计数）；
    // 递增后达到阈值才锁定，计数与锁定在同一事务内 —— 杜绝「读旧值 +1 再写回」竞态
    await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: { increment: 1 } },
      });
      if (updated.failedLoginAttempts >= MAX_LOGIN_ATTEMPTS) {
        await tx.user.update({
          where: { id: user.id },
          data: { lockUntil: new Date(Date.now() + LOGIN_LOCK_MS) },
        });
      }
    });
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, "手机号或密码错误");
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

/** 为短信登录用户设置密码（被禁用用户禁止：access token 15min 内仍有效，禁用门禁必须下沉到写入口） */
export async function setPassword(
  userId: string,
  password: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true },
  });
  if (!user) throw new AppError(ERROR_CODES.UNAUTHORIZED, "用户不存在");
  if (user.status === "DISABLED") {
    throw new AppError(ERROR_CODES.USER_DISABLED, "账号已被禁用，请联系管理员");
  }
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

/**
 * Refresh Token 轮换（含被盗重用检测）
 *
 * Rotation 语义：软吊销旧 token（revokedAt 置位，非物理删除），保留「历史已用」痕迹，
 * 使失窃可被发现 —— 攻击者重放已被轮换的 token 时，能命中已吊销记录 → 吊销该用户
 * 全部会话 + 告警，受害者重新登录即可夺回，而不是被攻击者抢占轮换后静默踢下线。
 */
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
      revokedAt: null, // 仅未吊销的有效 token 可续期
      expiresAt: { gt: new Date() },
    },
  });

  if (!token) {
    // 未命中 → 区分「已轮换/被吊销（被盗重用信号）」与「过期/不存在」：
    // 令牌失窃的判定窗口是「已吊销但仍未过期」——此时重放即为攻击。
    const prior = await prisma.refreshToken.findFirst({
      where: { userId: decoded.userId, tokenHash: expectedHash },
    });
    if (prior?.revokedAt) {
      await prisma.refreshToken.deleteMany({ where: { userId: decoded.userId } });
      console.error(`[auth] Refresh token 重用检测: userId=${decoded.userId}`);
      try {
        captureMessage(`[auth] Refresh token 重用检测 userId=${decoded.userId}`, {
          level: "warning",
        });
      } catch {
        // Sentry 未初始化时静默（console.error 已兜底）
      }
      throw new AppError(ERROR_CODES.TOKEN_EXPIRED, "登录已过期，请重新登录");
    }
    throw new AppError(ERROR_CODES.TOKEN_EXPIRED, "登录已过期，请重新登录");
  }

  // Rotation：软吊销旧 Token + 签发新 Token 在同一事务中
  // 必须在事务开头立即 atomic revoke，防止其他并发 Refresh 重用同一 Token
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Atomic revoke：other concurrent Refresh on the same token will get 0 rows
      const revoked = await tx.refreshToken.updateMany({
        where: { id: token.id, userId: decoded.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revoked.count === 0) {
        throw new AppError(ERROR_CODES.TOKEN_EXPIRED, "登录已过期，请重新登录");
      }

      const u = await tx.user.findUnique({
        where: { id: decoded.userId },
      });
      if (!u) throw new AppError(ERROR_CODES.UNAUTHORIZED, "用户不存在");

      // 被禁用用户禁止续期：同事务吊销其全部会话（其他设备的 refresh token 一并失效），
      // 并拒绝签发 —— 禁用必须对已有会话立即生效，而非等 access token 15min 自然过期
      if (u.status === "DISABLED") {
        await tx.refreshToken.deleteMany({ where: { userId: u.id } });
        throw new AppError(ERROR_CODES.USER_DISABLED, "账号已被禁用，请联系管理员");
      }

      const newRawToken = encodeRefreshToken(u.id);
      const newHash = sha256(newRawToken);
      await tx.refreshToken.create({
        data: {
          userId: u.id,
          tokenHash: newHash,
          expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        },
      });

      // 顺手清理该用户已过期的 token（轮换历史 + 软删记录，防止软删表只增不减）
      await tx.refreshToken.deleteMany({
        where: { userId: u.id, expiresAt: { lt: new Date() } },
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
    // 事务冲突时（P2025 RecordNotFound 或 updateMany count=0）→ TOKEN_EXPIRED
    throw new AppError(ERROR_CODES.TOKEN_EXPIRED, "登录已过期，请重新登录");
  }
}

/** 退出登录 — 吊销所有 Refresh Token */
export async function logout(userId: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { userId } });
}

/**
 * 依据 refresh token 吊销会话（access token 过期/缺失时也能登出）。
 * refresh token 内嵌 userId（base64url(userId:random)），解码可得会话归属；
 * 解码失败（畸形 token）→ 退化为按 tokenHash 删除单条。
 */
export async function logoutByRefreshToken(rawToken: string): Promise<void> {
  const decoded = decodeRefreshToken(rawToken);
  if (decoded) {
    await logout(decoded.userId);
    return;
  }
  await prisma.refreshToken.deleteMany({ where: { tokenHash: sha256(rawToken) } });
}

/**
 * 从 DB 读取用户当前身份上下文（role + status）。
 * Access Token 是无状态 JWT，载荷中的 role/status 在签发后可能已变更——
 * 每次鉴权用 DB 实时值校准，让「禁用 / 角色变更」立即生效（15min 窗口归零）。
 */
export async function getUserAuthContext(
  userId: string,
): Promise<{ id: string; role: string; status: string } | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true },
  });
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
