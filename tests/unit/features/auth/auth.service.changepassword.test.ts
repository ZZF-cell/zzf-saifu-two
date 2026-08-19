// changePassword 单元测试 — 设置/修改密码（含「无密码 → 设首密」双态）
// mock 系统边界：prisma（user.findUnique / user.update）；哈希真实（scrypt，验旧/新哈希独立性）
// 契约：
// - 已有密码 → 必须验旧密码：缺失/错误 → INVALID_CREDENTIALS，绝不落库
// - 无密码（纯短信登录）→ 直接设置，无需旧密码
// - 被禁用用户禁止改密（禁用门禁下沉到写入口）

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from "@/shared/db/client";
import { changePassword } from "@/features/auth/auth.service";
import { hashPassword, verifyPassword } from "@/shared/utils/crypto";
import { ERROR_CODES } from "@/shared/errors/errors";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("changePassword — 设置/修改密码", () => {
  it("用户不存在 → UNAUTHORIZED，不写库", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    await expect(changePassword("user-1", undefined, "new-pass-123")).rejects.toMatchObject({
      code: ERROR_CODES.UNAUTHORIZED.code,
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("被禁用用户（status=DISABLED）→ 403 USER_DISABLED，密码绝不落库", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      status: "DISABLED",
      passwordHash: "scrypt.x.y",
    } as never);

    await expect(changePassword("user-1", "old-pass-123", "new-pass-123")).rejects.toMatchObject({
      code: ERROR_CODES.USER_DISABLED.code,
      statusCode: 403,
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("已有密码但未提供旧密码 → INVALID_CREDENTIALS，不写库", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      status: "ACTIVE",
      passwordHash: "scrypt.x.y",
    } as never);

    await expect(changePassword("user-1", undefined, "new-pass-123")).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_CREDENTIALS.code,
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("旧密码错误 → INVALID_CREDENTIALS，不写库", async () => {
    const hash = await hashPassword("old-pass-123");
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      status: "ACTIVE",
      passwordHash: hash,
    } as never);

    await expect(changePassword("user-1", "wrong-pass", "new-pass-123")).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_CREDENTIALS.code,
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("旧密码正确 → 以 scrypt 新哈希覆盖 passwordHash", async () => {
    const oldHash = await hashPassword("old-pass-123");
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      status: "ACTIVE",
      passwordHash: oldHash,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({ id: "user-1" } as never);

    await changePassword("user-1", "old-pass-123", "new-pass-123");

    const updateCall = vi.mocked(prisma.user.update).mock.calls[0][0] as {
      data: { passwordHash: string };
    };
    expect(updateCall.data.passwordHash).toMatch(/^scrypt\./);
    expect(updateCall.data.passwordHash).not.toBe(oldHash);
    // 新哈希能验通新密码、验不通旧密码（防哈希退化）
    expect(await verifyPassword("new-pass-123", updateCall.data.passwordHash)).toBe(true);
    expect(await verifyPassword("old-pass-123", updateCall.data.passwordHash)).toBe(false);
  });

  it("无密码（纯短信用户）→ 直接设置，无需旧密码", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      status: "ACTIVE",
      passwordHash: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({ id: "user-1" } as never);

    await changePassword("user-1", undefined, "new-pass-123");

    const updateCall = vi.mocked(prisma.user.update).mock.calls[0][0] as {
      data: { passwordHash: string };
    };
    expect(updateCall.data.passwordHash).toMatch(/^scrypt\./);
  });
});
