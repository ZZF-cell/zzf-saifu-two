// age-verified 签名工具单元测试（L4）
// 纯函数 seam：signAgeVerified / verifyAgeVerified（Web Crypto HMAC，Node 24 全局可用）
// 核心契约：cookie 值只能由服务端签发；伪造/篡改/过期/JWT_SECRET 缺失 → 一律拒绝（fail-closed）

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { signAgeVerified, verifyAgeVerified } from "@/shared/utils/age-verified";

beforeEach(() => {
  process.env.JWT_SECRET = "test-secret";
  vi.useRealTimers();
});
afterEach(() => {
  delete process.env.JWT_SECRET;
});

describe("age_verified 服务端签名 — L4", () => {
  it("签发 → 验签通过（roundtrip）", async () => {
    const value = await signAgeVerified();
    expect(value).not.toBeNull();
    expect(value).toMatch(/^\d+\.[0-9a-f]+$/);
    expect(await verifyAgeVerified(value!)).toBe(true);
  });

  it("客户端伪造值（裸 1 / 无签名）→ 拒绝", async () => {
    expect(await verifyAgeVerified("1")).toBe(false);
    expect(await verifyAgeVerified("abc.def")).toBe(false);
  });

  it("篡改载荷保留旧签名 → 拒绝", async () => {
    const value = (await signAgeVerified())!;
    const [payload, sig] = value.split(".");

    // 载荷被改（时间戳 +1000）→ 签名不匹配
    expect(await verifyAgeVerified(`${Number(payload) + 1000}.${sig}`)).toBe(false);
    // 签名被改（尾部 +1）→ 不匹配
    expect(await verifyAgeVerified(`${payload}.${sig}x`)).toBe(false);
  });

  it("JWT_SECRET 缺失 → 签发 null、验签 false（fail-closed）", async () => {
    delete process.env.JWT_SECRET;
    expect(await signAgeVerified()).toBeNull();
    expect(await verifyAgeVerified("1700000000000.abcdef0123456789")).toBe(false);
  });

  it("签发时刻超过 1 年 → 过期拒绝（重放旧 cookie 不放行）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const value = (await signAgeVerified())!;
    vi.setSystemTime(new Date("2027-01-02T00:00:00Z")); // 1 年 + 1 天
    expect(await verifyAgeVerified(value)).toBe(false);
    vi.useRealTimers();
  });

  it("未来时间戳 → 拒绝（时钟异常/攻击）", async () => {
    const value = (await signAgeVerified())!;
    const [payload, sig] = value.split(".");
    const farFuture = String(Number(payload) + 3600_000); // +1 小时
    expect(await verifyAgeVerified(`${farFuture}.${sig}`)).toBe(false);
  });

  it("格式非法的输入 → 拒绝且不抛错", async () => {
    expect(await verifyAgeVerified("")).toBe(false);
    expect(await verifyAgeVerified(".")).toBe(false);
    expect(await verifyAgeVerified("abc")).toBe(false);
    expect(await verifyAgeVerified("1234567890.")).toBe(false);
    expect(await verifyAgeVerified("1234567890.zzzz")).toBe(false);
  });
});
