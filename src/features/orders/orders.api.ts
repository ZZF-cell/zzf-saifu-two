// 订单 API Route Handlers（需登录）
import { NextResponse } from "next/server";
import { z } from "zod";
import { withValidation, apiError } from "@/shared/utils/api";
import { authenticate } from "@/shared/api/auth";
import { verifyNotifySignature } from "@/features/payment";
import { yuanToFen } from "@/shared/utils/money";
import * as ordersService from "./orders.service";
import * as ordersQueries from "./orders.queries";

/**
 * 解析支付宝回调请求体
 * 支付宝异步通知为 application/x-www-form-urlencoded 表单
 * （本地联调模拟时可能是 JSON，两者都兼容）
 */
function parseCallbackBody(text: string): Record<string, string> {
  if (!text) return {};
  if (text.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(parsed).map(([k, v]) => [k, String(v)]),
      );
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

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

/**
 * POST /api/orders/[id]/paid — 支付宝异步回调（幂等）
 *
 * 支付宝异步通知要求响应体为纯文本 "success"（停止重试）或 "failure"（重试）
 * 安全处理原则：
 * - 签名无效 / 终态必需字段缺失（out_trade_no、total_amount）→ 记录日志返回 "failure" 让支付宝重试
 * - 持久性异常（out_trade_no 与订单不符、金额不匹配、支付到达但订单已取消/退款）→
 *   重试不会改变结果，告警后返回 "success" 停止重试，交由人工处理
 */
export async function paidCallback(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;

    // 解析回调体（form-urlencoded 为主，兼容 JSON 便于本地模拟）
    const text = await req.text();
    const body = parseCallbackBody(text);

    // 签名 + app_id 校验（payment 模块）
    await verifyNotifySignature(body);

    // trade_status 仅终态才标记已支付：
    // WAIT_BUYER_PAY 等中间态 → 确认收到但不标记（返回 success 停止重试，等待最终状态通知）
    const isFinalStatus =
      body.trade_status === "TRADE_SUCCESS" ||
      body.trade_status === "TRADE_FINISHED";
    if (!isFinalStatus) {
      console.log(
        `[orders] 回调状态非终态: 订单 ${id} trade_status=${body.trade_status ?? "(空)"}`,
      );
      return new NextResponse("success", { status: 200 });
    }

    const outTradeNo = body.out_trade_no || body.outTradeNo;
    // 终态通知的必需字段：out_trade_no 缺失说明解析/上游异常，
    // 不标记 PAID（否则写入 NULL 破坏 @unique 幂等键），返回 failure 让支付宝重试
    if (!outTradeNo) {
      console.error(`[orders] 回调缺少 out_trade_no: 订单 ${id}`);
      return new NextResponse("failure", { status: 200 });
    }
    // out_trade_no 与订单号必须一致（pageExec 时 outTradeNo 即订单 id）
    if (outTradeNo !== id) {
      console.error(
        `[orders] 回调 out_trade_no 不匹配: 订单 ${id} out_trade_no=${outTradeNo}`,
      );
      return new NextResponse("success", { status: 200 });
    }
    // 支付宝真实交易流水号（区别于商户 out_trade_no），回调必备字段之一
    const alipayTradeNo = body.trade_no || body.tradeNo;

    // 终态通知的必需字段：total_amount（元）缺失则不做金额核验，
    // 一律不标记 PAID（防止绕过订单快照金额校验），返回 failure 让支付宝重试
    if (!body.total_amount) {
      console.error(
        `[orders] 回调缺少 total_amount: 订单 ${id} out_trade_no=${outTradeNo}`,
      );
      return new NextResponse("failure", { status: 200 });
    }
    // 回调金额（元）→ 分，与订单快照校验（markOrderPaid 内强校验）
    const amountFen = yuanToFen(body.total_amount);

    const result = await ordersService.markOrderPaid(id, outTradeNo, amountFen, alipayTradeNo);
    if (result.conflict) {
      // 金额不匹配或订单状态异常 — 停止重试，交由告警/人工处理
      console.error(
        `[orders] 支付回调异常: 订单 ${id} 无法标记为 PAID（outTradeNo=${outTradeNo}）`,
      );
      return new NextResponse("success", { status: 200 });
    }
    return new NextResponse("success", { status: 200 });
  } catch (error) {
    // 验签失败 / 其他异常 — 返回 "failure" 让支付宝重试
    console.error("[orders] 支付回调失败:", error);
    return new NextResponse("failure", { status: 200 });
  }
}
