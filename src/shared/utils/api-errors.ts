// 客户端解析 API 错误响应体的纯函数（与服务端 shared/utils/api.ts 的 flattenZodError 呼应）
// 422 响应形如 { error, message, details: Record<string, string[]> }（flattenZodError 的字段级错误）
// 上传表单（品牌 Logo / 商品图片）都要从 details 提取第一条具体原因展示，抽出来避免两处逐字重复

/** 从 details 取第一条字段级具体原因（如「仅支持 JPG/PNG/WebP 图片」），无则返回 null */
export function firstFieldError(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  for (const value of Object.values(details as Record<string, unknown>)) {
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return null;
}
