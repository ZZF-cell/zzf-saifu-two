// POST /api/user/age-verify — 年龄验证确认（服务端签发签名 cookie）
// L4：age_verified 只能由服务端签发（HMAC 签名），客户端伪造的 age_verified=1 会被
// 中间件验签拒绝。匿名用户同样需要通行证（年龄门禁是平台级合规），故不再强制登录：
// 已登录用户额外同步 DB ageVerified（best-effort），token 失效不阻断签发。
import { NextResponse } from "next/server";
import { ERROR_CODES, AppError } from "@/shared/errors/errors";
import { apiError, isAllowedOrigin } from "@/shared/utils/api";
import { authService } from "@/features/auth";
import { signAgeVerified } from "@/shared/utils/age-verified";

const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export async function POST(req: Request) {
  try {
    // E3 CSRF Origin 校验：年龄门禁为未登录接口（无 cookie 天然护栏），必须显式校验 Origin 防跨站伪造通行证
    if (!isAllowedOrigin(req)) {
      throw new AppError(ERROR_CODES.CSRF_INVALID, "跨站请求被拒绝");
    }
    // 已登录用户同步 DB ageVerified（best-effort；token 过期/无效静默忽略，
    // 不因同步失败阻断匿名用户的年龄认证——门禁通行证与登录状态解耦）
    const cookie = req.headers.get("cookie") || "";
    const token = cookie.match(/access_token=([^;]+)/)?.[1];
    if (token) {
      try {
        const user = await authService.verifyAccessToken(token);
        if (user) await authService.setAgeVerified(user.userId);
      } catch {
        // 忽略 token 校验失败，继续签发
      }
    }

    // 服务端签发签名 cookie（客户端无法伪造），随响应 Set-Cookie 写入
    const value = await signAgeVerified();
    if (!value) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, "服务器未配置签名密钥");
    }
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    const res = NextResponse.json({ success: true });
    res.headers.set(
      "Set-Cookie",
      `age_verified=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`,
    );
    return res;
  } catch (error) {
    return apiError(error);
  }
}
