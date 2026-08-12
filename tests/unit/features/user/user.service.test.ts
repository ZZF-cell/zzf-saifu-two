// updateNickname 单元测试 — 昵称清洗 + 落库
// mock 系统边界：prisma（user.update）
// 只测公共 seam：updateNickname

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    user: { update: vi.fn() },
  },
}));

import { prisma } from "@/shared/db/client";
import { updateNickname } from "@/features/user/user.service";
import { ERROR_CODES } from "@/shared/errors/errors";

const USER_ID = "user-1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("updateNickname — 修改昵称", () => {
  it("有效昵称 → 去除首尾空格后落库并返回", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({
      nickname: "小赛夫",
    } as never);

    const result = await updateNickname(USER_ID, "  小赛夫  ");

    expect(result).toEqual({ nickname: "小赛夫" });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { nickname: "小赛夫" },
      select: { nickname: true },
    });
  });

  it("纯空格昵称 → 抛 VALIDATION_ERROR，不落库", async () => {
    await expect(updateNickname(USER_ID, "   ")).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR.code,
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
