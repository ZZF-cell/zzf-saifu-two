// service.queries 单元测试 — 工单读取（列表 + 详情 owner 校验）
// mock 系统边界：prisma（serviceTicket 查询 + count）
// 核心契约：
// - 详情归属失败统一 404 TICKET_NOT_FOUND（防工单号枚举，与 F2 订单策略一致）
// - 列表返回 lastMessage 预览（最近一条）+ 用户名，按 updatedAt desc
// - 详情线程按时间升序，lastMessage = 最后一条

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    serviceTicket: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
  },
}));

import { prisma } from "@/shared/db/client";
import { ERROR_CODES } from "@/shared/errors/errors";
import { listMyTickets, getTicketDetail } from "@/features/service/service.queries";

const ticketFindMany = prisma.serviceTicket.findMany as Mock;
const ticketFindFirst = prisma.serviceTicket.findFirst as Mock;
const ticketCount = prisma.serviceTicket.count as Mock;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listMyTickets", () => {
  it("返回列表 + 总数 + 最近一条消息预览", async () => {
    ticketFindMany.mockResolvedValue([
      {
        id: "ticket-1",
        title: "咨询发货",
        category: "AFTERSALE",
        status: "OPEN",
        orderId: null,
        productId: null,
        createdAt: new Date("2026-08-01"),
        updatedAt: new Date("2026-08-02"),
        user: { nickname: "小明" },
        messages: [
          { id: "m1", senderRole: "USER", content: "在吗", createdAt: new Date("2026-08-02") },
        ],
      },
    ]);
    ticketCount.mockResolvedValue(1);

    const result = await listMyTickets("user-1", 1, 20);

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: "ticket-1",
      userName: "小明",
      category: "AFTERSALE",
      status: "OPEN",
      lastMessage: { id: "m1", senderRole: "USER", content: "在吗" },
    });
    // 按最近动态排序
    expect(ticketFindMany.mock.calls[0][0].orderBy).toEqual({ updatedAt: "desc" });
    // 只查本人工单
    expect(ticketFindMany.mock.calls[0][0].where).toEqual({ userId: "user-1" });
  });

  it("匿名工单（用户已注销）→ userName 置空，不崩", async () => {
    ticketFindMany.mockResolvedValue([
      {
        id: "ticket-2",
        title: "遗留工单",
        category: "OTHER",
        status: "RESOLVED",
        orderId: null,
        productId: null,
        createdAt: new Date("2026-07-01"),
        updatedAt: new Date("2026-07-02"),
        user: null,
        messages: [],
      },
    ]);
    ticketCount.mockResolvedValue(1);

    const result = await listMyTickets("user-1", 1, 20);
    expect(result.items[0].userName).toBeNull();
    expect(result.items[0].lastMessage).toBeNull();
  });
});

describe("getTicketDetail — owner 校验（id + userId 复合 where）", () => {
  it("工单不存在 → TICKET_NOT_FOUND", async () => {
    ticketFindFirst.mockResolvedValue(null);

    await expect(getTicketDetail("user-1", "nope")).rejects.toMatchObject({
      code: ERROR_CODES.TICKET_NOT_FOUND.code,
    });
  });

  it("非本人（复合 where 命中 0 行）→ TICKET_NOT_FOUND（防工单号枚举）", async () => {
    ticketFindFirst.mockResolvedValue(null);

    await expect(getTicketDetail("user-1", "ticket-1")).rejects.toMatchObject({
      code: ERROR_CODES.TICKET_NOT_FOUND.code,
    });
    // 归属条件在查询层：where = { id, userId }，不返回 userId 内部字段
    expect(ticketFindFirst.mock.calls[0][0].where).toEqual({
      id: "ticket-1",
      userId: "user-1",
    });
    expect(ticketFindFirst.mock.calls[0][0].select).not.toHaveProperty("userId");
  });

  it("本人 → 返回详情，线程按时间升序，lastMessage = 最后一条", async () => {
    ticketFindFirst.mockResolvedValue({
      id: "ticket-1",
      userId: "user-1",
      title: "咨询发货",
      category: "AFTERSALE",
      status: "PROCESSING",
      orderId: "order-1",
      productId: null,
      createdAt: new Date("2026-08-01"),
      updatedAt: new Date("2026-08-03"),
      user: { nickname: "小明" },
      messages: [
        { id: "m1", senderRole: "USER", content: "在吗", createdAt: new Date("2026-08-01") },
        { id: "m2", senderRole: "CUSTOMER_SERVICE", content: "您好，为您查询", createdAt: new Date("2026-08-03") },
      ],
    });

    const detail = await getTicketDetail("user-1", "ticket-1");

    expect(detail.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(detail.lastMessage?.id).toBe("m2");
    expect(detail.userName).toBe("小明");
    expect(detail.orderId).toBe("order-1");
    // 线程升序查询
    expect(ticketFindFirst.mock.calls[0][0].select.messages.orderBy).toEqual({
      createdAt: "asc",
    });
  });
});
