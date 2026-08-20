// 通用原子限流桶 — RateLimitBucket 表 + Prisma upsert（单语句原子计数闸门）
// 替代 check-then-act 竞态：旧模式「先查再写」在并发下各自读到旧值 → 全部放行绕过限额；
// upsert 编译为 INSERT..ON CONFLICT DO UPDATE，同桶并发由 DB 串行化，计数只递增一次。
// 用法：hitRateLimit 返回窗口内计数（含本次请求），调用方据 allowed=false 抛 429。
//
// 唯一键 (scope, bucketKey, bucketStart) 保证：
//   - 同一窗口（bucketStart 相同）内的请求共享一个计数桶
//   - 窗口滑动到下一段（bucketStart 变化）自动开启新桶，旧桶残留由定期清理兜底

import { prisma } from "@/shared/db/client";
import { sha256 } from "./crypto";

export interface RateLimitWindow {
  /** 窗口长度（ms），如 60_000 = 1 分钟；bucketStart = floor(now/windowMs)*windowMs */
  windowMs: number;
  /** 窗口内允许的最大次数（含本次请求），count > max 即拒绝 */
  max: number;
}

export interface RateLimitResult {
  /** 窗口内累计计数（含本次请求） */
  count: number;
  /** 本次是否放行（count <= max） */
  allowed: boolean;
  /** 距当前桶结束的毫秒数（调用方换算提示文案） */
  retryAfterMs: number;
}

/**
 * 原子递增限流桶计数并返回窗口状态。
 * @param scope   限流维度（sms:phone / sms:ip / upload:daily …），不同维度隔离计数
 * @param bucketKey 维度内实体键（哈希后的手机号 / IP / 用户 id）
 */
export async function hitRateLimit(
  scope: string,
  bucketKey: string,
  { windowMs, max }: RateLimitWindow,
): Promise<RateLimitResult> {
  const now = Date.now();
  const bucketStart = new Date(Math.floor(now / windowMs) * windowMs);
  const record = await prisma.rateLimitBucket.upsert({
    where: {
      scope_bucketKey_bucketStart: { scope, bucketKey, bucketStart },
    },
    // ON CONFLICT 分支：同桶已存在 → 计数 +1（DB 原子，无丢失）
    update: { count: { increment: 1 } },
    // INSERT 分支：桶首次请求 → 计数 1
    create: { scope, bucketKey, bucketStart, count: 1 },
    select: { count: true },
  });
  return {
    count: record.count,
    allowed: record.count <= max,
    retryAfterMs: bucketStart.getTime() + windowMs - now,
  };
}

/** 维度键哈希（SHA-256）：避免原始 IP / 明文键进限流表（与 phoneHash 同源） */
export const hashKey = (value: string): string => sha256(value);

/**
 * 从请求头提取客户端 IP。
 * 安全：X-Forwarded-For 首段可被客户端伪造（Vercel 会把真实来源 IP 追加到链尾），
 * 取首段 = 攻击者轮换该头即可绕过 IP 维度限流（短信轰炸）。因此：
 * - 优先 x-vercel-forwarded-for（Vercel 边缘设置的真实来源 IP，客户端不可伪造）
 * - 非 Vercel（本地 dev/自建）：x-forwarded-for 代理链取链尾（最接近真实来源）
 * - 退回 x-real-ip / unknown（unknown 同样参与限流，防伪造头绕过）
 */
export function clientIp(req: Request): string {
  const vercelFf = req.headers.get("x-vercel-forwarded-for");
  if (vercelFf) return vercelFf.split(",")[0].trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
