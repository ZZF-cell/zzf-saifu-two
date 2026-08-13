// 品牌方后台 API Route Handlers（需 BRAND 或 ADMIN 角色 + 品牌归属校验）
import { NextResponse } from "next/server";
import { z } from "zod";
import { withValidation, apiError, parsePagination } from "@/shared/utils/api";
import { requireRole } from "@/shared/api/auth";
import { ossImageUrlSchema } from "@/shared/validation/schemas";
import * as brandQueries from "./brand.queries";
import * as brandService from "./brand.service";

// ── Schemas ──

const submitProductSchema = z.object({
  name: z.string().trim().min(1, "商品名称不能为空").max(100),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().min(1, "请填写品类").max(50),
  images: z.array(ossImageUrlSchema).max(5, "最多 5 张图片").optional(),
  // 价格（元）：min 0.01 保证元→分后至少 1 分（0.001 会 round 成 0 分免费商品）；
  // max 21_474_836 保证 ×100 后不超 PostgreSQL Int 上限（2^31-1），防溢出写库报 500
  price: z.number().positive("价格必须大于 0").min(0.01).max(21_474_836),
  stock: z.number().int().min(0, "库存不能为负").max(2_147_483_647), // Int 上限
  specs: z.record(z.string(), z.string()).optional(),
});

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
