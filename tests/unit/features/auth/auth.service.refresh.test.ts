// refreshAccessToken 单元测试 — Refresh Rotation + 软吊销 + 禁用门禁 + 被盗重用检测
// mock 系统边界：prisma（refreshToken.findFirst/updateMany/create/deleteMany + user.findUnique + $transaction）
// 只测公共 seam：refreshAccessToken（decode → 校验 → 轮换 → 签发新 Access + 新 Refresh）

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import crypto from "crypto";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    refreshToken: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
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
  refreshToken: {
    updateMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  user: { findUnique: ReturnType<typeof vi.fn> };
};

let tx: Tx;
type TransactionImpl = (fn: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
const transactionMock = prisma.$transaction as unknown as Mock<TransactionImpl>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PEPPER = "test-pepper";
  tx = {
    refreshToken: {
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
    user: { findUnique: vi.fn() },
  };
  transactionMock.mockImplementation((fn: (tx: Tx) => Promise<unknown>) => fn(tx));
});

/** 让 findFirst 命中一个有效未吊销 token（首次调用返回） */
function mockValidToken(rawToken: string) {
  vi.mocked(prisma.refreshToken.findFirst).mockResolvedValue({
    id: "rt-1",
    tokenHash: sha256(rawToken),
    expiresAt: new Date(Date.now() + 3600_000),
  } as never);
}

describe("refreshAccessToken — Refresh Rotation + 禁用门禁", () => {
  it("有效 token + ACTIVE 用户 → 原子轮换：软吊销旧 token、落新 token、签发新双 token", async () => {
    const rawToken = makeRawToken("user-1");
    mockValidToken(rawToken);
    tx.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    tx.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
    tx.user.findUnique.mockResolvedValue(makeUser());
    tx.refreshToken.create.mockResolvedValue({ id: "rt-2" } as never);

    const tokens = await refreshAccessToken(rawToken);

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    // 旧 token 软吊销（原子守卫：仅未吊销记录可续期，并发同 token 只有一方命中）
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { id: "rt-1", userId: "user-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) as unknown as Date },
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
    mockValidToken(rawToken);
    tx.refreshToken.updateMany.mockResolvedValue({ count: 1 });
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
    // 首次 findFirst（有效未吊销）→ null；复用检测查询也查不到（全新 token）→ null
    vi.mocked(prisma.refreshToken.findFirst).mockResolvedValue(null);

    await expect(refreshAccessToken(makeRawToken("user-1"))).rejects.toMatchObject({
      code: ERROR_CODES.TOKEN_EXPIRED.code,
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("并发重用同一 token（软吊销命中 0 行）→ TOKEN_EXPIRED", async () => {
    const rawToken = makeRawToken("user-1");
    mockValidToken(rawToken);
    tx.refreshToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(refreshAccessToken(rawToken)).rejects.toMatchObject({
      code: ERROR_CODES.TOKEN_EXPIRED.code,
    });
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
  });

  it("已轮换的旧 token 被重放（命中已吊销记录）→ 只吊销该 token 行 + TOKEN_EXPIRED（失窃信号）", async () => {
    const rawToken = makeRawToken("user-1");
    // 第一次 findFirst（有效未吊销）→ null；第二次（prior 查询命中已吊销记录）
    vi.mocked(prisma.refreshToken.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "rt-old",
        tokenHash: sha256(rawToken),
        expiresAt: new Date(Date.now() + 3600_000),
        revokedAt: new Date(),
      } as never);
    // 失窃响应的该行吊销（顶层 deleteMany）
    vi.mocked(prisma.refreshToken.deleteMany).mockResolvedValue({ count: 1 });

    await expect(refreshAccessToken(rawToken)).rejects.toMatchObject({
      code: ERROR_CODES.TOKEN_EXPIRED.code,
    });
    // 只吊销命中的该 token 行：攻击者无法再重放；受害者其余会话（含新签发 token）
    // 不受影响——多 Tab 并发刷新自锁（全量吊销）已消除
    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", tokenHash: sha256(rawToken) },
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("过期（非吊销）token 重放 → TOKEN_EXPIRED，不触发家族吊销（误伤防护）", async () => {
    const rawToken = makeRawToken("user-1");
    // prior 查询命中一条已过期但未吊销的记录 → 只是过期，非失窃
    vi.mocked(prisma.refreshToken.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "rt-expired",
        tokenHash: sha256(rawToken),
        expiresAt: new Date(Date.now() - 1000),
        revokedAt: null,
      } as never);

    await expect(refreshAccessToken(rawToken)).rejects.toMatchObject({
      code: ERROR_CODES.TOKEN_EXPIRED.code,
    });
    expect(prisma.refreshToken.deleteMany).not.toHaveBeenCalled();
  });
});
