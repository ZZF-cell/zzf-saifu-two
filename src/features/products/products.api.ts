// 商品 API Route Handlers
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/shared/utils/api";
import { ERROR_CODES } from "@/shared/errors/errors";
import * as productsService from "./products.service";

// ── Zod Schemas ──

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  category: z.string().optional(),
  subCategory: z.string().optional(),
  search: z.string().optional(),
  sortBy: z.enum(["createdAt", "price", "sales"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

// ── Route Handlers ──

/** GET /api/products — 商品列表（公开，无需认证） */
export async function getProducts(req: Request) {
  try {
    const url = new URL(req.url);
    const rawParams = Object.fromEntries(url.searchParams.entries());
    const parsed = listQuerySchema.safeParse(rawParams);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: ERROR_CODES.VALIDATION_ERROR.code,
          message: "请求参数不符合预期",
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 422 },
      );
    }

    const result = await productsService.getProductList(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}

/** GET /api/products/categories — 品类列表（公开） */
export async function getCategories() {
  try {
    const categories = await productsService.getCategories();
    return NextResponse.json({ categories });
  } catch (error) {
    return apiError(error);
  }
}

/** GET /api/products/[id] — 商品详情（公开） */
export async function getProductById(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const product = await productsService.requireProductById(id);
    return NextResponse.json(product);
  } catch (error) {
    return apiError(error);
  }
}
