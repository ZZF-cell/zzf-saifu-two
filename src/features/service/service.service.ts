// 咨询工单写入操作（CQS：本文件只写不读）
import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import type { TicketCategory } from "./service.types";

// ── 状态常量 ──
export const TICKET_STATUS = {
  OPEN: "OPEN",
  PROCESSING: "PROCESSING",
  RESOLVED: "RESOLVED",
  CLOSED: "CLOSED",
} as const;

export interface CreateTicketInput {
  title: string;
  category: TicketCategory;
  content: string;
  orderId?: string | null;
  productId?: string | null;
}

// ── 提交咨询工单（用户） ──

export async function createTicket(
  userId: string,
  input: CreateTicketInput,
): Promise<{ id: string }> {
  // 关联订单归属校验：售后工单只能绑定本人的订单（防挂他人订单号）
  if (input.orderId) {
    const order = await prisma.order.findUnique({
      where: { id: input.orderId },
      select: { userId: true },
    });
    // F2 归属失败统一 404（防订单号枚举）
    if (!order || order.userId !== userId) {
      throw new AppError(ERROR_CODES.ORDER_NOT_FOUND, "关联订单不存在");
    }
  }

  // 首条消息与工单同事务创建（消息必随工单而生，不会出现"空线程工单"）
  const ticket = await prisma.serviceTicket.create({
    data: {
      userId,
      title: input.title,
      category: input.category,
      orderId: input.orderId ?? null,
      productId: input.productId ?? null,
      messages: {
        create: {
          senderId: userId,
          senderRole: "USER", // 客户侧发言统一 USER（快照）
          content: input.content,
        },
      },
    },
    select: { id: true },
  });

  return ticket;
}

// ── 用户回复 ──

export async function addUserMessage(
  userId: string,
  ticketId: string,
  content: string,
): Promise<void> {
  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    select: { userId: true, status: true },
  });

  if (!ticket) throw new AppError(ERROR_CODES.TICKET_NOT_FOUND, "工单不存在");
  // 归属失败统一 404（防工单号枚举），与 F2 订单策略一致
  if (ticket.userId !== userId) {
    throw new AppError(ERROR_CODES.TICKET_NOT_FOUND, "工单不存在");
  }
  if (ticket.status === TICKET_STATUS.CLOSED) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "工单已关闭，无法回复");
  }

  await prisma.$transaction(async (tx) => {
    await tx.serviceTicketMessage.create({
      data: {
        ticketId,
        senderId: userId,
        senderRole: "USER", // 快照
        content,
        isRead: false, // 客服未读
      },
    });

    // RESOLVED 下用户再回复 → 重开为 PROCESSING（客服仍需跟进）；
    // 显式 bump updatedAt → 列表按最近动态排序
    await tx.serviceTicket.update({
      where: { id: ticketId },
      data: {
        ...(ticket.status === TICKET_STATUS.RESOLVED
          ? { status: TICKET_STATUS.PROCESSING, closedAt: null }
          : {}),
        updatedAt: new Date(),
      },
    });
  });
}
