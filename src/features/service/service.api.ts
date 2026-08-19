// 咨询工单 API Route Handlers（用户端 + 客服端）
import { NextResponse } from "next/server";
import { z } from "zod";
import { withValidation, apiError, parsePagination } from "@/shared/utils/api";
import { authenticate, requireRole, SERVICE_ROLES } from "@/shared/api/auth";
import {
  createTicket,
  addUserMessage,
  addCsMessage,
  markTicketRead,
  updateTicketStatus,
} from "./service.service";
import {
  listMyTickets,
  getTicketDetail,
  listAllTickets,
  getTicketDetailAdmin,
} from "./service.queries";

// ── Schemas ──

const createTicketSchema = z.object({
  title: z.string().trim().min(1, "咨询主题不能为空").max(60, "主题最长 60 个字符"),
  category: z.enum(["PRESALE", "AFTERSALE", "OTHER"]),
  content: z.string().trim().min(1, "咨询内容不能为空").max(2000, "内容最长 2000 字"),
  orderId: z.string().optional().nullable(),
  productId: z.string().optional().nullable(),
});

const messageSchema = z.object({
  content: z.string().trim().min(1, "回复内容不能为空").max(2000, "内容最长 2000 字"),
});

const updateTicketStatusSchema = z.object({
  status: z.enum(["OPEN", "PROCESSING", "RESOLVED", "CLOSED"]),
});

// ── Route Handlers（用户端） ──

/** POST /api/tickets — 提交咨询工单 */
export const createTicketHandler = withValidation(
  createTicketSchema,
  async (data, req) => {
    const userId = await authenticate(req);
    const result = await createTicket(userId, data);
    return NextResponse.json(result, { status: 201 });
  },
);

/** GET /api/tickets — 我的咨询列表 */
export async function listMyTicketsHandler(req: Request) {
  try {
    const userId = await authenticate(req);
    const { page, pageSize } = parsePagination(new URL(req.url));
    const result = await listMyTickets(userId, page, pageSize);
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}

/** GET /api/tickets/[id] — 工单详情（owner 校验） */
export async function getTicketDetailHandler(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await authenticate(req);
    const { id } = await ctx.params;
    const detail = await getTicketDetail(userId, id);
    return NextResponse.json(detail);
  } catch (error) {
    return apiError(error);
  }
}

/** POST /api/tickets/[id]/messages — 用户回复（CLOSED 工单拒绝） */
export async function addUserMessageHandler(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await authenticate(req);
    const { id } = await ctx.params;

    const body = await req.json().catch(() => null);
    const parsed = messageSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "请求参数不符合预期" },
        { status: 422 },
      );
    }

    await addUserMessage(userId, id, parsed.data.content);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

// ── Route Handlers（客服端，requireRole SERVICE_ROLES） ──

/** GET /api/service/tickets — 全部工单（status/category/keyword 筛选） */
export async function listAllTicketsHandler(req: Request) {
  try {
    await requireRole(req, SERVICE_ROLES);
    const url = new URL(req.url);
    const { page, pageSize } = parsePagination(url);
    const status = url.searchParams.get("status") || undefined;
    const category = url.searchParams.get("category") || undefined;
    const keyword = url.searchParams.get("keyword")?.trim() || undefined;
    const result = await listAllTickets({ status, category, keyword, page, pageSize });
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}

/** GET /api/service/tickets/[id] — 工单详情（客服）；打开即置已读 */
export async function getTicketDetailAdminHandler(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireRole(req, SERVICE_ROLES);
    const { id } = await ctx.params;
    const detail = await getTicketDetailAdmin(id);
    // 客服打开即视为已读（未读角标清除）；失败不阻断详情返回
    await markTicketRead(id).catch(() => null);
    return NextResponse.json(detail);
  } catch (error) {
    return apiError(error);
  }
}

/** POST /api/service/tickets/[id]/messages — 客服回复 */
export async function addCsMessageHandler(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const cs = await requireRole(req, SERVICE_ROLES);
    const { id } = await ctx.params;

    const body = await req.json().catch(() => null);
    const parsed = messageSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "请求参数不符合预期" },
        { status: 422 },
      );
    }

    await addCsMessage(cs.userId, cs.role, id, parsed.data.content);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

/** PATCH /api/service/tickets/[id] — 客服变更工单状态 */
export async function updateTicketStatusHandler(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireRole(req, SERVICE_ROLES);
    const { id } = await ctx.params;

    const body = await req.json().catch(() => null);
    const parsed = updateTicketStatusSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "请求参数不符合预期" },
        { status: 422 },
      );
    }

    await updateTicketStatus(id, parsed.data.status);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}
