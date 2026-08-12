// 管理后台 API Route Handlers（仅 ADMIN）
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, withValidation, parsePagination } from "@/shared/utils/api";
import { ERROR_CODES } from "@/shared/errors/errors";
import { requireRole } from "@/shared/api/auth";
import * as adminQueries from "./admin.queries";
import * as adminService from "./admin.service";
import type { ReviewDecision } from "./admin.service";

// ── Schemas ──

const reviewSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
});

const auditTemplateSchema = z.object({
  categoryId: z.string().min(1),
  requiredDocs: z.array(z.string()).optional(),
  checkPoints: z.array(z.string()).optional(),
});

/**
 * 审核操作统一处理（品牌审核/商品质检共用）
 * 参数路由（[id]）无法复用 withValidation（其 handler 只收 (data, req)），
 * 此处手动解析 body + zod 校验，与 orders.api 参数路由同一模式
 */
async function handleReview(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
  action: (id: string, decision: ReviewDecision, operatorId: string) => Promise<void>,
): Promise<NextResponse> {
  try {
    const admin = await requireRole(req, ["ADMIN"]);
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = reviewSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: ERROR_CODES.VALIDATION_ERROR.code, message: "请求参数不符合预期" },
        { status: 422 },
      );
    }
    await action(id, parsed.data.decision, admin.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

// ── 数据看板 ──

export async function getDashboard(req: Request) {
  try {
    await requireRole(req, ["ADMIN"]);
    const stats = await adminQueries.getDashboardStats();
    return NextResponse.json(stats);
  } catch (error) {
    return apiError(error);
  }
}

// ── 品牌审核 ──

export async function getBrands(req: Request) {
  try {
    await requireRole(req, ["ADMIN"]);
    const url = new URL(req.url);
    const status = url.searchParams.get("status") || undefined;
    const brands = await adminQueries.getAdminBrands(status);
    return NextResponse.json({ items: brands });
  } catch (error) {
    return apiError(error);
  }
}

export function reviewBrand(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleReview(req, ctx, adminService.reviewBrand);
}

// ── 商品质检 ──

export async function getProducts(req: Request) {
  try {
    await requireRole(req, ["ADMIN"]);
    const url = new URL(req.url);
    const { page, pageSize } = parsePagination(url);
    const status = url.searchParams.get("status") || undefined;
    const result = await adminQueries.getAdminProducts({ page, pageSize, status });
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}

export function reviewProduct(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleReview(req, ctx, adminService.reviewProduct);
}

// ── 订单管理 ──

export async function getOrders(req: Request) {
  try {
    await requireRole(req, ["ADMIN"]);
    const url = new URL(req.url);
    const { page, pageSize } = parsePagination(url);
    const status = url.searchParams.get("status") || undefined;
    const result = await adminQueries.getAdminOrders({ page, pageSize, status });
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}

export async function shipOrder(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireRole(req, ["ADMIN"]);
    const { id } = await ctx.params;
    await adminService.shipOrder(id, admin.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

export async function deliverOrder(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireRole(req, ["ADMIN"]);
    const { id } = await ctx.params;
    await adminService.deliverOrder(id, admin.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

export async function completeOrder(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireRole(req, ["ADMIN"]);
    const { id } = await ctx.params;
    await adminService.completeOrder(id, admin.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

export async function confirmRefund(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireRole(req, ["ADMIN"]);
    const { id } = await ctx.params;
    await adminService.confirmRefund(id, admin.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

// ── 用户管理 ──

export async function getUsers(req: Request) {
  try {
    await requireRole(req, ["ADMIN"]);
    const url = new URL(req.url);
    const { page, pageSize } = parsePagination(url);
    const result = await adminQueries.getAdminUsers({ page, pageSize });
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}

// ── 质检模板 ──

export async function getAuditTemplates(req: Request) {
  try {
    await requireRole(req, ["ADMIN"]);
    const templates = await adminQueries.getAuditTemplates();
    return NextResponse.json({ items: templates });
  } catch (error) {
    return apiError(error);
  }
}

export const upsertAuditTemplate = withValidation(
  auditTemplateSchema,
  async (data, req) => {
    const admin = await requireRole(req, ["ADMIN"]);
    await adminService.upsertAuditTemplate(data, admin.userId);
    return NextResponse.json({ success: true });
  },
);
