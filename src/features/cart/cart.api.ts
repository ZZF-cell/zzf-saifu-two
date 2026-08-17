// 购物车 API Route Handlers（需登录）
import { NextResponse } from "next/server";
import { z } from "zod";
import { withValidation, apiError } from "@/shared/utils/api";
import { authenticate } from "@/shared/api/auth";
import * as cartService from "./cart.service";

// ── Schemas ──

// F6 qty 上限：与下单 MAX_ORDER_ITEM_QTY(999) 对齐，防无界数量累加造成
// stock/sales Int4 溢出（add 为 best-effort，展示时 getCart 按实时库存钳制）。
const CART_ITEM_QTY_MAX = 999;

const addSchema = z.object({
  productId: z.string().min(1),
  qty: z.number().int().min(1).max(CART_ITEM_QTY_MAX).optional(),
});

const updateSchema = z.object({
  productId: z.string().min(1),
  qty: z.number().int().min(1).max(CART_ITEM_QTY_MAX),
});

const removeSchema = z.object({
  productId: z.string().min(1),
});

// ── Route Handlers ──

/** GET /api/cart */
export async function getCart(req: Request) {
  try {
    const userId = await authenticate(req);
    const cart = await cartService.getCart(userId);
    return NextResponse.json(cart);
  } catch (error) {
    return apiError(error);
  }
}

/** POST /api/cart — 添加商品 */
export const addToCart = withValidation(
  addSchema,
  async ({ productId, qty }, req) => {
    const userId = await authenticate(req);
    await cartService.addToCart(userId, productId, qty ?? 1);
    return NextResponse.json({ success: true });
  },
);

/** PATCH /api/cart — 修改数量 */
export const updateCart = withValidation(
  updateSchema,
  async ({ productId, qty }, req) => {
    const userId = await authenticate(req);
    await cartService.updateCartQty(userId, productId, qty);
    return NextResponse.json({ success: true });
  },
);

/** DELETE /api/cart — 删除商品 */
export const removeFromCart = withValidation(
  removeSchema,
  async ({ productId }, req) => {
    const userId = await authenticate(req);
    await cartService.removeFromCart(userId, productId);
    return NextResponse.json({ success: true });
  },
);
