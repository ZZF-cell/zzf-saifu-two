// 购物车 API Route Handlers（需登录）
import { NextResponse } from "next/server";
import { z } from "zod";
import { withValidation, apiError } from "@/shared/utils/api";
import { authenticate } from "@/shared/api/auth";
import * as cartService from "./cart.service";

// ── Schemas ──

const addSchema = z.object({
  productId: z.string().min(1),
  qty: z.number().int().min(1).optional(),
});

const updateSchema = z.object({
  productId: z.string().min(1),
  qty: z.number().int().min(1),
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
