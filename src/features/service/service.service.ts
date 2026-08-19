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

/** 状态流转表：仅允许显式定义的前进/重开路径，非法跳转 422 */
const TICKET_TRANSITIONS: Record<string, readonly string[]> = {
  [TICKET_STATUS.OPEN]: [TICKET_STATUS.PROCESSING, TICKET_STATUS.RESOLVED, TICKET_STATUS.CLOSED],
  [TICKET_STATUS.PROCESSING]: [TICKET_STATUS.RESOLVED, TICKET_STATUS.CLOSED],
  [TICKET_STATUS.RESOLVED]: [TICKET_STATUS.PROCESSING, TICKET_STATUS.CLOSED],
  // 误关重开：CLOSED → OPEN / PROCESSING 允许客服重新打开
  [TICKET_STATUS.CLOSED]: [TICKET_STATUS.OPEN, TICKET_STATUS.PROCESSING],
};

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

// ── 客服写入 ──

/** 客服回复：新增消息（角色快照）+ 用户消息全部置已读 + bump updatedAt；OPEN 首回自动转 PROCESSING */
export async function addCsMessage(
  csId: string,
  csRole: string,
  ticketId: string,
  content: string,
): Promise<void> {
  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    select: { status: true },
  });
  if (!ticket) throw new AppError(ERROR_CODES.TICKET_NOT_FOUND, "工单不存在");

  await prisma.$transaction(async (tx) => {
    await tx.serviceTicketMessage.create({
      data: {
        ticketId,
        senderId: csId,
        senderRole: csRole, // CUSTOMER_SERVICE | ADMIN | SUPER 快照
        content,
        isRead: true, // 客服自己的发言无需再读
      },
    });
    // 客服回复视为已读全部用户消息（未读标记清除）
    await tx.serviceTicketMessage.updateMany({
      where: { ticketId, senderRole: "USER", isRead: false },
      data: { isRead: true },
    });
    await tx.serviceTicket.update({
      where: { id: ticketId },
      data: {
        // OPEN 工单客服接手回复 → 自动转 PROCESSING，减少一次手动点选
        ...(ticket.status === TICKET_STATUS.OPEN
          ? { status: TICKET_STATUS.PROCESSING }
          : {}),
        updatedAt: new Date(),
      },
    });
  });
}

/** 客服打开工单 → 用户消息全部置已读（未读角标清除） */
export async function markTicketRead(ticketId: string): Promise<void> {
  await prisma.serviceTicketMessage.updateMany({
    where: { ticketId, senderRole: "USER", isRead: false },
    data: { isRead: true },
  });
}

/** 客服变更工单状态（校验流转合法性；RESOLVED/CLOSED 写 closedAt，重开清空） */
export async function updateTicketStatus(
  ticketId: string,
  nextStatus: string,
): Promise<void> {
  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    select: { status: true },
  });
  if (!ticket) throw new AppError(ERROR_CODES.TICKET_NOT_FOUND, "工单不存在");

  const allowed = TICKET_TRANSITIONS[ticket.status] ?? [];
  if (!allowed.includes(nextStatus)) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      `工单状态「${ticket.status}」不能直接变更为「${nextStatus}」`,
    );
  }

  const isClosed = nextStatus === TICKET_STATUS.RESOLVED || nextStatus === TICKET_STATUS.CLOSED;
  // updateMany 带当前状态守卫：并发下若状态已变命中 0 行 → 提示刷新，不覆写
  const updated = await prisma.serviceTicket.updateMany({
    where: { id: ticketId, status: ticket.status },
    data: {
      status: nextStatus,
      closedAt: isClosed ? new Date() : null,
    },
  });
  if (updated.count === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "工单状态已变更，请刷新后重试");
  }
}
