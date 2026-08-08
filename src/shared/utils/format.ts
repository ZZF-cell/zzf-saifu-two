// 数据格式转换工具 — 处理 Prisma Json 类型的运行时校验

/**
 * 将 Prisma Json 字段安全转为 string[]
 * 替代裸 `as string[]` 断言
 */
export function toJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}
