// setPassword 单元测试 — 为短信登录用户补设密码
// mock 系统边界：prisma（user.findUnique / user.update）
// 契约（#13 回归护栏）：被禁用用户禁止写入口（access token 15min 内仍有效，
// 禁用门禁必须下沉到写入口，而非依赖 access token 过期）——DISABLED → 403，绝不落库

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from "@/shared/db/client";
import { setPassword } from "@/features/auth/auth.service";
import { ERROR_CODES } from "@/shared/errors/errors";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PEPPER = "test-pepper";
});

describe("setPassword — 补设密码与禁用门禁", () => {
  it("用户不存在 → UNAUTHORIZED，不写库", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    await expect(setPassword("user-1", "new-pass-123")).rejects.toMatchObject({
      code: ERROR_CODES.UNAUTHORIZED.code,
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("被禁用用户（status=DISABLED）→ 403 USER_DISABLED，密码绝不落库", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-1",
      status: "DISABLED",
    } as never);

    await expect(setPassword("user-1", "new-pass-123")).rejects.toMatchObject({
      code: ERROR_CODES.USER_DISABLED.code,
      statusCode: 403,
    });
    // 禁用门禁在哈希前拦截：即便 token 仍有效也禁止改密码
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("ACTIVE 用户 → 以 scrypt 哈希覆盖 passwordHash", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-1",
      status: "ACTIVE",
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({ id: "user-1" } as never);

    await setPassword("user-1", "new-pass-123");

    const updateCall = vi.mocked(prisma.user.update).mock.calls[0][0] as {
      data: { passwordHash: string };
    };
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { passwordHash: expect.any(String) },
    });
    expect(updateCall.data.passwordHash).toMatch(/^scrypt\./);
  });
});
