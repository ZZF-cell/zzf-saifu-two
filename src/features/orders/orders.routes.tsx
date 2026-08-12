"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { OrderCard, OrderStatusBadge, OrderTimeline, AddressForm } from "./orders.components";
import type { OrderSummary, OrderDetail } from "./orders.queries";
import { fenToYuan, multiplyFen } from "@/shared/utils/money";

// ── helpers ──

async function apiCall(method: string, url: string, body?: Record<string, unknown>) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "请求失败");
  return data;
}

// ── 结算页 ──

interface CartItem {
  id: string;
  productId: string;
  productName: string;
  price: number;
  qty: number;
  image: string | null;
  stock: number;
  subtotal: number;
}

export function CheckoutPage() {
  const router = useRouter();
  const [cart, setCart] = useState<{ items: CartItem[]; totalAmount: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [address, setAddress] = useState({
    name: "",
    phone: "",
    province: "",
    city: "",
    district: "",
    detail: "",
    zipCode: "",
  });

  useEffect(() => {
    fetch("/api/cart", { credentials: "include" })
      .then((res) => {
        if (res.status === 401) { router.push("/login"); return null; }
        return res.json();
      })
      .then((data) => {
        if (data?.items) setCart(data);
      })
      .catch(() => setError("加载购物车失败"))
      .finally(() => setLoading(false));
  }, [router]);

  const handleSubmit = async () => {
    // 基本校验
    if (!address.name || !address.phone || !address.province || !address.city || !address.detail) {
      setError("请填写完整收货地址");
      return;
    }
    if (!/^1[3-9]\d{9}$/.test(address.phone)) {
      setError("手机号格式不正确");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const order = await apiCall("POST", "/api/orders", {
        items: cart!.items.map((item) => ({
          productId: item.productId,
          qty: item.qty,
        })),
        shippingAddress: address,
        privacy: {
          anonymousPackaging: true,
          hideProductName: true,
        },
      });

      if (order.payUrl) {
        // 跳转支付
        window.location.href = order.payUrl;
      } else {
        // 无支付 URL，直接跳转订单页
        router.push(`/orders/${order.orderId}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "下单失败";
      setError(msg);
      if (msg.includes("库存")) {
        // 库存冲突，刷新购物车
        router.refresh();
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <main className="mx-auto min-h-screen max-w-lg p-4">
        <div className="mt-8 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-gray-100" />
          ))}
        </div>
      </main>
    );
  }

  if (!cart || cart.items.length === 0) {
    return (
      <main className="mx-auto min-h-screen max-w-lg p-4">
        <div className="mt-20 text-center text-gray-400">
          <p className="text-lg">购物车为空</p>
          <button
            onClick={() => router.push("/")}
            className="mt-3 rounded-lg bg-primary px-6 py-2 text-sm font-medium text-white"
          >
            去逛逛
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-lg bg-white pb-24">
      <div className="sticky top-0 z-10 border-b bg-white/90 backdrop-blur px-4 py-3">
        <h1 className="text-center text-base font-bold">确认订单</h1>
      </div>

      <div className="p-4 space-y-6">
        {/* 收货地址 */}
        <section>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">收货地址</h3>
          <AddressForm
            value={address}
            onChange={(addr) => setAddress({ name: addr.name, phone: addr.phone, province: addr.province, city: addr.city, district: addr.district, detail: addr.detail, zipCode: addr.zipCode || "" })}
          />
        </section>

        {/* 商品清单 */}
        <section>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">商品清单</h3>
          <div className="space-y-2">
            {cart.items.map((item) => (
              <div key={item.id} className="flex items-center gap-3 rounded-lg border border-gray-50 p-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {item.productName}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-400">
                    ¥{fenToYuan(item.price)} × {item.qty}
                  </p>
                </div>
                <span className="text-sm font-medium text-gray-900">
                  ¥{fenToYuan(item.subtotal)}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* 总计 */}
        <div className="flex justify-between border-t pt-4">
          <span className="text-sm text-gray-500">合计</span>
          <span className="text-xl font-bold text-primary">
            ¥{fenToYuan(cart.totalAmount)}
          </span>
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>
        )}

        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="w-full rounded-lg bg-primary py-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "提交中..." : "提交订单"}
        </button>
      </div>
    </main>
  );
}

// ── 订单列表页 ──

export function OrderListPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchOrders = useCallback(async () => {
    try {
      const data = await apiCall("GET", "/api/orders");
      setOrders(data.orders || []);
    } catch {
      // 静默失败
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  if (loading) {
    return (
      <main className="mx-auto min-h-screen max-w-lg p-4">
        <div className="mt-8 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-gray-100" />
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-lg bg-white">
      <div className="sticky top-0 z-10 border-b bg-white/90 backdrop-blur px-4 py-3">
        <h1 className="text-center text-base font-bold">我的订单</h1>
      </div>

      <div className="p-4">
        {orders.length === 0 ? (
          <div className="py-20 text-center text-gray-400">
            <p className="text-lg">暂无订单</p>
            <button
              onClick={() => router.push("/")}
              className="mt-3 rounded-lg bg-primary px-6 py-2 text-sm font-medium text-white"
            >
              去逛逛
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {orders.map((order) => (
              <OrderCard key={order.id} {...order} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

// ── 订单详情页 ──

export function OrderDetailPage({ id }: { id: string }) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");

  const fetchOrder = useCallback(async () => {
    try {
      const data = await apiCall("GET", `/api/orders/${id}`);
      setOrder(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "加载失败";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchOrder(); }, [fetchOrder]);

  const handleAction = async (action: string) => {
    if (acting) return;
    setActing(true);
    setError("");
    try {
      await apiCall("POST", `/api/orders/${id}/${action}`);
      await fetchOrder();
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : "操作失败"));
    } finally {
      setActing(false);
    }
  };

  // 去支付 — 获取支付跳转 URL 后跳转支付宝
  const handlePay = async () => {
    if (acting) return;
    setActing(true);
    setError("");
    try {
      const res = await fetch(`/api/pay/${id}`, { credentials: "include" });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.payUrl) {
        window.location.href = data.payUrl;
        return;
      }
      setError(data?.message || "支付功能暂不可用");
    } catch {
      setError("发起支付失败");
    } finally {
      setActing(false);
    }
  };

  if (loading) {
    return (
      <main className="mx-auto min-h-screen max-w-lg p-4">
        <div className="mt-8 space-y-3">
          <div className="h-40 animate-pulse rounded-xl bg-gray-100" />
          <div className="h-20 animate-pulse rounded-xl bg-gray-100" />
        </div>
      </main>
    );
  }

  if (!order) {
    return (
      <main className="mx-auto min-h-screen max-w-lg p-4">
        <div className="py-20 text-center text-gray-400">{error || "订单不存在"}</div>
      </main>
    );
  }

  const timelineEvents = [
    { label: "下单", date: order.createdAt, active: true },
    // 「支付」节点以实际支付时间为准 —— 未支付即取消的订单不得显示为已支付
    { label: "支付", date: order.paidAt, active: !!order.paidAt },
    { label: "发货", date: order.shippedAt, active: ["SHIPPED", "DELIVERED", "COMPLETED"].includes(order.status) && !!order.shippedAt },
    { label: "送达", date: order.deliveredAt, active: ["DELIVERED", "COMPLETED"].includes(order.status) },
    { label: "完成", date: order.completedAt || order.cancelledAt || order.refundedAt, active: ["COMPLETED", "CANCELLED", "REFUNDED"].includes(order.status) },
  ];

  return (
    <main className="mx-auto min-h-screen max-w-lg bg-white pb-24">
      <div className="sticky top-0 z-10 border-b bg-white/90 backdrop-blur px-4 py-3">
        <h1 className="text-center text-base font-bold">订单详情</h1>
      </div>

      <div className="p-4 space-y-6">
        {/* 状态 */}
        <div className="flex items-center justify-between">
          <OrderStatusBadge status={order.status} />
          {order.isDestroyed && (
            <span className="text-xs text-red-400">已销毁</span>
          )}
        </div>

        {/* 时间线 */}
        <OrderTimeline events={timelineEvents} />

        {/* 金额 */}
        <div className="rounded-xl bg-gray-50 p-4">
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">订单金额</span>
            <span className="font-bold text-primary">¥{fenToYuan(order.total)}</span>
          </div>
          <p className="mt-1 text-xs text-gray-400">订单号: {order.id}</p>
          {order.outTradeNo && (
            <p className="mt-0.5 text-xs text-gray-400">流水号: {order.outTradeNo}</p>
          )}
        </div>

        {/* 收货地址（已销毁则隐藏） */}
        {!order.isDestroyed && order.shippingAddress !== "[DESTROYED]" && (
          <OrderShippingAddress shippingAddress={order.shippingAddress} />
        )}

        {/* 商品列表 */}
        <section>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">商品</h3>
          <div className="space-y-2">
            {order.items.map((item) => (
              <div key={item.id} className="flex justify-between rounded-lg border border-gray-50 p-3">
                <div>
                  <p className="text-sm text-gray-900">{item.productName}</p>
                  <p className="mt-0.5 text-xs text-gray-400">
                    ¥{fenToYuan(item.price)} × {item.qty}
                  </p>
                </div>
                <span className="text-sm font-medium text-gray-900">
                  ¥{fenToYuan(multiplyFen(item.price, item.qty))}
                </span>
              </div>
            ))}
          </div>
        </section>

        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>
        )}

        {/* 操作按钮 */}
        <div className="space-y-2">
          {order.status === "PENDING" && !order.isDestroyed && (
            <div className="space-y-2">
              <button
                onClick={handlePay}
                disabled={acting}
                className="w-full rounded-lg bg-primary py-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
              >
                去支付
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => handleAction("cancel")}
                  disabled={acting}
                  className="flex-1 rounded-lg border border-gray-200 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
                >
                  取消订单
                </button>
                <button
                  onClick={() => handleAction("check-paid")}
                  disabled={acting}
                  className="flex-1 rounded-lg border border-gray-200 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
                >
                  查询支付
                </button>
              </div>
            </div>
          )}
          {order.status === "PAID" && !order.isDestroyed && (
            <button
              onClick={() => handleAction("refund")}
              disabled={acting}
              className="w-full rounded-lg border border-gray-200 py-2.5 text-sm font-medium text-orange-600 transition hover:bg-orange-50 disabled:opacity-50"
            >
              申请退款
            </button>
          )}
          {(order.status === "COMPLETED" || order.status === "CANCELLED" || order.status === "REFUNDED") && !order.isDestroyed && (
            <button
              onClick={() => handleAction("destroy")}
              disabled={acting}
              className="w-full rounded-lg border border-red-200 py-2.5 text-sm font-medium text-red-500 transition hover:bg-red-50 disabled:opacity-50"
            >
              一键销毁
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

// ── 辅助 ──

function OrderShippingAddress({ shippingAddress }: { shippingAddress: string }) {
  try {
    const addr = JSON.parse(shippingAddress);
    return (
      <div className="rounded-xl bg-gray-50 p-4">
        <h3 className="mb-2 text-sm font-semibold text-gray-700">收货地址</h3>
        <p className="text-sm text-gray-900">
          {addr.name} {addr.phone}
        </p>
        <p className="text-sm text-gray-500">
          {addr.province} {addr.city} {addr.district} {addr.detail}
        </p>
      </div>
    );
  } catch {
    return null;
  }
}
