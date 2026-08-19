// 共享 API 工具 — 认证中间件（各模块 API 层复用）
// 模块边界：shared 层只能通过 feature 的 Public API（index.ts）访问，不得直接引用内部文件
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import { authService } from "@/features/auth";

/**
 * 从请求 Cookie 中提取 Access Token 并验证用户身份
 * 未登录或 Token 过期抛出 AppError
 *
 * @returns userId
 */
export async function authenticate(req: Request): Promise<string> {
  const user = await authenticateUser(req);
  return user.userId;
}

export interface AuthUserContext {
  userId: string;
  role: "USER" | "BRAND" | "CUSTOMER_SERVICE" | "ADMIN" | "SUPER";
}

// 角色组常量：守卫参数集中定义，避免散落各处漏改
/** 管理后台（平台管理：用户/品牌/商品/邀请码/质检模板） */
export const ADMIN_ROLES = ["ADMIN", "SUPER"] as const;
/** 客服工作台（/service） */
export const SERVICE_ROLES = ["CUSTOMER_SERVICE", "SUPER"] as const;
/** 订单售后（看订单 + 发货/送达/完成/退款）：客服亦可操作 */
export const AFTERSALES_ROLES = ["ADMIN", "SUPER", "CUSTOMER_SERVICE"] as const;

/**
 * 从请求 Cookie 中提取 Access Token 并验证用户身份（返回完整上下文含角色）
 * 未登录或 Token 过期抛出 AppError
 */
export async function authenticateUser(req: Request): Promise<AuthUserContext> {
  const token =
    req.headers.get("cookie")?.match(/access_token=([^;]+)/)?.[1] ?? null;
  if (!token) throw new AppError(ERROR_CODES.UNAUTHORIZED, "请先登录");
  const user = await authService.verifyAccessToken(token);
  if (!user) throw new AppError(ERROR_CODES.TOKEN_EXPIRED, "登录已过期");

  // 禁用/角色变更须立即生效：Access Token 是无状态 JWT，载荷可能已过期。
  // 用 DB 实时值校准 role + status（一次主键查询），管理员禁用/降级后该用户的下一次
  // 请求即被拒绝，而非等到 token 15min 自然过期（回归护栏：禁用门禁下沉到写入口）。
  const current = await authService.getUserAuthContext(user.userId);
  if (!current) throw new AppError(ERROR_CODES.UNAUTHORIZED, "用户不存在");
  if (current.status === "DISABLED") {
    throw new AppError(ERROR_CODES.USER_DISABLED, "账号已被禁用，请联系管理员");
  }
  return { userId: current.id, role: current.role as AuthUserContext["role"] };
}

/**
 * 要求特定角色 — 角色不匹配抛出 FORBIDDEN
 * 管理后台/品牌后台等受控 API 复用
 */
export async function requireRole(
  req: Request,
  roles: readonly string[],
): Promise<AuthUserContext> {
  const user = await authenticateUser(req);
  if (!roles.includes(user.role)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "无权限执行此操作");
  }
  return user;
}
