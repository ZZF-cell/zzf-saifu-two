// Next.js Edge Middleware — 全局路由守卫

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, checkRoutePermission } from "@/shared/auth/middleware";
import { verifyAgeVerified } from "@/shared/utils/age-verified";

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;

  // 公开路由 — 不拦截
  const publicPaths = ["/login", "/register", "/age-gate"];
  if (publicPaths.some((p) => path.startsWith(p))) {
    return NextResponse.next();
  }

  // 静态资源和 PWA 不拦截
  if (
    path.startsWith("/_next") ||
    path.startsWith("/icons") ||
    path === "/favicon.ico" ||
    path === "/manifest.json" ||
    path === "/sw.js"
  ) {
    return NextResponse.next();
  }

  // 年龄验证门禁：已登录（token 有效）放行 —— 登录用户年龄已验证，支付回跳后不再被误拦；
  // 未登录 → 验签 age_verified cookie（L4）：签名不符/伪造/过期一律视为未认证，拦到 age-gate
  //（含首页，满足「访问页面第一步」先认证）。修复前只看 cookie 存在性，客户端可伪造跳过。
  // ⚠️ 如实声明：登录态判断基于 access_token（15min 无状态 JWT），middleware 不查 refresh token。
  // 已登录用户闲置超过 15min 后 access token 过期，会被当未登录拦到 age-gate/login ——
  // 前端登录态检测到过期后走 /api/auth/refresh 静默续期再回跳，属预期的 ≤15min 窗口行为。
  const authUser = await getAuthUser(req);
  if (!authUser) {
    const ageVerified = req.cookies.get("age_verified")?.value;
    const verified = ageVerified ? await verifyAgeVerified(ageVerified) : false;
    if (!verified) {
      return NextResponse.redirect(new URL("/age-gate?redirect=" + encodeURIComponent(path), req.url));
    }
  }

  // 路由权限校验
  const redirect = checkRoutePermission(req, authUser);
  if (redirect) return redirect;

  return NextResponse.next();
}

export const config = {
  matcher: [
    // 排除 Next.js 内部资源、静态文件、API 路由（API 层自行校验 JWT）
    "/((?!_next/static|_next/image|api/|icons/|favicon\\.ico|manifest\\.json|sw\\.js).*)",
  ],
};
