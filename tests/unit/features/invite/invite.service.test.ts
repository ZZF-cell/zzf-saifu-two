// invite.service 单元测试 — 品牌入驻激活（原子消耗邀请码 + 创建 PENDING 品牌）
// mock 系统边界：prisma $transaction（交互事务内 brand/user/inviteCode）
// 只测公共 seam：activateInviteCode
//
// 核心契约：
// - 激活 = 单事务原子消耗邀请码（updateMany 状态守卫）+ 创建 PENDING 品牌
// - 消耗守卫含过期判断（UNUSED + 未过期才可消耗），过期码绝不消耗
// - 未命中时按 无效(400) / 已用(409) / 过期(410) 区分（不向品牌侧泄露码存在性）
// - 激活前拦截：已有品牌(409) / 非普通用户(403)；并发兜底：brand.create 唯一约束冲突重查
// - 角色升级不在激活时做（由管理员审核通过时 reviewBrand 升级）

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    brand: { findUnique: vi.fn(), create: vi.fn() },
    user: { findUnique: vi.fn() },
    inviteCode: { updateMany: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "@/shared/db/client";
import { ERROR_CODES } from "@/shared/errors/errors";
import { activateInviteCode } from "@/features/invite/invite.service";

type Tx = {
  brand: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
  inviteCode: { updateMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
};

let tx: Tx;
type TransactionImpl = (fn: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
const transactionMock = prisma.$transaction as unknown as Mock<TransactionImpl>;

beforeEach(() => {
  vi.clearAllMocks();
  // G4 归属校验经 oss.adapter.isOssUrl 读取 OSS host 白名单（process.env），
  // 测试态配齐 bucket/region 使合法 OSS URL 通过 host 校验
  process.env.OSS_BUCKET = "saife-images";
  process.env.OSS_REGION = "oss-cn-beijing";
  tx = {
    brand: { findUnique: vi.fn(), create: vi.fn() },
    user: { findUnique: vi.fn() },
    inviteCode: { updateMany: vi.fn(), findUnique: vi.fn() },
  };
  transactionMock.mockImplementation((fn: (tx: Tx) => Promise<unknown>) => fn(tx));
});

describe("activateInviteCode — 品牌入驻激活", () => {
  it("有效未过期码 → 消耗邀请码 + 创建 PENDING 品牌，返回 brandId", async () => {
    tx.brand.findUnique.mockResolvedValue(null); // 尚无品牌
    tx.user.findUnique.mockResolvedValue({ role: "USER" });
    tx.inviteCode.updateMany.mockResolvedValue({ count: 1 });
    tx.brand.create.mockResolvedValue({ id: "brand-1" });

    const result = await activateInviteCode(
      {
        code: "invite-brand-101 ",
        name: "  测试品牌  ",
        logo: "https://saife-images.oss-cn-beijing.aliyuncs.com/brand/user-1/20260815/logo.png",
      },
      "user-1",
    );

    expect(result).toEqual({ brandId: "brand-1" });
    // 码归一化为大写+去空格
    expect(tx.inviteCode.updateMany).toHaveBeenCalledWith({
      where: {
        code: "INVITE-BRAND-101",
        status: "UNUSED",
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
      data: { status: "USED", usedAt: expect.any(Date), usedBy: "user-1" },
    });
    expect(tx.brand.create).toHaveBeenCalledWith({
      data: {
        name: "测试品牌",
        logo: "https://saife-images.oss-cn-beijing.aliyuncs.com/brand/user-1/20260815/logo.png",
        status: "PENDING",
        inviteCode: "INVITE-BRAND-101",
        ownerId: "user-1",
      },
      select: { id: true },
    });
  });

  it("logo 留空 → 品牌 logo 落 null", async () => {
    tx.brand.findUnique.mockResolvedValue(null);
    tx.user.findUnique.mockResolvedValue({ role: "USER" });
    tx.inviteCode.updateMany.mockResolvedValue({ count: 1 });
    tx.brand.create.mockResolvedValue({ id: "brand-1" });

    await activateInviteCode({ code: "INVITE-BRAND-101", name: "测试品牌" }, "user-1");

    expect(tx.brand.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ logo: null }),
      }),
    );
  });

  it("用户已拥有品牌 → 409 BRAND_ALREADY_EXISTS，不消耗邀请码", async () => {
    tx.brand.findUnique.mockResolvedValue({ id: "brand-1" });

    await expect(
      activateInviteCode({ code: "INVITE-BRAND-101", name: "测试品牌" }, "user-1"),
    ).rejects.toMatchObject({
      code: ERROR_CODES.BRAND_ALREADY_EXISTS.code,
      statusCode: 409,
    });
    expect(tx.inviteCode.updateMany).not.toHaveBeenCalled();
  });

  it("非普通用户（ADMIN）→ 403 FORBIDDEN", async () => {
    tx.brand.findUnique.mockResolvedValue(null);
    tx.user.findUnique.mockResolvedValue({ role: "ADMIN" });

    await expect(
      activateInviteCode({ code: "INVITE-BRAND-101", name: "测试品牌" }, "user-1"),
    ).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN.code,
      statusCode: 403,
    });
    expect(tx.inviteCode.updateMany).not.toHaveBeenCalled();
  });

  it("用户不存在 → 401 UNAUTHORIZED", async () => {
    tx.brand.findUnique.mockResolvedValue(null);
    tx.user.findUnique.mockResolvedValue(null);

    await expect(
      activateInviteCode({ code: "INVITE-BRAND-101", name: "测试品牌" }, "user-x"),
    ).rejects.toMatchObject({
      code: ERROR_CODES.UNAUTHORIZED.code,
      statusCode: 401,
    });
  });

  it("消耗未命中且码不存在 → 400 INVITE_CODE_INVALID（不泄露码存在性）", async () => {
    tx.brand.findUnique.mockResolvedValue(null);
    tx.user.findUnique.mockResolvedValue({ role: "USER" });
    tx.inviteCode.updateMany.mockResolvedValue({ count: 0 });
    tx.inviteCode.findUnique.mockResolvedValue(null);

    await expect(
      activateInviteCode({ code: "INVITE-BRAND-XXX", name: "测试品牌" }, "user-1"),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVITE_CODE_INVALID.code,
      statusCode: 400,
    });
    expect(tx.brand.create).not.toHaveBeenCalled();
  });

  it("消耗未命中且码已用 → 409 INVITE_CODE_USED", async () => {
    tx.brand.findUnique.mockResolvedValue(null);
    tx.user.findUnique.mockResolvedValue({ role: "USER" });
    tx.inviteCode.updateMany.mockResolvedValue({ count: 0 });
    tx.inviteCode.findUnique.mockResolvedValue({ status: "USED", expiresAt: null });

    await expect(
      activateInviteCode({ code: "INVITE-BRAND-101", name: "测试品牌" }, "user-1"),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVITE_CODE_USED.code,
      statusCode: 409,
    });
  });

  it("消耗未命中且码已过期 → 410 INVITE_CODE_EXPIRED（过期码不会被消耗）", async () => {
    tx.brand.findUnique.mockResolvedValue(null);
    tx.user.findUnique.mockResolvedValue({ role: "USER" });
    tx.inviteCode.updateMany.mockResolvedValue({ count: 0 });
    tx.inviteCode.findUnique.mockResolvedValue({
      status: "UNUSED",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
    });

    await expect(
      activateInviteCode({ code: "INVITE-BRAND-101", name: "测试品牌" }, "user-1"),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVITE_CODE_EXPIRED.code,
      statusCode: 410,
    });
  });

  it("消耗未命中且码已作废 → 409 INVITE_CODE_DISABLED（作废码不可激活）", async () => {
    tx.brand.findUnique.mockResolvedValue(null);
    tx.user.findUnique.mockResolvedValue({ role: "USER" });
    tx.inviteCode.updateMany.mockResolvedValue({ count: 0 });
    tx.inviteCode.findUnique.mockResolvedValue({ status: "DISABLED", expiresAt: null });

    await expect(
      activateInviteCode({ code: "INVITE-BRAND-101", name: "测试品牌" }, "user-1"),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVITE_CODE_DISABLED.code,
      statusCode: 409,
    });
    expect(tx.brand.create).not.toHaveBeenCalled();
  });

  it("并发兜底：brand.create 唯一约束冲突且用户已有品牌 → 409 BRAND_ALREADY_EXISTS", async () => {
    tx.brand.findUnique.mockResolvedValueOnce(null); // 首次查无品牌
    tx.user.findUnique.mockResolvedValue({ role: "USER" });
    tx.inviteCode.updateMany.mockResolvedValue({ count: 1 });
    tx.brand.create.mockRejectedValue(new Error("Unique constraint failed"));
    tx.brand.findUnique.mockResolvedValueOnce({ id: "brand-1" }); // 冲突后重查已有品牌

    await expect(
      activateInviteCode({ code: "INVITE-BRAND-101", name: "测试品牌" }, "user-1"),
    ).rejects.toMatchObject({
      code: ERROR_CODES.BRAND_ALREADY_EXISTS.code,
      statusCode: 409,
    });
  });

  it("并发兜底：brand.create 失败但重查无品牌 → 原错误透传", async () => {
    tx.brand.findUnique.mockResolvedValue(null);
    tx.user.findUnique.mockResolvedValue({ role: "USER" });
    tx.inviteCode.updateMany.mockResolvedValue({ count: 1 });
    const dbErr = new Error("DB down");
    tx.brand.create.mockRejectedValue(dbErr);

    await expect(
      activateInviteCode({ code: "INVITE-BRAND-101", name: "测试品牌" }, "user-1"),
    ).rejects.toThrow("DB down");
  });

  it("G4：logo 为他人上传的 OSS URL（key 段 userId ≠ 当前用户）→ VALIDATION_ERROR，不消耗邀请码", async () => {
    tx.brand.findUnique.mockResolvedValue(null);
    tx.user.findUnique.mockResolvedValue({ role: "USER" });

    await expect(
      activateInviteCode(
        {
          code: "INVITE-BRAND-101",
          name: "测试品牌",
          logo: "https://saife-images.oss-cn-beijing.aliyuncs.com/brand/user-other/20260815/logo.png",
        },
        "user-1",
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR.code,
      statusCode: 422,
      message: "品牌 logo 必须是您上传的图片",
    });
    expect(tx.inviteCode.updateMany).not.toHaveBeenCalled();
  });

  it("G4：logo 为本站 host 但非标准 key 结构（伪造 key）→ VALIDATION_ERROR", async () => {
    tx.brand.findUnique.mockResolvedValue(null);
    tx.user.findUnique.mockResolvedValue({ role: "USER" });

    await expect(
      activateInviteCode(
        {
          code: "INVITE-BRAND-101",
          name: "测试品牌",
          // key 只有 2 段（缺日期/文件名），不符合 buildObjectKey 生成结构
          logo: "https://saife-images.oss-cn-beijing.aliyuncs.com/brand/user-1/fake.png",
        },
        "user-1",
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR.code });
    expect(tx.inviteCode.updateMany).not.toHaveBeenCalled();
  });

  it("G4：logo 为站外任意 URL（非白名单 host）→ VALIDATION_ERROR", async () => {
    tx.brand.findUnique.mockResolvedValue(null);
    tx.user.findUnique.mockResolvedValue({ role: "USER" });

    await expect(
      activateInviteCode(
        { code: "INVITE-BRAND-101", name: "测试品牌", logo: "https://evil.com/x.png" },
        "user-1",
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_ERROR.code });
    expect(tx.inviteCode.updateMany).not.toHaveBeenCalled();
  });
});
