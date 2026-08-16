// crypto 单元测试 — scrypt 密码哈希 + pepper 手机号哈希 + 旧 SHA-256 兼容
// 只测纯函数 hashPassword / verifyPassword / hashPhone（不 mock，真实 Node crypto）

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import {
  hashPassword,
  verifyPassword,
  hashPhone,
  encrypt,
  decrypt,
} from "@/shared/utils/crypto";

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

  it("非生产环境 PEPPER 缺失 → 用默认 pepper 并 console.warn（仅限开发）", () => {
    delete process.env.PEPPER; // NODE_ENV=test（全局 beforeEach 已 stub，非 production）
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = hashPhone("13800138000");
    expect(h).toBe(
      crypto.createHash("sha256").update("default-pepper13800138000").digest("hex"),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("旧格式 expected 字节长度不符 → false（长度比较兜底，非密码匹配）", async () => {
    // "salt.1234"：expected="1234"（4 字节）≠ sha256 hex（64 字节）→ 长度比较直接拦截
    expect(await verifyPassword("x", "salt.1234")).toBe(false);
  });
});

// ── encrypt / decrypt（L12：加密工具 100%，此前只测了 hash 系，AES 完全未覆盖） ──

describe("encrypt / decrypt — AES-256-GCM", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64url");

  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEYS", `v1:${KEY}`);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("往返：Unicode / 空字符串 / 长文本", () => {
    for (const s of ["hello", "", "中文🔐😀", "x".repeat(5000)]) {
      expect(decrypt(encrypt(s))).toBe(s);
    }
  });

  it("密文带版本前缀 + iv + authTag（4 段，版本取最左）", () => {
    const ct = encrypt("secret");
    const parts = ct.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
  });

  it("未知版本 → 抛「找不到密钥版本」", () => {
    const ct = encrypt("x");
    const [, iv, tag, data] = ct.split(":");
    expect(() => decrypt(`v9:${iv}:${tag}:${data}`)).toThrow(/找不到密钥版本/);
  });

  it("畸形密文（段数不对）→ 抛「密文格式无效」", () => {
    expect(() => decrypt("v1:ivonly")).toThrow(/密文格式无效/);
  });

  it("篡改密文 → GCM 认证失败抛错", () => {
    const [ver, iv, tag, data] = encrypt("secret").split(":");
    const badData = data.slice(0, -1) + (data.endsWith("a") ? "b" : "a");
    expect(() => decrypt(`${ver}:${iv}:${tag}:${badData}`)).toThrow();
  });

  it("ENCRYPTION_KEYS 未配置 → encrypt 抛「格式无效」（getCurrentVersion），decrypt 抛「未配置」（getKeys）", () => {
    vi.stubEnv("ENCRYPTION_KEYS", "");
    // encrypt 走 getCurrentVersion：空串 split 后首段空，match 失败 → 格式无效
    expect(() => encrypt("x")).toThrow(/ENCRYPTION_KEYS 格式无效/);
    // decrypt 走 getKeys：!keysStr 先判空 → 未配置
    expect(() => decrypt("v1:aaa:bbb:ccc")).toThrow(/ENCRYPTION_KEYS 未配置/);
  });

  it("首条目无 vN: 前缀 → 抛「格式无效」", () => {
    vi.stubEnv("ENCRYPTION_KEYS", "garbage,whatever");
    expect(() => encrypt("x")).toThrow(/ENCRYPTION_KEYS 格式无效/);
  });

  it("getKeys 跳过无 vN: 前缀条目，仅保留合法版本", () => {
    vi.stubEnv("ENCRYPTION_KEYS", `v1:${KEY},stale`);
    const ct = encrypt("y");
    expect(decrypt(ct)).toBe("y");
  });

  it("getKeys 全部条目无效 → decrypt 抛「格式无效」（map.size===0 兜底）", () => {
    vi.stubEnv("ENCRYPTION_KEYS", "garbage,whatever");
    expect(() => decrypt("v1:aaa:bbb:ccc")).toThrow(/ENCRYPTION_KEYS 格式无效/);
  });

  it("多版本密钥：旧版本密文用对应版本解密", () => {
    const KEY2 = Buffer.alloc(32, 9).toString("base64url");
    vi.stubEnv("ENCRYPTION_KEYS", `v1:${KEY},v2:${KEY2}`);
    const ct = encrypt("z"); // 取最左 v1
    expect(ct.startsWith("v1:")).toBe(true);
    expect(decrypt(ct)).toBe("z");
  });
});
