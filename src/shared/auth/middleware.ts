// Edge Middleware — 路由保护 + JWT 校验
// 在 Next.js middleware.ts 中调用
// 注意：此模块可能运行在 Edge Runtime，process.env 私有变量不可在模块顶层访问

import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

export type UserRole =
  | "USER"
  | "BRAND"
  | "CUSTOMER_SERVICE"
  | "QUALITY_INSPECTOR"
  | "ADMIN"
  | "SUPER";

export interface AuthUser {
  userId: string;
  role: UserRole;
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
/**
 * 构造带 ?redirect= 的登录跳转（保留目标页 pathname+query，登录后回跳，
 * 防「未登录访问 /checkout?items=… 登录后丢失部分结算上下文」；login 页侧有防 Open Redirect）
 */
function loginRedirect(req: NextRequest): NextResponse {
  const url = new URL("/login", req.url);
  url.searchParams.set("redirect", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

/**
 * M10：已登录但角色不符 → 403 而非跳登录。
 * 修复前一律 loginRedirect：已登录的 BRAND 访问 /admin → 被送去 /login?redirect=/admin，
 * login 页对已登录用户自动回跳 → 又回到 /admin → 无限重定向循环。
 * 403 直接终止循环，且语义正确（已认证 ≠ 有权限）。
 */
function forbidden(): NextResponse {
  return NextResponse.json(
    { error: "FORBIDDEN", message: "您没有访问该页面的权限" },
    { status: 403 },
  );
}

/** 路由守卫决策（纯函数，可单测）：路径 + 角色 → 放行 / 去登录 / 403 */
export type RouteGuardDecision = "allow" | "login" | "forbidden";

export function getRouteGuardDecision(
  path: string,
  authUser: AuthUser | null,
): RouteGuardDecision {
  // 管理后台（管理员 + 最高权限者）
  if (path.startsWith("/admin")) {
    if (!authUser) return "login";
    if (!["ADMIN", "SUPER"].includes(authUser.role)) return "forbidden"; // M10
  }

  // 客服中心（客服 + 最高权限者；与 /admin 隔离）
  if (path.startsWith("/service")) {
    if (!authUser) return "login";
    if (!["CUSTOMER_SERVICE", "SUPER"].includes(authUser.role)) return "forbidden"; // M10
  }

  // 质检中心（质检员 + 最高权限者；商品审核与质检模板在此，与 /admin 职责隔离）
  if (path.startsWith("/inspect")) {
    if (!authUser) return "login";
    if (!["QUALITY_INSPECTOR", "SUPER"].includes(authUser.role)) return "forbidden"; // M10
  }

  // 商家管理（管理员 + 最高权限者：查看所有入驻品牌；与 /admin 品牌审核同角色组）
  // 注意：必须放在 /brand 之前——/brand 用 startsWith 会误伤 /brands（M 品牌方后台仅 BRAND）
  if (path === "/brands" || path.startsWith("/brands/")) {
    if (!authUser) return "login";
    if (!["ADMIN", "SUPER"].includes(authUser.role)) return "forbidden"; // M10
  }

  // 品牌方后台（仅 BRAND：品牌中心是品牌方自己的后台，ADMIN 走 /admin；
  // 精确前缀避免 /brands 商家管理被当作 /brand 子路径）
  if (path === "/brand" || path.startsWith("/brand/")) {
    if (!authUser) return "login";
    if (authUser.role !== "BRAND") return "forbidden"; // M10
  }

  // 需要登录的页面
  const protectedPaths = ["/cart", "/checkout", "/orders", "/account"];
  if (protectedPaths.some((p) => path.startsWith(p))) {
    if (!authUser) return "login";
  }

  return "allow";
}

export function checkRoutePermission(
  req: NextRequest,
  authUser: AuthUser | null,
): NextResponse | null {
  const decision = getRouteGuardDecision(req.nextUrl.pathname, authUser);
  if (decision === "login") return loginRedirect(req);
  if (decision === "forbidden") return forbidden();
  return null; // 放行
}
