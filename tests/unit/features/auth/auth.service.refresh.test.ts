// refreshAccessToken 单元测试 — Refresh Rotation + 禁用会话门禁
// mock 系统边界：prisma（refreshToken.findFirst/deleteMany/create + user.findUnique + $transaction）
// 只测公共 seam：refreshAccessToken（decode → 校验 → 轮换 → 签发新 Access + 新 Refresh）

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import crypto from "crypto";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    refreshToken: { findFirst: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "@/shared/db/client";
import { refreshAccessToken } from "@/features/auth/auth.service";
import { ERROR_CODES } from "@/shared/errors/errors";
import { sha256 } from "@/shared/utils/crypto";

/** 构造一个可被 decodeRefreshToken 解析的原始 refresh token（base64url(userId:random)） */
function makeRawToken(userId: string): string {
  return Buffer.from(`${userId}:${crypto.randomBytes(32).toString("hex")}`).toString("base64url");
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    phoneHash: "hash",
    passwordHash: null,
    role: "USER",
    status: "ACTIVE",
    failedLoginAttempts: 0,
    lockUntil: null,
    ...overrides,
  };
}

// ── 交互事务 mock ──

type Tx = {
  refreshToken: { deleteMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
};

let tx: Tx;
type TransactionImpl = (fn: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
const transactionMock = prisma.$transaction as unknown as Mock<TransactionImpl>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PEPPER = "test-pepper";
  tx = {
    refreshToken: { deleteMany: vi.fn(), create: vi.fn() },
    user: { findUnique: vi.fn() },
  };
  transactionMock.mockImplementation((fn: (tx: Tx) => Promise<unknown>) => fn(tx));
});

describe("refreshAccessToken — Refresh Rotation + 禁用门禁", () => {
  it("有效 token + ACTIVE 用户 → 原子轮换：删旧 token、落新 token、签发新双 token", async () => {
    const rawToken = makeRawToken("user-1");
    vi.mocked(prisma.refreshToken.findFirst).mockResolvedValue({
      id: "rt-1",
      tokenHash: sha256(rawToken),
      expiresAt: new Date(Date.now() + 3600_000),
    } as never);
    tx.refreshToken.deleteMany.mockResolvedValue({ count: 1 });
    tx.user.findUnique.mockResolvedValue(makeUser());
    tx.refreshToken.create.mockResolvedValue({ id: "rt-2" } as never);

    const tokens = await refreshAccessToken(rawToken);

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    // 旧 token 原子删除（含 userId 守卫，防并发重用）
    expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { id: "rt-1", userId: "user-1" },
    });
    // 新 refresh token 落库（hash 落库，原文不落）
    expect(tx.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          expiresAt: expect.any(Date) as unknown as Date,
        }),
      }),
    );
  });

  it("被禁用用户（status=DISABLED）→ 吊销全部会话 + 403 USER_DISABLED，绝不签发新 token", async () => {
    const rawToken = makeRawToken("user-1");
    vi.mocked(prisma.refreshToken.findFirst).mockResolvedValue({
      id: "rt-1",
      tokenHash: sha256(rawToken),
      expiresAt: new Date(Date.now() + 3600_000),
    } as never);
    tx.refreshToken.deleteMany.mockResolvedValue({ count: 1 });
    tx.user.findUnique.mockResolvedValue(makeUser({ status: "DISABLED" }));

    await expect(refreshAccessToken(rawToken)).rejects.toMatchObject({
      code: ERROR_CODES.USER_DISABLED.code,
      statusCode: 403,
    });

    // 吊销该用户全部 refresh token（其他设备会话一并失效）
    expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    // 不签发新 refresh token
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
  });

  it("refresh token 不存在/已过期 → TOKEN_EXPIRED", async () => {
    vi.mocked(prisma.refreshToken.findFirst).mockResolvedValue(null);

    await expect(refreshAccessToken(makeRawToken("user-1"))).rejects.toMatchObject({
      code: ERROR_CODES.TOKEN_EXPIRED.code,
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("并发重用同一 token（deleteMany 命中 0 行）→ TOKEN_EXPIRED", async () => {
    const rawToken = makeRawToken("user-1");
    vi.mocked(prisma.refreshToken.findFirst).mockResolvedValue({
      id: "rt-1",
      tokenHash: sha256(rawToken),
      expiresAt: new Date(Date.now() + 3600_000),
    } as never);
    tx.refreshToken.deleteMany.mockResolvedValue({ count: 0 });

    await expect(refreshAccessToken(rawToken)).rejects.toMatchObject({
      code: ERROR_CODES.TOKEN_EXPIRED.code,
    });
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
  });
});
