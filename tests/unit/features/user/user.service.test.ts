// user.service 单元测试 — 昵称/头像/改手机号/注销
// mock 系统边界：prisma（user/refreshToken/cartItem/order/inviteCode/serviceTicket/serviceTicketMessage/verificationCode + $transaction）
//            + auth.service.verifyAndConsumeCode（验证码消费，防爆破逻辑归 auth 模块测）
// 核心契约：
// - 头像：非本人上传的 OSS URL → VALIDATION_ERROR；空串 → 清除头像
// - 改手机号：新号=旧号 → 拒绝；验证码错 → INVALID_CREDENTIALS；P2002 → PHONE_ALREADY_EXISTS
// - 注销：SUPER 拦截 / 已入驻品牌 409 / 有密码须验旧 / 事务内匿名化订单+邀请码+工单

import crypto from "crypto";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    refreshToken: { deleteMany: vi.fn() },
    cartItem: { deleteMany: vi.fn() },
    order: { updateMany: vi.fn() },
    inviteCode: { updateMany: vi.fn() },
    serviceTicket: { updateMany: vi.fn() },
    serviceTicketMessage: { updateMany: vi.fn() },
    verificationCode: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/features/auth", () => ({
  authService: { verifyAndConsumeCode: vi.fn() },
}));

import { prisma } from "@/shared/db/client";
import { updateNickname, updateAvatar, changePhone, deleteAccount } from "@/features/user/user.service";
import { authService } from "@/features/auth";
import { hashPassword } from "@/shared/utils/crypto";
import { ERROR_CODES } from "@/shared/errors/errors";

const USER_ID = "user-1";
const userFindUnique = prisma.user.findUnique as Mock;
const userUpdate = prisma.user.update as Mock;
const verifyCode = vi.mocked(authService.verifyAndConsumeCode);
const transaction = prisma.$transaction as Mock;

type Tx = {
  user: { update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  refreshToken: { deleteMany: ReturnType<typeof vi.fn> };
  cartItem: { deleteMany: ReturnType<typeof vi.fn> };
  order: { updateMany: ReturnType<typeof vi.fn> };
  inviteCode: { updateMany: ReturnType<typeof vi.fn> };
  serviceTicket: { updateMany: ReturnType<typeof vi.fn> };
  serviceTicketMessage: { updateMany: ReturnType<typeof vi.fn> };
  verificationCode: { deleteMany: ReturnType<typeof vi.fn> };
  auditLog: { updateMany: ReturnType<typeof vi.fn> };
};

const tx: Tx = {
  user: { update: vi.fn(), delete: vi.fn() },
  refreshToken: { deleteMany: vi.fn() },
  cartItem: { deleteMany: vi.fn() },
  order: { updateMany: vi.fn() },
  inviteCode: { updateMany: vi.fn() },
  serviceTicket: { updateMany: vi.fn() },
  serviceTicketMessage: { updateMany: vi.fn() },
  verificationCode: { deleteMany: vi.fn() },
  auditLog: { updateMany: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PEPPER = "test-pepper";
  transaction.mockImplementation((fn: (t: Tx) => Promise<unknown>) => fn(tx));
  verifyCode.mockResolvedValue(true);
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

describe("updateAvatar — 修改头像", () => {
  it("本人上传的 OSS URL → 落库", async () => {
    process.env.OSS_BUCKET = "saife-images";
    process.env.OSS_REGION = "oss-cn-beijing";
    const url = `https://saife-images.oss-cn-beijing.aliyuncs.com/avatar/${USER_ID}/20260819/a1.jpg`;
    userUpdate.mockResolvedValue({ avatarUrl: url });

    const result = await updateAvatar(USER_ID, url);

    expect(result).toEqual({ avatarUrl: url });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { avatarUrl: url },
      select: { avatarUrl: true },
    });
  });

  it("非本人上传 / 伪造 URL → VALIDATION_ERROR，不落库", async () => {
    process.env.OSS_BUCKET = "saife-images";
    process.env.OSS_REGION = "oss-cn-beijing";
    // userId 段是他人（key 内嵌 other-9），归属校验失败
    const url = "https://saife-images.oss-cn-beijing.aliyuncs.com/avatar/other-9/20260819/a1.jpg";

    await expect(updateAvatar(USER_ID, url)).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR.code,
    });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("空字符串 → 清除头像（置 null）", async () => {
    userUpdate.mockResolvedValue({ avatarUrl: null });

    const result = await updateAvatar(USER_ID, "   ");

    expect(result).toEqual({ avatarUrl: null });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { avatarUrl: null },
      select: { avatarUrl: true },
    });
  });
});

