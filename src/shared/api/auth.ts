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
  const token =
    req.headers.get("cookie")?.match(/access_token=([^;]+)/)?.[1] ?? null;
  if (!token) throw new AppError(ERROR_CODES.UNAUTHORIZED, "请先登录");
  const user = await authService.verifyAccessToken(token);
  if (!user) throw new AppError(ERROR_CODES.TOKEN_EXPIRED, "登录已过期");
  return user.userId;
}
