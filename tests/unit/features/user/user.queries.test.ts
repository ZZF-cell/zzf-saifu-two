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
      where: { userId: USER_ID },
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
});
