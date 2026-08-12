// crypto 单元测试 — scrypt 密码哈希 + pepper 手机号哈希 + 旧 SHA-256 兼容
// 只测纯函数 hashPassword / verifyPassword / hashPhone（不 mock，真实 Node crypto）

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import { hashPassword, verifyPassword, hashPhone } from "@/shared/utils/crypto";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  process.env.PEPPER = "test-pepper";
});

afterEach(() => {
  delete process.env.PEPPER;
  vi.unstubAllEnvs();
});

describe("hashPassword / verifyPassword — scrypt 慢哈希", () => {
  it("生成 scrypt.<salt32hex>.<hash43base64url> 格式，可校验正确密码", async () => {
    const stored = await hashPassword("my-password-123");
    expect(stored).toMatch(/^scrypt\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword("my-password-123", stored)).toBe(true);
  });

  it("错误密码校验失败", async () => {
    const stored = await hashPassword("right-pass");
    expect(await verifyPassword("wrong-pass", stored)).toBe(false);
  });

  it("同一密码不同盐 → 哈希不同（防彩虹表）", async () => {
    const a = await hashPassword("pass");
    const b = await hashPassword("pass");
    expect(a).not.toBe(b);
  });

  it("兼容旧格式 salt.hash（SHA-256 时代历史密码）", async () => {
    const salt = crypto.randomBytes(16).toString("hex");
    const legacyHash = crypto
      .createHash("sha256")
      .update(salt + "123456")
      .digest("hex");
    const stored = `${salt}.${legacyHash}`;
    expect(await verifyPassword("123456", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("畸形哈希（无盐/缺分隔）→ false 而非抛异常", async () => {
    expect(await verifyPassword("x", "not-a-valid-format")).toBe(false);
    expect(await verifyPassword("x", "scrypt.onlysalt")).toBe(false);
  });
});

describe("hashPhone — pepper 加盐手机号哈希", () => {
  it("相同 pepper + 相同号码 → 哈希一致；不同 pepper → 不同", () => {
    process.env.PEPPER = "pepper-a";
    const h1 = hashPhone("13800138000");
    process.env.PEPPER = "pepper-b";
    expect(hashPhone("13800138000")).not.toBe(h1);
    process.env.PEPPER = "pepper-a";
    expect(hashPhone("13800138000")).toBe(h1);
  });

  it("生产环境 PEPPER 缺失 → fail-fast 抛错（禁用默认 pepper）", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.PEPPER;
    expect(() => hashPhone("13800138000")).toThrow(/PEPPER 未配置/);
  });
});