describe("changePhone — 换绑手机号（新号短信验证）", () => {
  it("新号与当前相同 → VALIDATION_ERROR，不消费验证码", async () => {
    const hash = crypto.createHash("sha256").update("test-pepper" + "13800000001").digest("hex");
    userFindUnique.mockResolvedValue({ phoneHash: hash, status: "ACTIVE" });

    await expect(changePhone(USER_ID, "13800000001", "123456")).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR.code,
    });
    expect(verifyCode).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("验证码错误 → INVALID_CREDENTIALS，不写库", async () => {
    const passwordHash = await hashPassword("pass-123456");
    userFindUnique.mockResolvedValue({ phoneHash: "old-hash", status: "ACTIVE", passwordHash });
    verifyCode.mockResolvedValue(false);

    await expect(
      changePhone(USER_ID, "13900000001", "000000", "pass-123456"),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_CREDENTIALS.code,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("有密码 + 旧密码正确 + 验证码通过 → 事务更新 phoneHash + 清旧号验证码 + 吊销会话", async () => {
    const passwordHash = await hashPassword("pass-123456");
    userFindUnique.mockResolvedValue({ phoneHash: "old-hash", status: "ACTIVE", passwordHash });
    const newHash = crypto.createHash("sha256").update("test-pepper" + "13900000001").digest("hex");

    await changePhone(USER_ID, "13900000001", "123456", "pass-123456");

    expect(verifyCode).toHaveBeenCalledWith("13900000001", "123456");
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { phoneHash: newHash },
    });
    expect(tx.verificationCode.deleteMany).toHaveBeenCalledWith({
      where: { phoneHash: "old-hash" },
    });
    expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
  });

  it("纯短信用户（无密码）+ 旧号验证码正确 → 事务换绑", async () => {
    userFindUnique.mockResolvedValue({ phoneHash: "old-hash", status: "ACTIVE", passwordHash: null });
    const newHash = crypto.createHash("sha256").update("test-pepper" + "13900000001").digest("hex");

    await changePhone(USER_ID, "13900000001", "123456", undefined, "13800000001", "654321");

    // 旧号验证码复验 + 新号验证码均被消费
    expect(verifyCode).toHaveBeenCalledWith("13800000001", "654321");
    expect(verifyCode).toHaveBeenCalledWith("13900000001", "123456");
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { phoneHash: newHash },
    });
  });

  it("有密码但不提供旧密码 → INVALID_CREDENTIALS，不写库", async () => {
    userFindUnique.mockResolvedValue({
      phoneHash: "old-hash",
      status: "ACTIVE",
      passwordHash: "scrypt.salt.hash",
    });

    await expect(changePhone(USER_ID, "13900000001", "123456")).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_CREDENTIALS.code,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("新号唯一约束冲突（P2002）→ PHONE_ALREADY_EXISTS", async () => {
    const passwordHash = await hashPassword("pass-123456");
    userFindUnique.mockResolvedValue({ phoneHash: "old-hash", status: "ACTIVE", passwordHash });
    const conflict = new Error("Unique constraint failed");
    (conflict as { code?: string }).code = "P2002";
    transaction.mockRejectedValue(conflict);

    await expect(changePhone(USER_ID, "13900000001", "123456", "pass-123456")).rejects.toMatchObject({
      code: ERROR_CODES.PHONE_ALREADY_EXISTS.code,
    });
  });
});

describe("deleteAccount — 自主注销（硬删除）", () => {
  it("SUPER 唯一账号 → FORBIDDEN，禁止注销", async () => {
    userFindUnique.mockResolvedValue({ role: "SUPER", brand: null });

    await expect(deleteAccount(USER_ID)).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN.code,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("已入驻品牌 → 409 ACCOUNT_HAS_BRAND", async () => {
    userFindUnique.mockResolvedValue({ role: "USER", brand: { id: "brand-1" } });

    await expect(deleteAccount(USER_ID)).rejects.toMatchObject({
      code: ERROR_CODES.ACCOUNT_HAS_BRAND.code,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("有密码但未提供 → INVALID_CREDENTIALS", async () => {
    userFindUnique.mockResolvedValue({ role: "USER", brand: null, passwordHash: "scrypt.x.y" });

    await expect(deleteAccount(USER_ID)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_CREDENTIALS.code,
    });
  });

  it("有密码且验证通过 → 匿名化订单/邀请码/工单 + 删会话/购物车/验证码/用户", async () => {
    const passwordHash = await hashPassword("pass-123456");
    userFindUnique.mockResolvedValue({
      phoneHash: "my-hash",
      role: "USER",
      brand: null,
      passwordHash,
    });

    await deleteAccount(USER_ID, "pass-123456");

    expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    expect(tx.cartItem.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { userId: null },
    });
    expect(tx.inviteCode.updateMany).toHaveBeenCalledWith({
      where: { createdBy: USER_ID },
      data: { createdBy: null },
    });
    expect(tx.serviceTicket.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { userId: null },
    });
    expect(tx.serviceTicketMessage.updateMany).toHaveBeenCalledWith({
      where: { senderId: USER_ID },
      data: { senderId: null },
    });
    expect(tx.verificationCode.deleteMany).toHaveBeenCalledWith({ where: { phoneHash: "my-hash" } });
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: USER_ID } });
  });

  it("无密码（纯短信用户）→ 无需验密码直接注销", async () => {
    userFindUnique.mockResolvedValue({ phoneHash: "my-hash", role: "USER", brand: null, passwordHash: null });

    await deleteAccount(USER_ID);

    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: USER_ID } });
  });

  it("密码错误 → INVALID_CREDENTIALS，不执行事务", async () => {
    const passwordHash = await hashPassword("pass-123456");
    userFindUnique.mockResolvedValue({
      phoneHash: "my-hash",
      role: "USER",
      brand: null,
      passwordHash,
    });

    await expect(deleteAccount(USER_ID, "wrong-pass")).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_CREDENTIALS.code,
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});
