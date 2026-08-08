// Edge Middleware — 路由保护 + JWT 校验
// 在 Next.js middleware.ts 中调用

import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "dev-secret-change-me",
);

export interface AuthUser {
  userId: string;
  role: "USER" | "BRAND" | "ADMIN";
  phoneHash: string;
}

/**
 * 从 Cookie 中验证 Access Token，返回当前用户
 * 未登录返回 null
 */
export async function getAuthUser(
  req: NextRequest,
): Promise<AuthUser | null> {
  const token = req.cookies.get("access_token")?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as unknown as AuthUser;
  } catch {
    return null;
  }
}

/**
 * 要求特定角色
 * @param roles 允许的角色列表，空数组表示仅要求登录
 */
export function requireRole(authUser: AuthUser | null, roles: string[] = []): boolean {
  if (!authUser) return false;
  if (roles.length === 0) return true;
  return roles.includes(authUser.role);
}

/**
 * 路由保护配置
 * 在 middleware.ts 中调用:
 *   const result = checkRoutePermission(req, authUser);
 *   if (result) return result;
 */
export function checkRoutePermission(
  req: NextRequest,
  authUser: AuthUser | null,
): NextResponse | null {
  const path = req.nextUrl.pathname;

  // 管理后台
  if (path.startsWith("/admin")) {
    if (!authUser || authUser.role !== "ADMIN") {
      return NextResponse.redirect(new URL("/login", req.url));
    }
  }

  // 品牌方后台
  if (path.startsWith("/brand")) {
    if (!authUser || !["BRAND", "ADMIN"].includes(authUser.role)) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
  }

  // 需要登录的页面
  const protectedPaths = ["/cart", "/checkout", "/orders", "/account"];
  if (protectedPaths.some((p) => path.startsWith(p))) {
    if (!authUser) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
  }

  return null; // 放行
}
