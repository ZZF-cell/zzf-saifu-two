// 认证 API Route Handlers
import { NextResponse } from "next/server";
import { z } from "zod";
import { withValidation, apiError } from "@/shared/utils/api";
import { ERROR_CODES, AppError } from "@/shared/errors/errors";
import * as authService from "./auth.service";
import * as authQueries from "./auth.queries";
import type { AuthUser } from "@/shared/auth/middleware";

// ── Zod Schemas ──

const sendCodeSchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/, "手机号格式不正确"),
});

const verifyCodeSchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/),
  code: z.string().length(6, "验证码为 6 位数字"),
});

const loginSchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/),
  password: z.string().min(6, "密码至少 6 位"),
});

const registerSchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/),
  password: z.string().min(6, "密码至少 6 位"),
  code: z.string().length(6, "验证码为 6 位数字"),
});

const setPasswordSchema = z.object({
  password: z.string().min(6, "密码至少 6 位"),
});

// ── Cookie 工具 ──

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
};

function setTokenCookies(
  response: NextResponse,
  tokens: { accessToken: string; refreshToken: string },
): void {
  response.cookies.set("access_token", tokens.accessToken, {
    ...COOKIE_OPTIONS,
    maxAge: 15 * 60,
  });
  response.cookies.set("refresh_token", tokens.refreshToken, {
    ...COOKIE_OPTIONS,
    path: "/api/auth",
    maxAge: 7 * 24 * 60 * 60,
  });
}

function clearTokenCookies(response: NextResponse): void {
  response.cookies.set("access_token", "", { ...COOKIE_OPTIONS, maxAge: 0 });
  response.cookies.set("refresh_token", "", { ...COOKIE_OPTIONS, path: "/api/auth", maxAge: 0 });
}

function extractAccessToken(req: Request): string | null {
  return req.headers.get("cookie")?.match(/access_token=([^;]+)/)?.[1] ?? null;
}

function extractRefreshToken(req: Request): string | null {
  return req.headers.get("cookie")?.match(/refresh_token=([^;]+)/)?.[1] ?? null;
}

// ── Auth guard — 从请求中校验用户身份，代码复用 ──

async function requireAuthFromRequest(req: Request): Promise<AuthUser> {
  const token = extractAccessToken(req);
  if (!token) throw new AppError(ERROR_CODES.UNAUTHORIZED, "请先登录");
  const user = await authService.verifyAccessToken(token);
  if (!user) throw new AppError(ERROR_CODES.TOKEN_EXPIRED, "登录已过期");
  return user;
}

// ── Route Handlers ──

/** POST /api/auth/send-code */
export const sendCode = withValidation(sendCodeSchema, async ({ phone }) => {
  await authService.sendVerificationCode(phone);
  return NextResponse.json({ success: true });
});

/** POST /api/auth/verify-code */
export const verifyCodeHandler = withValidation(
  verifyCodeSchema,
  async ({ phone, code }) => {
    const tokens = await authService.loginWithCode(phone, code);
    const user = await authQueries.getUserByPhone(phone);
    const response = NextResponse.json({ success: true, user });
    setTokenCookies(response, tokens);
    return response;
  },
);

/** POST /api/auth/login */
export const loginHandler = withValidation(
  loginSchema,
  async ({ phone, password }) => {
    const tokens = await authService.loginWithPassword(phone, password);
    const user = await authQueries.getUserByPhone(phone);
    const response = NextResponse.json({ success: true, user });
    setTokenCookies(response, tokens);
    return response;
  },
);

/** POST /api/auth/register */
export const registerHandler = withValidation(
  registerSchema,
  async ({ phone, password, code }) => {
    const tokens = await authService.registerWithPassword(phone, password, code);
    const user = await authQueries.getUserByPhone(phone);
    const response = NextResponse.json({ success: true, user });
    setTokenCookies(response, tokens);
    return response;
  },
);

/** POST /api/auth/set-password */
export const setPassword = withValidation(
  setPasswordSchema,
  async ({ password }, req) => {
    const user = await requireAuthFromRequest(req);
    await authService.setPassword(user.userId, password);
    return NextResponse.json({ success: true });
  },
);

/** GET /api/auth/me — 返回当前登录用户安全信息（供前端导航/登录态） */
export const meHandler = async (req: Request) => {
  try {
    const auth = await requireAuthFromRequest(req);
    const user = await authQueries.getUserById(auth.userId);
    if (!user) throw new AppError(ERROR_CODES.UNAUTHORIZED, "用户不存在");
    return NextResponse.json({
      success: true,
      // 显式映射安全字段，绝不回传 phoneHash
      user: {
        id: user.id,
        nickname: user.nickname,
        role: user.role,
        ageVerified: user.ageVerified,
      },
    });
  } catch (error) {
    return apiError(error);
  }
};

/** POST /api/auth/refresh */
export const refreshHandler = async (req: Request) => {
  const token = extractRefreshToken(req);
  if (!token) {
    return NextResponse.json(
      { error: ERROR_CODES.TOKEN_EXPIRED.code },
      { status: ERROR_CODES.TOKEN_EXPIRED.status },
    );
  }
  try {
    const tokens = await authService.refreshAccessToken(token);
    const response = NextResponse.json({ success: true });
    setTokenCookies(response, tokens);
    return response;
  } catch (err) {
    console.error("[auth/refresh] 刷新失败:", err);
    const response = NextResponse.json(
      { error: ERROR_CODES.TOKEN_EXPIRED.code },
      { status: ERROR_CODES.TOKEN_EXPIRED.status },
    );
    clearTokenCookies(response);
    return response;
  }
};

/** POST /api/auth/logout */
export const logoutHandler = async (req: Request) => {
  const token = extractAccessToken(req);
  if (token) {
    const user = await authService.verifyAccessToken(token);
    if (user) await authService.logout(user.userId);
  }
  const response = NextResponse.json({ success: true });
  clearTokenCookies(response);
  return response;
};
