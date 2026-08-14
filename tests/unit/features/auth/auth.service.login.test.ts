// loginWithPassword 单元测试 — 爆破防护（5 次失败锁定 15 分钟）+ scrypt 校验 + 成功重置/升级
// mock 系统边界：prisma（user.findUnique / user.update / refreshToken.create）
// 只测公共 seam：loginWithPassword（issueTokens 内部 jose 真实签名，refreshToken 落库 mock）

import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "crypto";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    refreshToken: { create: vi.fn() },
  },
}));

import { prisma } from "@/shared/db/client";
import { loginWithPassword } from "@/features/auth/auth.service";
import { ERROR_CODES } from "@/shared/errors/errors";
import { hashPassword } from "@/shared/utils/crypto";

const PHONE = "13800138000";

async function makeScryptHash(password: string): Promise<string> {
  return hashPassword(password);
}

/** 构造登录返回的用户记录 */
function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    phoneHash: "hash",
    passwordHash: "",
    role: "USER",
    failedLoginAttempts: 0,
    lockUntil: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PEPPER = "test-pepper";
});

describe("loginWithPassword — 密码登录与爆破防护", () => {
  it("正确密码 → 签发双 Token；无失败历史时不触发任何写", async () => {
    const passwordHash = await makeScryptHash("real-pass-123");
    const user = makeUser({ passwordHash });
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);
    vi.mocked(prisma.refreshToken.create).mockResolvedValue({ id: "rt" } as never);

    const tokens = await loginWithPassword(PHONE, "real-pass-123");

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    // 无失败计数/无锁/已是 scrypt → 不执行 reset update
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("错误密码 → 失败计数 +1，抛 INVALID_CREDENTIALS", async () => {
    const passwordHash = await makeScryptHash("real-pass-123");
    const user = makeUser({ passwordHash });
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);

    await expect(loginWithPassword(PHONE, "wrong-pass")).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_CREDENTIALS.code,
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { failedLoginAttempts: 1, lockUntil: null },
    });
  });

  it("第 5 次失败 → 设置 lockUntil（锁定 15 分钟）", async () => {
    const passwordHash = await makeScryptHash("real-pass-123");
    const user = makeUser({ passwordHash, failedLoginAttempts: 4 });
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);

    await expect(loginWithPassword(PHONE, "wrong-pass")).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_CREDENTIALS.code,
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        failedLoginAttempts: 5,
        lockUntil: expect.any(Date) as unknown as Date,
      },
    });
  });

  it("锁定期间（lockUntil 未过期）→ 拒绝校验，不执行任何写", async () => {
    const user = makeUser({
      passwordHash: await makeScryptHash("real-pass-123"),
      lockUntil: new Date(Date.now() + 10 * 60 * 1000), // 10 分钟后才解锁
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);

    await expect(loginWithPassword(PHONE, "real-pass-123")).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_CREDENTIALS.code,
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("锁定过期后正确密码 → 重置计数与锁，正常登录", async () => {
    const passwordHash = await makeScryptHash("real-pass-123");
    const user = makeUser({
      passwordHash,
      failedLoginAttempts: 5,
      lockUntil: new Date(Date.now() - 1000), // 已过期
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);
    vi.mocked(prisma.refreshToken.create).mockResolvedValue({ id: "rt" } as never);

    const tokens = await loginWithPassword(PHONE, "real-pass-123");

    expect(tokens.accessToken).toBeTruthy();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { failedLoginAttempts: 0, lockUntil: null },
    });
  });

  it("旧 SHA-256 密码登录成功 → 顺带升级为 scrypt 哈希", async () => {
    const salt = "a".repeat(32);
    const legacyHash = crypto
      .createHash("sha256")
      .update(salt + "old-pass")
      .digest("hex");
    const user = makeUser({ passwordHash: `${salt}.${legacyHash}` });
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);
    vi.mocked(prisma.refreshToken.create).mockResolvedValue({ id: "rt" } as never);

    const tokens = await loginWithPassword(PHONE, "old-pass");

    expect(tokens.accessToken).toBeTruthy();
    const updateCall = vi.mocked(prisma.user.update).mock.calls[0][0] as {
      data: { failedLoginAttempts: number; lockUntil: null; passwordHash?: string };
    };
    expect(updateCall.data.failedLoginAttempts).toBe(0);
    expect(updateCall.data.lockUntil).toBeNull();
    expect(updateCall.data.passwordHash).toMatch(/^scrypt\./);
  });

  it("被管理员禁用（status=DISABLED）→ 403 USER_DISABLED，即使密码正确", async () => {
    const passwordHash = await makeScryptHash("real-pass-123");
    const user = makeUser({ passwordHash, status: "DISABLED" });
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);

    await expect(loginWithPassword(PHONE, "real-pass-123")).rejects.toMatchObject({
      code: ERROR_CODES.USER_DISABLED.code,
      statusCode: 403,
    });
    // 禁用门禁先于锁定/失败计数检查：不触发任何写、不签发 Token
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });
});
