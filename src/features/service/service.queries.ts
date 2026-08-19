// 咨询工单查询（只读）
import { Prisma } from "@prisma/client";
import { prisma } from "@/shared/db/client";
import { AppError, ERROR_CODES } from "@/shared/errors/errors";
import type {
  TicketDetail,
  TicketListResult,
  TicketSummary,
} from "./service.types";

// 列表/详情共用的标量字段（messages 子查询各自定制）
const ticketScalars = {
  id: true,
  title: true,
  category: true,
  status: true,
  orderId: true,
  productId: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { nickname: true } },
} as const;

// ── 我的工单列表 ──

export async function listMyTickets(
  userId: string,
  page: number,
  pageSize: number,
): Promise<TicketListResult> {
  const [rows, total] = await Promise.all([
    prisma.serviceTicket.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        ...ticketScalars,
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1, // 最近一条消息 → 列表预览
          select: { id: true, senderRole: true, content: true, createdAt: true },
        },
      },
    }),
    prisma.serviceTicket.count({ where: { userId } }),
  ]);

  return {
    items: rows.map(toSummary),
    total,
    page,
    pageSize,
  };
}

// ── 工单详情（owner 校验） ──

export async function getTicketDetail(
  userId: string,
  ticketId: string,
): Promise<TicketDetail> {
  // 归属校验下沉到查询 where（id + userId 复合条件）：非本人或不存在
  // 一律命中 0 行 → TICKET_NOT_FOUND，与 F2 订单策略一致（防工单号枚举，
  // 且不返回 userId 内部字段）
  const ticket = await prisma.serviceTicket.findFirst({
    where: { id: ticketId, userId },
    select: {
      ...ticketScalars,
      messages: {
        orderBy: { createdAt: "asc" },
        select: { id: true, senderRole: true, content: true, createdAt: true },
      },
    },
  });

  if (!ticket) {
    throw new AppError(ERROR_CODES.TICKET_NOT_FOUND, "工单不存在");
  }

  const { messages, user, ...rest } = ticket;
  const msgs = messages as TicketDetail["messages"];
  return {
    ...rest,
    category: rest.category as TicketDetail["category"],
    status: rest.status as TicketDetail["status"],
    userName: user?.nickname ?? null,
    lastMessage: msgs[msgs.length - 1] ?? null,
    messages: msgs,
    // 用户侧不跟踪自己未读（isRead 只标记客服已读），恒 0
    unreadCount: 0,
  };
}

// ── 全部工单列表（客服工作台） ──

export async function listAllTickets(params: {
  status?: string;
  category?: string;
  keyword?: string;
  page: number;
  pageSize: number;
}): Promise<TicketListResult> {
  const { status, category, keyword, page, pageSize } = params;

  const where: Prisma.ServiceTicketWhereInput = {
    ...(status ? { status } : {}),
    ...(category ? { category } : {}),
    ...(keyword
      ? {
          OR: [
            { title: { contains: keyword, mode: "insensitive" } },
            { id: { contains: keyword } }, // 支持直接粘贴工单号
          ],
        }
      : {}),
  };

  // unreadCount 单独 groupBy 统计（isRead=false 且来自用户），
  // 与 lastMessage 子查询互斥，拆两条查询避免 N+1
  const [rows, total, unreadRows] = await Promise.all([
    prisma.serviceTicket.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        ...ticketScalars,
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, senderRole: true, content: true, createdAt: true },
        },
      },
    }),
    prisma.serviceTicket.count({ where }),
    prisma.serviceTicketMessage.groupBy({
      by: ["ticketId"],
      where: { isRead: false, senderRole: "USER" },
      _count: { _all: true },
    }),
  ]);

  const unreadMap = new Map(unreadRows.map((g) => [g.ticketId, g._count._all]));

  return {
    items: rows.map((row) => toSummary(row, unreadMap.get(row.id) ?? 0)),
    total,
    page,
    pageSize,
  };
}

// ── 工单详情（客服，无归属校验） ──

export async function getTicketDetailAdmin(ticketId: string): Promise<TicketDetail> {
  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    select: {
      ...ticketScalars,
      messages: {
        orderBy: { createdAt: "asc" },
        select: { id: true, senderRole: true, content: true, createdAt: true },
      },
    },
  });

  if (!ticket) {
    throw new AppError(ERROR_CODES.TICKET_NOT_FOUND, "工单不存在");
  }

  const unreadCount = await prisma.serviceTicketMessage.count({
    where: { ticketId, senderRole: "USER", isRead: false },
  });

  const { messages, user, ...rest } = ticket;
  const msgs = messages as TicketDetail["messages"];
  return {
    ...rest,
    category: rest.category as TicketDetail["category"],
    status: rest.status as TicketDetail["status"],
    userName: user?.nickname ?? null,
    lastMessage: msgs[msgs.length - 1] ?? null,
    unreadCount,
    messages: msgs,
  };
}

// ── 行 → 摘要转换 ──

type TicketRow = {
  id: string;
  title: string;
  category: string;
  status: string;
  orderId: string | null;
  productId: string | null;
  createdAt: Date;
  updatedAt: Date;
  user: { nickname: string | null } | null;
  messages: Array<{ id: string; senderRole: string; content: string; createdAt: Date }>;
};

function toSummary(row: TicketRow, unreadCount = 0): TicketSummary {
  const { user, messages, ...rest } = row;
  return {
    ...rest,
    category: row.category as TicketSummary["category"],
    status: row.status as TicketSummary["status"],
    userName: user?.nickname ?? null,
    lastMessage: messages[0] ?? null,
    unreadCount,
  };
}
