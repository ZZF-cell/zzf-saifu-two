// orders.constants 纯函数测试 — 支付截止时间 / 倒计时计算（零依赖，无需 mock prisma）
// 前端倒计时唯一真相源：expiresAt = createdAt + ORDER_PAYMENT_TIMEOUT_MS，
// 断言用独立已知值（不重算），防「展示倒计时」与「实际取消时机」漂移。

import { describe, it, expect } from "vitest";
import {
  ORDER_PAYMENT_TIMEOUT_MS,
  getExpiresAt,
  getRemainingMs,
  formatCountdown,
} from "@/features/orders/orders.constants";

describe("ORDER_PAYMENT_TIMEOUT_MS — 支付超时时间", () => {
  it("= 30 分钟（与 Inngest sweep / check-paid 惰性取消同口径）", () => {
    expect(ORDER_PAYMENT_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });
});

describe("getExpiresAt — 支付截止时间", () => {
  it("= createdAt + ORDER_PAYMENT_TIMEOUT_MS 的 ISO 字符串（UTC 序列化，无时区偏移）", () => {
    const createdAt = new Date("2026-08-01T10:00:00.000Z");
    expect(getExpiresAt(createdAt)).toBe("2026-08-01T10:30:00.000Z");
  });
});

describe("getRemainingMs — 剩余毫秒（绝对时间差）", () => {
  it("截止时间在未来 → 返回正剩余", () => {
    // now 由调用方注入（倒计时组件每秒 tick 的时钟），纯函数直测无需 mock Date.now
    expect(getRemainingMs(new Date(60_000).toISOString(), 0)).toBe(60_000);
  });

  it("截止时间已过 → 钳为 0（不返回负数）", () => {
    expect(getRemainingMs(new Date(-10_000).toISOString(), 0)).toBe(0);
  });
});

describe("formatCountdown — 倒计时展示格式", () => {
  it("59s → 「支付剩余 00:59」且 urgent（最后 60 秒警示）", () => {
    expect(formatCountdown(59_000)).toEqual({ text: "支付剩余 00:59", urgent: true });
  });

  it("60s → 「支付剩余 01:00」且 urgent（含最后整分钟）", () => {
    expect(formatCountdown(60_000)).toEqual({ text: "支付剩余 01:00", urgent: true });
  });

  it("100s → 「支付剩余 01:40」非 urgent", () => {
    expect(formatCountdown(100_000)).toEqual({ text: "支付剩余 01:40", urgent: false });
  });

  it("29min → 「支付剩余 29:00」非 urgent", () => {
    expect(formatCountdown(29 * 60_000)).toEqual({ text: "支付剩余 29:00", urgent: false });
  });
});
