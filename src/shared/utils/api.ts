// API 工具 — withValidation HOF + apiError 错误包装器

import { NextResponse } from "next/server";
import { ZodSchema, ZodError } from "zod";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";

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
export function withValidation<T>(
  schema: ZodSchema<T>,
  handler: (data: T, req: Request) => Promise<NextResponse>,
): (req: Request) => Promise<NextResponse> {
  return async (req: Request) => {
    try {
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

  // 未知异常 → Sentry 捕获（如果配置了）
  console.error("[API Error]", error);
  // captureException(error); // Sentry 集成后取消注释

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
  const page = Math.max(
    1,
    parseInt(url.searchParams.get("page") || "1") || 1,
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
