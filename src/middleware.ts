// Next.js Edge Middleware — 全局路由守卫

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, checkRoutePermission } from "@/shared/auth/middleware";

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

  // 年龄验证门禁
  const ageVerified = req.cookies.get("age_verified")?.value;
  if (!ageVerified && path !== "/") {
    return NextResponse.redirect(new URL("/age-gate?redirect=" + encodeURIComponent(path), req.url));
  }

  // 路由权限校验
  const authUser = await getAuthUser(req);
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
