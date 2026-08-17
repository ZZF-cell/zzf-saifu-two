// sendVerificationCode 单元测试 — 演示模式验证码回显 + 原子限流
// mock 系统边界：prisma（rateLimitBucket 原子限流 / verificationCode 事务写入）+ sms.adapter.sendSms
// 契约：
// - 同一手机号 60s 窗口第 2 次发送 → 抛 RATE_LIMITED（原子 upsert 计数 > 1，不写库）
// - 短信未实际送达（dev-fallback / placeholder）→ 返回验证码（演示回显，前端展示）
// - 短信真实送达（真实 messageId）→ 返回 null（不回显，前端不显示）

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    verificationCode: { findFirst: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
    rateLimitBucket: { upsert: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/shared/adapters/sms.adapter", () => ({
  sendSms: vi.fn(),
}));

import { prisma } from "@/shared/db/client";
import { sendSms } from "@/shared/adapters/sms.adapter";
import { sendVerificationCode } from "@/features/auth/auth.service";
import { sha256 } from "@/shared/utils/crypto";
import { ERROR_CODES } from "@/shared/errors/errors";

const smsMock = vi.mocked(sendSms);
const rateLimitUpsertMock = vi.mocked(prisma.rateLimitBucket.upsert);

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
  // E2 显式开关：默认开启演示回显（模拟本地验收），各用例按需覆盖
  process.env.DEMO_SMS_ECHO = "true";
  // 默认：首次请求（count=1）放行 —— 每个测试只需关心自己 mock 的限流路径
  rateLimitUpsertMock.mockResolvedValue({ count: 1 } as never);
  tx = {
    verificationCode: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: "vc-1" }),
    },
  };
  transactionMock.mockImplementation((fn: (tx: Tx) => Promise<unknown>) => fn(tx));
});

describe("sendVerificationCode — 演示模式回显", () => {
  it("未配置短信（dev-fallback）→ 返回 6 位验证码，且 DB 只存 SHA-256 哈希（codeHash），不存明文", async () => {
    smsMock.mockResolvedValue({ success: true, messageId: "dev-fallback" });

    const code = await sendVerificationCode("13800138000");

    expect(code).toMatch(/^\d{6}$/);
    expect(tx.verificationCode.deleteMany).toHaveBeenCalled();
    // E4 哈希存储：create 的 data 含 codeHash=SHA-256(code)，绝不含明文 code 字段
    expect(tx.verificationCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ codeHash: sha256(code as string) }),
      }),
    );
    const createCall = tx.verificationCode.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createCall.data.code).toBeUndefined();
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

  it("DEMO_SMS_ECHO 未开启（默认）→ 返回 null，绝不回显验证码（枚举门禁）", async () => {
    // E2 修复回归：回显由显式开关控制（DEMO_SMS_ECHO=true），不再依赖 NODE_ENV 单闸门——
    // 默认任何环境都不回显，否则短信网关停摆/误配置时演示回显即高危后门（任意手机号可接管）。
    delete process.env.DEMO_SMS_ECHO;
    smsMock.mockResolvedValue({ success: true, messageId: "dev-fallback" });

    const code = await sendVerificationCode("13800138000");

    expect(code).toBeNull();
  });

  it("DEMO_SMS_ECHO=false（显式关闭）→ 同样返回 null", async () => {
    process.env.DEMO_SMS_ECHO = "false";
    smsMock.mockResolvedValue({ success: true, messageId: "dev-fallback" });

    const code = await sendVerificationCode("13800138000");

    expect(code).toBeNull();
  });

  it("同一手机号 60s 窗口第 2 次 → 抛 RATE_LIMITED（原子桶计数>1，不写库）", async () => {
    // 原子限流语义：单条 upsert 返回窗口内计数（含本次）。count=2 > max=1 → 拒绝，
    // 且拒绝发生在写验证码事务之前（$transaction 不被调用）。
    rateLimitUpsertMock.mockResolvedValue({ count: 2 } as never);

    await expect(sendVerificationCode("13800138000")).rejects.toMatchObject({
      code: ERROR_CODES.RATE_LIMITED.code,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.verificationCode.create).not.toHaveBeenCalled();
  });

  it("同号限流通过后再按 IP 限流（同一 IP 分钟窗口超限 → RATE_LIMITED）", async () => {
    // 第一次 upsert（sms:phone）返回 count=1 放行；第二次（sms:ip:minute）返回 count=11 > max=10 → 拒绝
    rateLimitUpsertMock.mockResolvedValueOnce({ count: 1 } as never).mockResolvedValueOnce({ count: 11 } as never);

    await expect(sendVerificationCode("13800138000", "1.2.3.4")).rejects.toMatchObject({
      code: ERROR_CODES.RATE_LIMITED.code,
    });
  });

  it("同一 IP 日窗口超限（第 3 次 upsert count=201）→ RATE_LIMITED 今日上限", async () => {
    rateLimitUpsertMock
      .mockResolvedValueOnce({ count: 1 } as never) // phone
      .mockResolvedValueOnce({ count: 1 } as never) // ip minute
      .mockResolvedValueOnce({ count: 201 } as never); // ip daily > 200
    await expect(sendVerificationCode("13800138000", "1.2.3.4")).rejects.toMatchObject({
      code: ERROR_CODES.RATE_LIMITED.code,
    });
  });
});
