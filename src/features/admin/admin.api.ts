// 管理后台 API Route Handlers（ADMIN + SUPER；订单售后另开放 CUSTOMER_SERVICE；
// 商品质检/质检模板已按职责移入质检中心，守卫为 INSPECT_ROLES）
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, withValidation, parsePagination } from "@/shared/utils/api";
import { ERROR_CODES } from "@/shared/errors/errors";
import { requireRole, ADMIN_ROLES, AFTERSALES_ROLES, INSPECT_ROLES } from "@/shared/api/auth";
import { updateProductSchema } from "@/shared/validation/product";
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

const generateInviteSchema = z.object({
  count: z.number().int().min(1, "数量至少为 1").max(100, "单次最多生成 100 个"),
  expiresAt: z
    .string()
    .datetime({ message: "过期时间格式错误（需 ISO 时间字符串）" })
    .nullable()
    .optional()
    .refine((v) => !v || new Date(v).getTime() > Date.now(), "过期时间需晚于当前时间"),
});

/**
 * 审核操作统一处理（品牌审核/商品质检共用，roles 由调用方指定：
 * 品牌审核 ADMIN_ROLES，商品质检 INSPECT_ROLES — 职责彻底隔离）
 * 参数路由（[id]）无法复用 withValidation（其 handler 只收 (data, req)），
 * 此处手动解析 body + zod 校验，与 orders.api 参数路由同一模式
 */
async function handleReview(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
  roles: readonly string[],
  action: (id: string, decision: ReviewDecision, operatorId: string) => Promise<void>,
): Promise<NextResponse> {
  try {
    const admin = await requireRole(req, roles);
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
    await requireRole(req, ADMIN_ROLES);
    const stats = await adminQueries.getDashboardStats();
    return NextResponse.json(stats);
  } catch (error) {
    return apiError(error);
  }
}

// ── 品牌审核 ──

export async function getBrands(req: Request) {
  try {
    await requireRole(req, ADMIN_ROLES);
    const url = new URL(req.url);
    const status = url.searchParams.get("status") || undefined;
    const brands = await adminQueries.getAdminBrands(status);
    return NextResponse.json({ items: brands });
  } catch (error) {
    return apiError(error);
  }
}

export function reviewBrand(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleReview(req, ctx, ADMIN_ROLES, adminService.reviewBrand);
}

// ── 删除审核拒绝的品牌（仅 REJECTED；删除后商家可重新用新邀请码入驻） ──

