// Edge Middleware — 路由保护 + JWT 校验
// 在 Next.js middleware.ts 中调用
// 注意：此模块可能运行在 Edge Runtime，process.env 私有变量不可在模块顶层访问

import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

export interface AuthUser {
  userId: string;
  role: "USER" | "BRAND" | "ADMIN";
}

// JWT 公钥对端（注意：JWT 仅 base64 编码，载荷对任何人可见。phoneHash 已从载荷中移除。）

function getJwtSecret(): Uint8Array | null {
  const secret = process.env.JWT_SECRET;
  // 生产环境缺失 JWT_SECRET → 返回 null（视作未登录，绝不用默认密钥放行伪造 Token）
  if (!secret && process.env.NODE_ENV === "production") return null;
  return new TextEncoder().encode(secret || "dev-secret-change-in-production");
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

  const secret = getJwtSecret();
  if (!secret) return null; // 生产环境密钥缺失，视作未登录

  try {
    const { payload } = await jwtVerify(token, secret);
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

  // 品牌方后台（仅 BRAND：品牌中心是品牌方自己的后台，ADMIN 走 /admin）
  if (path.startsWith("/brand")) {
    if (!authUser || authUser.role !== "BRAND") {
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
