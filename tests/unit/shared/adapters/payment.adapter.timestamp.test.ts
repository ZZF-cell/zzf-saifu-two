// getBeijingTimestamp 单元测试 — 支付宝 timestamp 时区陷阱
// 背景：alipay-sdk 用 moment() 生成本地时区时间戳，服务器（Vercel）是 UTC，
// 偏差 8h 会导致网关判验签失败。此函数强制生成北京时间，不依赖服务器时区。
//
// 只测纯函数 getBeijingTimestamp：固定输入 Date → 期望的北京时间字符串

import { describe, it, expect } from "vitest";
import { getBeijingTimestamp } from "@/shared/adapters/payment.adapter";

describe("getBeijingTimestamp — 北京时间格式化（支付宝 timestamp）", () => {
  it("UTC 时刻 → 北京时间（UTC+8），格式 YYYY-MM-DD HH:mm:ss", () => {
    // 2026-08-10 01:37:04 UTC = 2026-08-10 09:37:04 北京
    const utc = new Date("2026-08-10T01:37:04.000Z");
    expect(getBeijingTimestamp(utc)).toBe("2026-08-10 09:37:04");
  });

  it("跨日边界：UTC 前一天的 20:00 → 北京次日 04:00", () => {
    const utc = new Date("2026-08-09T20:00:00.000Z");
    expect(getBeijingTimestamp(utc)).toBe("2026-08-10 04:00:00");
  });

  it("跨年边界：UTC 12-31 16:00 → 北京次年 01-01 00:00", () => {
    const utc = new Date("2026-12-31T16:00:00.000Z");
    expect(getBeijingTimestamp(utc)).toBe("2027-01-01 00:00:00");
  });

  it("秒位补零：北京 09:05:07 → 保持两位", () => {
    const utc = new Date("2026-08-10T01:05:07.000Z");
    expect(getBeijingTimestamp(utc)).toBe("2026-08-10 09:05:07");
  });

  it("默认参数（无参调用）返回当前北京时间的合法格式", () => {
    const s = getBeijingTimestamp();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // 与「现在 UTC 时刻 + 8h」的分钟级一致性（避免写死当前时间导致脆测）
    const expected = new Date(Date.now() + 8 * 3600 * 1000);
    const expStr = `${expected.getUTCFullYear()}-${String(
      expected.getUTCMonth() + 1,
    ).padStart(2, "0")}-${String(expected.getUTCDate()).padStart(2, "0")} ${String(
      expected.getUTCHours(),
    ).padStart(2, "0")}:${String(expected.getUTCMinutes()).padStart(2, "0")}`;
    expect(s.startsWith(expStr)).toBe(true);
  });
});
