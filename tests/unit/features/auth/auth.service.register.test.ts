// registerWithPassword 单元测试 — 禁用门禁（M3：被禁用户禁止通过补设密码获取新会话）
// mock 系统边界：prisma（verificationCode.findFirst/deleteMany + user.findUnique + refreshToken.create）
// 只测公共 seam：registerWithPassword 对既有 DISABLED 用户的拒绝路径

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    verificationCode: { findFirst: vi.fn(), deleteMany: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    refreshToken: { create: vi.fn() },
  },
}));

import { prisma } from "@/shared/db/client";
import { registerWithPassword } from "@/features/auth/auth.service";
import { ERROR_CODES } from "@/shared/errors/errors";
import { hashPhone } from "@/shared/utils/crypto";

const PHONE = "13800138000";
const CODE = "123456";

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    phoneHash: hashPhone(PHONE),
    passwordHash: null,
    role: "USER",
    status: "ACTIVE",
    ...overrides,
  };
}

/** 让验证码校验通过：有效记录 + 原子消费 deleteMany count=1 */
function mockValidCode() {
  vi.mocked(prisma.verificationCode.findFirst).mockResolvedValue({
    id: "vc-1",
    phoneHash: hashPhone(PHONE),
    code: CODE,
    attempts: 0,
  } as never);
  vi.mocked(prisma.verificationCode.deleteMany).mockResolvedValue({ count: 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PEPPER = "test-pepper";
});

describe("registerWithPassword — 禁用门禁", () => {
  it("既有短信用户补设密码 + status=DISABLED → 403 USER_DISABLED，不写密码不签发 token", async () => {
    mockValidCode();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser({ status: "DISABLED" }));

    await expect(registerWithPassword(PHONE, "new-pass-123", CODE)).rejects.toMatchObject({
      code: ERROR_CODES.USER_DISABLED.code,
      statusCode: 403,
    });

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it("既有短信用户补设密码 + ACTIVE → 成功签发双 token（对照：非禁用不受影响）", async () => {
    mockValidCode();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(makeUser());
    vi.mocked(prisma.refreshToken.create).mockResolvedValue({ id: "rt" } as never);

    const tokens = await registerWithPassword(PHONE, "new-pass-123", CODE);

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { passwordHash: expect.stringMatching(/^scrypt\./) },
    });
  });
});
