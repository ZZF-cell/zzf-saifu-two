// 购物车 API Route Handlers（需登录 + 仅 USER 角色可购物）
import { NextResponse } from "next/server";
import { z } from "zod";
import { withValidation, apiError } from "@/shared/utils/api";
import { requireRole } from "@/shared/api/auth";
import * as cartService from "./cart.service";

// 购物车仅对普通用户（USER）开放：商家/客服/质检/管理员/SUPER 为工作人员账号，
// 前端导航不显示购物车入口，若直接调 API 加购会「加进去但找不到」，故服务端一并
// 守卫返回 403「无权限」（游客仍走 401 → 前端跳登录，标准电商行为）。
const CART_ROLES = ["USER"] as const;

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
    const { userId } = await requireRole(req, CART_ROLES);
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
    const { userId } = await requireRole(req, CART_ROLES);
    await cartService.addToCart(userId, productId, qty ?? 1);
    return NextResponse.json({ success: true });
  },
);

/** PATCH /api/cart — 修改数量 */
export const updateCart = withValidation(
  updateSchema,
  async ({ productId, qty }, req) => {
    const { userId } = await requireRole(req, CART_ROLES);
    await cartService.updateCartQty(userId, productId, qty);
    return NextResponse.json({ success: true });
  },
);

/** DELETE /api/cart — 删除商品 */
export const removeFromCart = withValidation(
  removeSchema,
  async ({ productId }, req) => {
    const { userId } = await requireRole(req, CART_ROLES);
    await cartService.removeFromCart(userId, productId);
    return NextResponse.json({ success: true });
  },
);
