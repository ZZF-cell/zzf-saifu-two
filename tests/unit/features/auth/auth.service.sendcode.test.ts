// sendVerificationCode 单元测试 — 演示模式验证码回显
// mock 系统边界：prisma（verificationCode 频率查询 / 事务写入）+ sms.adapter.sendSms
// 契约：
// - 60 秒内重复发送 → 抛 VALIDATION_ERROR（频率限制）
// - 短信未实际送达（dev-fallback / placeholder）→ 返回验证码（演示回显，前端展示）
// - 短信真实送达（真实 messageId）→ 返回 null（不回显，前端不显示）

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    verificationCode: { findFirst: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/shared/adapters/sms.adapter", () => ({
  sendSms: vi.fn(),
}));

import { prisma } from "@/shared/db/client";
import { sendSms } from "@/shared/adapters/sms.adapter";
import { sendVerificationCode } from "@/features/auth/auth.service";
import { ERROR_CODES } from "@/shared/errors/errors";

const smsMock = vi.mocked(sendSms);

// ── 交互事务 mock：$transaction(fn) 以 tx 对象调用 fn（发码 = 清旧码 + 写新码 同事务） ──
type Tx = {
  verificationCode: { deleteMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
};

let tx: Tx;
type TransactionImpl = (fn: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
const transactionMock = prisma.$transaction as unknown as Mock<TransactionImpl>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PEPPER = "test-pepper";
  tx = {
    verificationCode: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: "vc-1" }),
    },
  };
  vi.mocked(prisma.verificationCode.findFirst).mockResolvedValue(null);
  transactionMock.mockImplementation((fn: (tx: Tx) => Promise<unknown>) => fn(tx));
});

describe("sendVerificationCode — 演示模式回显", () => {
  it("未配置短信（dev-fallback）→ 返回 6 位验证码，且验证码已写入 DB 事务", async () => {
    smsMock.mockResolvedValue({ success: true, messageId: "dev-fallback" });

    const code = await sendVerificationCode("13800138000");

    expect(code).toMatch(/^\d{6}$/);
    expect(tx.verificationCode.deleteMany).toHaveBeenCalled();
    expect(tx.verificationCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ code }),
      }),
    );
  });

  it("已配置密钥但未接入 SDK（placeholder）→ 仍回显验证码", async () => {
    smsMock.mockResolvedValue({ success: true, messageId: "placeholder" });

    const code = await sendVerificationCode("13800138000");

    expect(code).toMatch(/^\d{6}$/);
  });

  it("短信真实送达（真实 messageId）→ 返回 null（不回显）", async () => {
    smsMock.mockResolvedValue({ success: true, messageId: "real-msg-abc" });

    const code = await sendVerificationCode("13800138000");

    expect(code).toBeNull();
  });

  it("60 秒内重复发送 → 抛 VALIDATION_ERROR（频率限制，不写库）", async () => {
    vi.mocked(prisma.verificationCode.findFirst).mockResolvedValue({
      id: "vc-old",
    } as never);

    await expect(sendVerificationCode("13800138000")).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR.code,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
