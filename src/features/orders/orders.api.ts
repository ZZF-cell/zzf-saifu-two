// 订单 API Route Handlers（需登录）
import { NextResponse } from "next/server";
import { z } from "zod";
import { withValidation, apiError } from "@/shared/utils/api";
import { ERROR_CODES } from "@/shared/errors/errors";
import { authenticate } from "@/shared/api/auth";
import * as ordersService from "./orders.service";
import * as ordersQueries from "./orders.queries";

// ── Schemas ──

const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        qty: z.number().int().min(1),
      }),
    )
    .min(1, "订单至少包含一个商品"),
  shippingAddress: z.object({
    name: z.string().min(2, "姓名至少 2 个字符").max(50),
    phone: z.string().regex(/^1[3-9]\d{9}$/, "手机号格式不正确"),
    province: z.string().min(1, "请选择省份"),
    city: z.string().min(1, "请选择城市"),
    district: z.string().min(1, "请选择区县"),
    detail: z.string().min(1, "请输入详细地址"),
    zipCode: z.string().optional(),
  }),
  privacy: z.object({
    anonymousPackaging: z.boolean().default(true),
    hideProductName: z.boolean().default(true),
  }),
});

// ── Route Handlers ──

/** GET /api/orders — 我的订单列表 */
export async function getOrders(req: Request) {
  try {
    const userId = await authenticate(req);
    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get("page") || "1") || 1;
    const pageSize = parseInt(url.searchParams.get("pageSize") || "20") || 20;
    const list = await ordersQueries.getOrderList(userId, page, pageSize);
    return NextResponse.json(list);
  } catch (error) {
    return apiError(error);
  }
}

/** POST /api/orders — 创建订单（乐观锁防超卖） */
export const createOrder = withValidation(
  createOrderSchema,
  async (data, req) => {
    const userId = await authenticate(req);
    const order = await ordersService.createOrder(userId, {
      items: data.items,
      shippingAddress: data.shippingAddress,
      privacy: {
        anonymousPackaging: (data.privacy.anonymousPackaging ?? true) as boolean,
        hideProductName: (data.privacy.hideProductName ?? true) as boolean,
      },
    });
    return NextResponse.json(order, { status: 201 });
  },
);

/** GET /api/orders/[id] — 订单详情 */
export async function getOrderById(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await authenticate(req);
    const { id } = await ctx.params;
    const detail = await ordersQueries.getOrderDetail(userId, id);
    return NextResponse.json(detail);
  } catch (error) {
    return apiError(error);
  }
}

/** POST /api/orders/[id]/check-paid — 查询支付状态 */
export async function checkPaid(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await authenticate(req);
    const { id } = await ctx.params;
    const result = await ordersService.checkPaymentStatus(userId, id);
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}

/** POST /api/orders/[id]/cancel — 取消订单（仅 PENDING） */
export async function cancelOrder(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await authenticate(req);
    const { id } = await ctx.params;
    await ordersService.cancelOrder(userId, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

/** POST /api/orders/[id]/refund — 申请退款（仅 PAID） */
export async function requestRefund(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await authenticate(req);
    const { id } = await ctx.params;
    await ordersService.requestRefund(userId, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

/** POST /api/orders/[id]/destroy — 销毁订单（隐私擦除） */
export async function destroyOrder(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await authenticate(req);
    const { id } = await ctx.params;
    await ordersService.destroyOrder(userId, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}

/** POST /api/orders/[id]/paid — 支付宝异步回调（幂等） */
export async function paidCallback(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;

    // 支付宝回调签名验证（通过 payment 模块 adapter）
    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
    }

    // TODO: payment 模块接入后启用签名验证
    // const verified = await paymentService.verifyCallbackSignature(body);
    // if (!verified) {
    //   return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 400 });
    // }

    const outTradeNo =
      body.outTradeNo || body.out_trade_no || String(Date.now());
    const result = await ordersService.markOrderPaid(id, outTradeNo);
    if (result.conflict) {
      return NextResponse.json(
        { error: ERROR_CODES.CANCELLED_PAYMENT_ARRIVED.code, message: "订单状态异常" },
        { status: 409 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error);
  }
}
