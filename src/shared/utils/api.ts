// API 工具 — withValidation HOF + apiError 错误包装器

import { NextResponse } from "next/server";
import { ZodSchema, ZodError } from "zod";
import { captureException } from "@sentry/nextjs";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";

// E4：Sentry 集成后异常走上报。未配置 DSN 时 SDK 不初始化（见 sentry.*.config），
// 这里的模块级开关避免未初始化 SDK 在每次 500 时刷一遍 "Sentry Logger" 警告。
const sentryConfigured = Boolean(
  process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN,
);

/**
 * 校验中间件 — 包装 API Route Handler
 * 请求体自动 JSON.parse → Zod 校验 → 注入类型安全的 data
 * 校验失败返回 422
 *
 * @example
 * export const POST = withValidation(createOrderSchema, async (data, req) => {
 *   const order = await createOrder(data);
 *   return NextResponse.json(order, { status: 201 });
 * });
 */
/**
 * E3 CSRF Origin 校验：请求带 Origin 头时必须属于本站，无 Origin 放行。
 *
 * 原理：浏览器跨站表单提交/CSRF 攻击必然带 Origin 且指向攻击站点；同源请求（fetch 同域）、
 * curl、服务端到服务端调用（如支付宝回调）通常不带 Origin —— 只对「存在的 Origin」做比对，
 * 避免误伤无浏览器上下文的合法调用。
 *
 * 允许集合：NEXT_PUBLIC_BASE_URL 的 origin + 非生产环境 localhost:3000（本地联调）。
 */
export function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;

  const allowed = new Set<string>();
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  if (baseUrl) {
    try {
      allowed.add(new URL(baseUrl).origin);
    } catch {
      // 非法配置忽略（后续 URL 校验会另行告警）
    }
  }
  if (process.env.NODE_ENV !== "production") {
    allowed.add("http://localhost:3000");
  }
  return allowed.has(origin);
}

export function withValidation<T>(
  schema: ZodSchema<T>,
  handler: (data: T, req: Request) => Promise<NextResponse>,
): (req: Request) => Promise<NextResponse> {
  return async (req: Request) => {
    try {
      // E3：所有经 withValidation 的 POST 统一套 CSRF Origin 校验（无 Origin 放行）。
      // 放行条件已考虑支付宝回调等服务端调用（无 Origin）；浏览器跨站请求在此拒绝。
      if (!isAllowedOrigin(req)) {
        throw new AppError(ERROR_CODES.CSRF_INVALID, "跨站请求被拒绝");
      }
      const body = await req.json().catch(() => null);
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          {
            error: ERROR_CODES.VALIDATION_ERROR.code,
            message: "请求参数不符合预期",
            details: flattenZodError(parsed.error),
          },
          { status: 422 },
        );
      }
      return await handler(parsed.data, req);
    } catch (error) {
      return apiError(error);
    }
  };
}

/**
 * 全局错误处理 — 将 AppError / ZodError / 未知异常
 * 统一转化为标准 JSON 错误响应
 */
export function apiError(error: unknown): NextResponse {
  if (error instanceof AppError) {
    return NextResponse.json(
      { error: error.code, message: error.message },
      { status: error.statusCode },
    );
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: ERROR_CODES.VALIDATION_ERROR.code,
        message: "请求参数不符合预期",
        details: flattenZodError(error),
      },
      { status: 422 },
    );
  }

  // 未知异常 → Sentry 捕获（E4：配置 DSN 后自动上报，否则忽略）
  console.error("[API Error]", error);
  if (sentryConfigured) {
    captureException(error);
  }

  return NextResponse.json(
    { error: ERROR_CODES.INTERNAL_ERROR.code, message: "服务器内部错误" },
    { status: 500 },
  );
}

/**
 * 分页参数解析 — 统一处理 page/pageSize
 *
 * 关键防御：负数（如 ?page=-1）与 NaN 一律 clamp 到合法区间，
 * 否则 Prisma 的 skip/take 收到负值会抛校验错误 → 500。
 */
export function parsePagination(
  url: URL,
  defaultSize = 20,
): { page: number; pageSize: number } {
  // L7：page 也必须封顶——`?page=10^9` 会让 Prisma 生成巨大 OFFSET 拖垮 DB。
  // 此前只封顶 pageSize（<=100），page 无上界。
  const MAX_PAGE = 10000;
  const page = Math.min(
    MAX_PAGE,
    Math.max(1, parseInt(url.searchParams.get("page") || "1") || 1),
  );
  const pageSize = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("pageSize") || String(defaultSize)) || defaultSize),
  );
  return { page, pageSize };
}

/** 扁平化 Zod 错误，方便前端展示 */
function flattenZodError(error: ZodError): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (!result[key]) result[key] = [];
    result[key].push(issue.message);
  }
  return result;
}
