// 品牌方后台 API Route Handlers（需 BRAND 或 ADMIN 角色 + 品牌归属校验）
import { NextResponse } from "next/server";
import { z } from "zod";
import { withValidation, apiError, parsePagination } from "@/shared/utils/api";
import { requireRole } from "@/shared/api/auth";
import { ERROR_CODES } from "@/shared/errors/errors";
import { ossImageUrlSchema } from "@/shared/validation/schemas";
import { productFields, categoryPairRefine, updateProductSchema } from "@/shared/validation/product";
import * as brandQueries from "./brand.queries";
import * as brandService from "./brand.service";

// ── Schemas ──
// 字段约束统一来自 shared/validation/product（submit 全量必填，update 部分可选）

export const submitProductSchema = z
  .object(productFields)
  .superRefine(categoryPairRefine);

// ── 品牌归属（所有品牌接口先取当前用户品牌） ──
// 仅 BRAND 角色：品牌中心是品牌方自己的后台，ADMIN 看订单/商品走 /api/admin；
// 若放行 ADMIN 再 getBrandByOwner 必然 404（管理员不拥有品牌），与宣称角色矛盾。

async function requireBrand(req: Request) {
  const user = await requireRole(req, ["BRAND"]);
  const brand = await brandQueries.getBrandByOwner(user.userId);
  return { brand, user };
}

// ── 品牌概览 ──

export async function getOverview(req: Request) {
  try {
    const { brand } = await requireBrand(req);
    const overview = await brandQueries.getBrandOverview(brand.id);
    return NextResponse.json(overview);
  } catch (error) {
    return apiError(error);
  }
}

// ── 品牌商品列表 ──

export async function getProducts(req: Request) {
  try {
    const { brand } = await requireBrand(req);
    const { page, pageSize } = parsePagination(new URL(req.url));
    const result = await brandQueries.getBrandProducts(brand.id, page, pageSize);
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}

// ── 提交新商品 ──

export const submitProduct = withValidation(
  submitProductSchema,
  async (data, req) => {
    const { brand } = await requireBrand(req);
    const result = await brandService.submitProduct(brand.id, data);
    return NextResponse.json(result, { status: 201 });
  },
);

// ── 商品撤回 / 下架 / 重新上架（参数路由，手动解析，归属由 requireBrand + service 双重守卫） ──

/** POST /api/brand/products/[id]/withdraw — 撤回待审提交（PENDING → WITHDRAWN） */
export async function withdrawProduct(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { brand, user } = await requireBrand(req);
    const { id } = await ctx.params;
    await brandService.withdrawProduct(brand.id, id, user.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

/** POST /api/brand/products/[id]/delist — 下架（APPROVED → DELISTED） */
export async function delistProduct(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { brand, user } = await requireBrand(req);
    const { id } = await ctx.params;
    await brandService.delistProduct(brand.id, id, user.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

/** POST /api/brand/products/[id]/relist — 重新上架（DELISTED → APPROVED，不重质检） */
export async function relistProduct(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { brand, user } = await requireBrand(req);
    const { id } = await ctx.params;
    await brandService.relistProduct(brand.id, id, user.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

/**
 * PATCH /api/brand/products/[id] — 编辑商品
 * 基本信息变更 → 已上架/已下架回待质检、拒绝/撤回重新提交；仅运营信息（价格/库存）→ 直改
 * 参数路由无法复用 withValidation（其 handler 只收 (data, req)），手动 req.json + safeParse
 */
export async function updateProduct(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { brand, user } = await requireBrand(req);
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = updateProductSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: ERROR_CODES.VALIDATION_ERROR.code, message: "请求参数不符合预期" },
        { status: 422 },
      );
    }
    const result = await brandService.updateProduct(brand.id, id, parsed.data, user.userId);
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}

// ── 更新品牌资料（名称/logo） ──

const updateProfileSchema = z.object({
  name: z.string().trim().min(1, "品牌名称不能为空").max(50).optional(),
  logo: ossImageUrlSchema.optional(),
});

/** PUT /api/brand/profile — 更新品牌资料（品牌归属校验在 requireBrand） */
export const updateProfile = withValidation(
  updateProfileSchema,
  async (data, req) => {
    const { brand } = await requireBrand(req);
    await brandService.updateBrandProfile(brand.id, data);
    return NextResponse.json({ success: true });
  },
);

// ── 品牌订单列表 ──

export async function getOrders(req: Request) {
  try {
    const { brand } = await requireBrand(req);
    const { page, pageSize } = parsePagination(new URL(req.url));
    const result = await brandQueries.getBrandOrders(brand.id, page, pageSize);
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}
