// service.service 单元测试 — 咨询工单写入（创建 + 用户回复）
// mock 系统边界：prisma（order/serviceTicket/serviceTicketMessage + 交互事务）
// 核心契约：
// - 创建工单时关联订单必须归属本人（非本人 → 404 ORDER_NOT_FOUND 防枚举）
// - 首条消息与工单同事务创建（不存在"空线程工单"）
// - 回复归属失败统一 404 TICKET_NOT_FOUND（防工单号枚举）
// - CLOSED 工单拒绝回复；RESOLVED 下用户再回复 → 重开 PROCESSING
// - 每次回复 bump updatedAt（列表按最近动态排序）

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@/shared/db/client", () => ({
  prisma: {
    order: { findUnique: vi.fn() },
    serviceTicket: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    serviceTicketMessage: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "@/shared/db/client";
import { ERROR_CODES } from "@/shared/errors/errors";
import { createTicket, addUserMessage } from "@/features/service/service.service";

type Tx = {
  serviceTicketMessage: { create: ReturnType<typeof vi.fn> };
  serviceTicket: { update: ReturnType<typeof vi.fn> };
};

const tx: Tx = {
  serviceTicketMessage: { create: vi.fn() },
  serviceTicket: { update: vi.fn() },
};

const orderFindUnique = prisma.order.findUnique as Mock;
const ticketFindUnique = prisma.serviceTicket.findUnique as Mock;
const ticketCreate = prisma.serviceTicket.create as Mock;
const transaction = prisma.$transaction as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  transaction.mockImplementation((fn: (t: Tx) => Promise<unknown>) => fn(tx));
  ticketCreate.mockResolvedValue({ id: "ticket-1" });
  tx.serviceTicketMessage.create.mockResolvedValue({});
  tx.serviceTicket.update.mockResolvedValue({});
});

describe("createTicket — 提交咨询工单", () => {
  it("无关联订单 → 直接创建工单 + 首条消息（同一 create 调用）", async () => {
    const result = await createTicket("user-1", {
      title: "什么时候发货",
      category: "AFTERSALE",
      content: "订单已支付但没动静",
    });

    expect(result).toEqual({ id: "ticket-1" });
    expect(orderFindUnique).not.toHaveBeenCalled();
    expect(ticketCreate).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        title: "什么时候发货",
        category: "AFTERSALE",
        orderId: null,
        productId: null,
        messages: {
          create: {
            senderId: "user-1",
            senderRole: "USER",
            content: "订单已支付但没动静",
          },
        },
      },
      select: { id: true },
    });
  });

  it("有关联订单且非本人 → ORDER_NOT_FOUND（防挂他人订单号）", async () => {
    orderFindUnique.mockResolvedValue({ userId: "other-user" });

    await expect(
      createTicket("user-1", {
        title: "t",
        category: "AFTERSALE",
        content: "c",
        orderId: "order-9",
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.ORDER_NOT_FOUND.code });
    expect(ticketCreate).not.toHaveBeenCalled();
  });

  it("有关联订单且本人 → 校验通过后创建并携带 orderId", async () => {
    orderFindUnique.mockResolvedValue({ userId: "user-1" });

    await createTicket("user-1", {
      title: "t",
      category: "AFTERSALE",
      content: "c",
      orderId: "order-1",
    });

    expect(ticketCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orderId: "order-1" }),
      }),
    );
  });
});

describe("addUserMessage — 用户回复", () => {
  it("工单不存在 → TICKET_NOT_FOUND", async () => {
    ticketFindUnique.mockResolvedValue(null);

    await expect(addUserMessage("user-1", "nope", "hi")).rejects.toMatchObject({
      code: ERROR_CODES.TICKET_NOT_FOUND.code,
    });
  });

  it("非本人访问 → TICKET_NOT_FOUND（防枚举，归属失败统一 404）", async () => {
    ticketFindUnique.mockResolvedValue({ userId: "other", status: "OPEN" });

    await expect(addUserMessage("user-1", "ticket-1", "在吗")).rejects.toMatchObject({
      code: ERROR_CODES.TICKET_NOT_FOUND.code,
    });
    expect(tx.serviceTicketMessage.create).not.toHaveBeenCalled();
  });

  it("CLOSED 工单 → VALIDATION_ERROR 拒绝回复", async () => {
    ticketFindUnique.mockResolvedValue({ userId: "user-1", status: "CLOSED" });

    await expect(addUserMessage("user-1", "ticket-1", "在吗")).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR.code,
    });
    expect(tx.serviceTicketMessage.create).not.toHaveBeenCalled();
  });

  it("OPEN 工单 → 新增消息（isRead=false 客服未读）+ bump updatedAt，状态不变", async () => {
    ticketFindUnique.mockResolvedValue({ userId: "user-1", status: "OPEN" });

    await addUserMessage("user-1", "ticket-1", "在吗");

    expect(tx.serviceTicketMessage.create).toHaveBeenCalledWith({
      data: {
        ticketId: "ticket-1",
        senderId: "user-1",
        senderRole: "USER",
        content: "在吗",
        isRead: false,
      },
    });
    expect(tx.serviceTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ticket-1" },
        data: expect.objectContaining({ updatedAt: expect.any(Date) }),
      }),
    );
    // 非 RESOLVED：data 中不带 status / closedAt
    expect(tx.serviceTicket.update.mock.calls[0][0].data).not.toHaveProperty("status");
  });

  it("RESOLVED 工单用户再回复 → 重开 PROCESSING（closedAt 置空）", async () => {
    ticketFindUnique.mockResolvedValue({ userId: "user-1", status: "RESOLVED" });

    await addUserMessage("user-1", "ticket-1", "还没解决");

    expect(tx.serviceTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ticket-1" },
        data: expect.objectContaining({ status: "PROCESSING", closedAt: null }),
      }),
    );
  });
});
