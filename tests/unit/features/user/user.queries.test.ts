// getProfile 单元测试 — 个人信息 + 订单统计（按状态分组计数）
// mock 系统边界：prisma（user.findUnique / order.groupBy）
// 只测公共 seam：getProfile

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    order: { groupBy: vi.fn() },
  },
}));

// 被测模块从 orders Public API 导入 ORDER_STATUS（边界合规）。
// 直接 import 会连带加载 orders.routes.tsx（next/navigation，node 环境不可用），故整体 mock。
vi.mock("@/features/orders", () => ({
  ORDER_STATUS: {
    PENDING: "PENDING",
    PAID: "PAID",
    SHIPPED: "SHIPPED",
    DELIVERED: "DELIVERED",
    COMPLETED: "COMPLETED",
    CANCELLED: "CANCELLED",
    REFUND_REQUESTED: "REFUND_REQUESTED",
    REFUNDED: "REFUNDED",
  },
  // 统计卡/订单列表 Tab 同口径分组（M4 后 getProfile 依赖它替代硬编码）
  ORDER_STATUS_GROUPS: {
    pending: ["PENDING"],
    paid: ["PAID", "SHIPPED", "DELIVERED", "COMPLETED"],
    cancelled: ["CANCELLED", "REFUND_REQUESTED", "REFUNDED"],
  },
}));

import { prisma } from "@/shared/db/client";
import { getProfile } from "@/features/user/user.queries";

const USER_ID = "user-1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getProfile — 个人信息 + 订单统计", () => {
  it("用户存在 → 返回昵称/角色/年龄验证 + 按状态归类的订单统计", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      nickname: "小赛夫",
      role: "USER",
      ageVerified: true,
      createdAt: new Date("2026-08-01T00:00:00Z"),
    } as never);

    vi.mocked(prisma.order.groupBy).mockResolvedValue([
      { status: "PENDING", _count: { _all: 2 } },
      { status: "PAID", _count: { _all: 1 } },
      { status: "COMPLETED", _count: { _all: 3 } },
      { status: "CANCELLED", _count: { _all: 1 } },
    ] as never);

    const profile = await getProfile(USER_ID);

    expect(profile.nickname).toBe("小赛夫");
    expect(profile.role).toBe("USER");
    expect(profile.ageVerified).toBe(true);
    expect(profile.stats).toEqual({
      totalOrders: 7, // 2+1+3+1
      pendingPayment: 2,
      paidOrders: 4, // PAID 1 + COMPLETED 3（含 SHIPPED/DELIVERED）
      cancelledOrders: 1,
    });
    expect(prisma.order.groupBy).toHaveBeenCalledWith({
      by: ["status"],
      where: { userId: USER_ID, destroyedAt: null },
      _count: { _all: true },
    });
  });

  it("M7：已销毁订单不纳入统计（destroyedAt 过滤与订单列表同口径）", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      nickname: "小赛夫",
      role: "USER",
      ageVerified: true,
      createdAt: new Date("2026-08-01T00:00:00Z"),
    } as never);

    // 统计查询本身按 destroyedAt: null 过滤（由 where 断言保证）；此处验证「非销毁订单」正常计数，
    // 已销毁订单在查询边界就被排除，不会出现在 groupBy 返回里。
    vi.mocked(prisma.order.groupBy).mockResolvedValue([
      { status: "PAID", _count: { _all: 1 } },
    ] as never);

    const profile = await getProfile(USER_ID);

    expect(profile.stats).toEqual({
      totalOrders: 1,
      pendingPayment: 0,
      paidOrders: 1,
      cancelledOrders: 0,
    });
    expect(prisma.order.groupBy).toHaveBeenCalledWith({
      by: ["status"],
      where: { userId: USER_ID, destroyedAt: null },
      _count: { _all: true },
    });
  });

  it("无任何订单 → 统计全为 0", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      nickname: null,
      role: "USER",
      ageVerified: false,
      createdAt: new Date(),
    } as never);
    vi.mocked(prisma.order.groupBy).mockResolvedValue([] as never);

    const profile = await getProfile(USER_ID);

    expect(profile.stats).toEqual({
      totalOrders: 0,
      pendingPayment: 0,
      paidOrders: 0,
      cancelledOrders: 0,
    });
  });

  it("用户不存在 → 抛 UNAUTHORIZED", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);

    await expect(getProfile(USER_ID)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("回传 avatarUrl + hasPassword（推导后剥除 passwordHash，绝不外泄）", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      nickname: "小赛夫",
      role: "USER",
      ageVerified: true,
      avatarUrl: "https://oss.example.com/avatar/user-1/20260819/a1.jpg",
      passwordHash: "scrypt.abcd.efgh",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    } as never);
    vi.mocked(prisma.order.groupBy).mockResolvedValue([] as never);

    const profile = await getProfile(USER_ID);

    expect(profile.avatarUrl).toBe("https://oss.example.com/avatar/user-1/20260819/a1.jpg");
    expect(profile.hasPassword).toBe(true);
    // 安全契约：passwordHash 不允许出现在响应里
    expect(profile).not.toHaveProperty("passwordHash");
  });

  it("无密码用户 → hasPassword 为 false", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      nickname: null,
      role: "USER",
      ageVerified: false,
      avatarUrl: null,
      passwordHash: null,
      createdAt: new Date(),
    } as never);
    vi.mocked(prisma.order.groupBy).mockResolvedValue([] as never);

    const profile = await getProfile(USER_ID);

    expect(profile.hasPassword).toBe(false);
    expect(profile).not.toHaveProperty("passwordHash");
  });
});