export async function deleteBrand(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireRole(req, ADMIN_ROLES);
    const { id } = await ctx.params;
    await adminService.deleteBrand(id, admin.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

// ── 商品质检（守卫 INSPECT_ROLES：质检员/最高权限者，与 /inspect 质检中心职责对应） ──

export async function getProducts(req: Request) {
  try {
    await requireRole(req, INSPECT_ROLES);
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
  return handleReview(req, ctx, INSPECT_ROLES, adminService.reviewProduct);
}

// ── 商品生命周期（下架/重新上架/编辑，与品牌方同一套状态机，操作人是质检员） ──

/** GET /api/admin/products/[id] — 审核/管理详情（完整信息 + 该品类质检清单） */
export async function getProductDetail(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireRole(req, INSPECT_ROLES);
    const { id } = await ctx.params;
    const detail = await adminQueries.getAdminProductDetail(id);
    if (!detail) {
      return NextResponse.json(
        { error: ERROR_CODES.PRODUCT_NOT_FOUND.code, message: "商品不存在" },
        { status: 404 },
      );
    }
    return NextResponse.json(detail);
  } catch (error) {
    return apiError(error);
  }
}

/** POST /api/admin/products/[id]/delist — 下架（APPROVED → DELISTED） */
export async function delistProduct(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireRole(req, INSPECT_ROLES);
    const { id } = await ctx.params;
    await adminService.delistProduct(id, admin.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

/** POST /api/admin/products/[id]/relist — 重新上架（DELISTED → APPROVED，不重质检） */
export async function relistProduct(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireRole(req, INSPECT_ROLES);
    const { id } = await ctx.params;
    await adminService.relistProduct(id, admin.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

/**
 * PATCH /api/admin/products/[id] — 编辑商品
 * 与品牌方同规则：改基本信息 → 回 PENDING 重审；仅改价格/库存 → 直改
 */
export async function updateProduct(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireRole(req, INSPECT_ROLES);
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = updateProductSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: ERROR_CODES.VALIDATION_ERROR.code, message: "请求参数不符合预期" },
        { status: 422 },
      );
    }
    const result = await adminService.updateProduct(id, parsed.data, admin.userId);
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}

// ── 订单管理 ──

export async function getOrders(req: Request) {
  try {
    await requireRole(req, AFTERSALES_ROLES);
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
    const admin = await requireRole(req, AFTERSALES_ROLES);
    const { id } = await ctx.params;
    await adminService.shipOrder(id, admin.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

export async function deliverOrder(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireRole(req, AFTERSALES_ROLES);
    const { id } = await ctx.params;
    await adminService.deliverOrder(id, admin.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

export async function completeOrder(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireRole(req, AFTERSALES_ROLES);
    const { id } = await ctx.params;
    await adminService.completeOrder(id, admin.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

export async function confirmRefund(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireRole(req, AFTERSALES_ROLES);
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
    await requireRole(req, ADMIN_ROLES);
    const url = new URL(req.url);
    const { page, pageSize } = parsePagination(url);
    const result = await adminQueries.getAdminUsers({ page, pageSize });
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}

// ── 质检模板（守卫 INSPECT_ROLES：质检员/最高权限者） ──

export async function getAuditTemplates(req: Request) {
  try {
    await requireRole(req, INSPECT_ROLES);
    const templates = await adminQueries.getAuditTemplates();
    return NextResponse.json({ items: templates });
  } catch (error) {
    return apiError(error);
  }
}

export const upsertAuditTemplate = withValidation(
  auditTemplateSchema,
  async (data, req) => {
    const admin = await requireRole(req, INSPECT_ROLES);
    await adminService.upsertAuditTemplate(data, admin.userId);
    return NextResponse.json({ success: true });
  },
);

/** DELETE /api/admin/audit-templates?categoryId= — 删除质检模板 */
export async function deleteAuditTemplate(req: Request) {
  try {
    const admin = await requireRole(req, INSPECT_ROLES);
    const url = new URL(req.url);
    const categoryId = url.searchParams.get("categoryId");
    if (!categoryId) {
      return NextResponse.json(
        { error: ERROR_CODES.VALIDATION_ERROR.code, message: "缺少 categoryId 参数" },
        { status: 422 },
      );
    }
    await adminService.deleteAuditTemplate(categoryId, admin.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

// ── 邀请码管理 ──

export async function getInviteCodes(req: Request) {
  try {
    await requireRole(req, ADMIN_ROLES);
    const url = new URL(req.url);
    const { page, pageSize } = parsePagination(url);
    const status = url.searchParams.get("status") || undefined;
    const result = await adminQueries.getAdminInviteCodes({ page, pageSize, status });
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}

export const generateInviteCodes = withValidation(
  generateInviteSchema,
  async (data, req) => {
    const admin = await requireRole(req, ADMIN_ROLES);
    const codes = await adminService.generateInviteCodes(
      { count: data.count, expiresAt: data.expiresAt ? new Date(data.expiresAt) : null },
      admin.userId,
    );
    return NextResponse.json({ success: true, codes });
  },
);

/**
 * POST /api/admin/invite-codes/[code]/revoke — 作废邀请码（L6）
 * 作废 = 置 DISABLED，仅 UNUSED 码可作废；已使用/已作废 → 409，不存在 → 404
 */
export async function revokeInviteCode(req: Request, ctx: { params: Promise<{ code: string }> }) {
  try {
    const admin = await requireRole(req, ADMIN_ROLES);
    const { code } = await ctx.params;
    await adminService.revokeInviteCode(admin.userId, code);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

// ── 用户管理操作 ──

// action 与参数强耦合（discriminatedUnion）：setRole 缺 role / setStatus 缺 status /
// resetPassword 缺 tempPassword 均直接 422，杜绝「缺参进 service → 500 / 假审计」。
// 且 switch 内 TS 能按 action 收窄出必填参数，无需 `!` 断言。
// 可授予角色不含 SUPER（最高权限者账号不可被授予、不可被其他账号操作）
const userActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("setRole"), role: z.enum(["USER", "BRAND", "CUSTOMER_SERVICE", "QUALITY_INSPECTOR", "ADMIN"]) }),
  z.object({ action: z.literal("setStatus"), status: z.enum(["ACTIVE", "DISABLED"]) }),
  z.object({ action: z.literal("unlock") }),
  z.object({ action: z.literal("resetPassword"), tempPassword: z.string().min(6).max(20) }),
  z.object({ action: z.literal("clearAgeVerification") }),
]);

/**
 * PATCH /api/admin/users/[id] — 用户管理操作
 * action 分发：setRole / setStatus / unlock / resetPassword（返回一次临时密码）/ clearAgeVerification
 */
export async function patchUser(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireRole(req, ADMIN_ROLES);
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = userActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: ERROR_CODES.VALIDATION_ERROR.code, message: "请求参数不符合预期" },
        { status: 422 },
      );
    }

    switch (parsed.data.action) {
      case "setRole":
        await adminService.setUserRole(id, parsed.data.role, admin.userId, admin.role);
        break;
      case "setStatus":
        await adminService.setUserStatus(id, parsed.data.status, admin.userId, admin.role);
        break;
      case "unlock":
        await adminService.unlockUser(id, admin.userId, admin.role);
        break;
      case "resetPassword": {
        const result = await adminService.resetPassword(id, parsed.data.tempPassword, admin.userId, admin.role);
        return NextResponse.json({ success: true, tempPassword: result.tempPassword });
      }
      case "clearAgeVerification":
        await adminService.clearAgeVerification(id, admin.userId, admin.role);
        break;
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}
