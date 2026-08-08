// Next.js Edge Middleware — 全局路由守卫
// 运行在 Edge Runtime，不能 import Prisma

import { NextRequest, NextResponse } from "next/server";

export async function middleware(req: NextRequest) {
  // PWA Service Worker 和静态资源不拦截
  const path = req.nextUrl.pathname;

  // 管理后台：重定向到 auth 页面（中间件不做 JWT 校验，API 层做）
  if (path.startsWith("/admin")) {
    const accessToken = req.cookies.get("access_token")?.value;
    if (!accessToken) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // 排除公共资源
    "/((?!_next/static|_next/image|icons|favicon.ico|manifest.json|sw.js).*)",
  ],
};
