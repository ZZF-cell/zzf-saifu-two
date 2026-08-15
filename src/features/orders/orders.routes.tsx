"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { OrderCard, OrderStatusBadge, OrderTimeline, AddressForm } from "./orders.components";
import type { OrderSummary, OrderDetail } from "./orders.queries";
import { ORDER_STATUS_GROUPS } from "./orders.state-machine";
import type { OrderStatus } from "./orders.state-machine";
import { fenToYuan, sumFen } from "@/shared/utils/money";
import { apiFetch } from "@/shared/api/client";
import { SiteHeader } from "@/shared/ui/SiteHeader";

// ── 订单列表状态 Tab（与用户中心统计卡 / ORDER_STATUS_GROUPS 同口径） ──

const ORDER_TABS = [
  { key: "", label: "全部" },
  { key: "pending", label: "待付款" },
  { key: "paid", label: "已支付" },
  { key: "cancelled", label: "已取消/退款" },
] as const;

/** URL tab key → 真实订单状态组（undefined = 全部）；页面 URL 用 tab key，API URL 用状态逗号串 */
const TAB_TO_GROUP: Record<string, readonly OrderStatus[] | undefined> = {
  "": undefined,
  pending: ORDER_STATUS_GROUPS.pending,
  paid: ORDER_STATUS_GROUPS.paid,
  cancelled: ORDER_STATUS_GROUPS.cancelled,
};

// ── helpers ──

async function apiCall(method: string, url: string, body?: Record<string, unknown>) {
  // apiFetch：401 自动刷新 Access Token 并重试；Refresh 也失效才跳登录页
  const res = await apiFetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "请求失败");
  return data;
}

// ── 支付跳转兜底（CheckoutPage / OrderDetailPage 共用） ──
// 支付宝沙箱偶发白屏：跳转前先上屏遮罩过渡（消除无反馈白屏感），
// 遮罩保留「新窗口打开支付页 + 返回订单详情」两个逃生口，任何情况下用户都有出路。

const LAST_PAY_KEY = "lastPayOrder";

function PayRedirectOverlay({
  target,
  onReturn,
}: {
  target: { orderId: string; payUrl: string };
  onReturn: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/95">
      <div className="mx-auto w-full max-w-sm px-6 text-center">
        <p className="text-base font-semibold text-gray-900">正在跳转至支付宝安全收银台…</p>
        <p className="mt-2 text-sm text-gray-500">如未自动跳转，请点击下方链接在新窗口打开</p>
        <a
          href={target.payUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 block rounded-lg bg-primary py-3 text-sm font-medium text-white transition hover:opacity-90"
        >
          打开支付页面
        </a>
        <button
          onClick={onReturn}
          className="mt-2 w-full rounded-lg border border-gray-200 py-3 text-sm font-medium text-gray-600 transition hover:bg-gray-50"
        >
          返回订单详情
        </button>
      </div>
    </div>
  );
}

function usePayRedirect() {
  const router = useRouter();
  const payTimerRef = useRef<number | null>(null);
  const [payRedirecting, setPayRedirecting] = useState<{
    orderId: string;
    payUrl: string;
  } | null>(null);

  const openPayUrl = useCallback((payUrl: string, orderId: string) => {
    // 记录待支付订单，跳转失败返回后可在结算页/订单页提示续付
    try {
      sessionStorage.setItem(LAST_PAY_KEY, orderId);
    } catch {
      // 隐私模式等场景忽略
    }
    setPayRedirecting({ orderId, payUrl });
    if (payTimerRef.current !== null) window.clearTimeout(payTimerRef.current);
    // 先让遮罩上屏，再自动跳转（300ms 足够渲染，消除无过渡白屏感）
    payTimerRef.current = window.setTimeout(() => {
      window.location.href = payUrl;
    }, 300);
  }, []);

  const cancelPayRedirect = useCallback(() => {
    if (payTimerRef.current !== null) window.clearTimeout(payTimerRef.current);
    setPayRedirecting(null);
  }, []);

  const payRedirectOverlay = payRedirecting ? (
    <PayRedirectOverlay
      target={payRedirecting}
      onReturn={() => {
        cancelPayRedirect();
        router.push(`/orders/${payRedirecting.orderId}`);
      }}
    />
  ) : null;

  return { openPayUrl, cancelPayRedirect, payRedirectOverlay };
}

/** 读取并清除「待支付订单」标记（下单后跳转失败返回时提示续付） */
function useLastPayOrder() {
  const [lastPayOrderId, setLastPayOrderId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const id = sessionStorage.getItem(LAST_PAY_KEY);
      if (id) setLastPayOrderId(id);
    } catch {
      // 忽略
    }
  }, []);

  const dismissLastPay = useCallback(() => {
    try {
      sessionStorage.removeItem(LAST_PAY_KEY);
    } catch {
      // 忽略
    }
    setLastPayOrderId(null);
  }, []);

  return { lastPayOrderId, dismissLastPay };
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

export function CheckoutPage({ initialItems = "" }: { initialItems?: string }) {
  const router = useRouter();
  const { openPayUrl, payRedirectOverlay } = usePayRedirect();
  const { lastPayOrderId, dismissLastPay } = useLastPayOrder();
  const [cart, setCart] = useState<{ items: CartItem[]; totalAmount: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // 下单后服务端重算金额与购物车显示不一致（商品调价）→ 提示用户后等待确认
  const [priceChanged, setPriceChanged] = useState(false);
  const [finalTotal, setFinalTotal] = useState(0);
  const [pendingOrder, setPendingOrder] = useState<{
    payUrl: string | null;
    orderId: string;
  } | null>(null);
  const [address, setAddress] = useState({
    name: "",
    phone: "",
    province: "",
    city: "",
    district: "",
    detail: "",
    zipCode: "",
  });

  // 部分结算：URL ?items= 携带本次待结算的 productId 列表（购物车勾选去结算跳转而来）。
  // CUID 不含逗号，逗号拆分安全；空集 = 直接访问 /checkout（无 ?items=）→ 回退全量。
  const selectedProductIds = useMemo(() => {
    const raw = initialItems.split(",").map((s) => s.trim()).filter(Boolean);
    return new Set(raw);
  }, [initialItems]);

  useEffect(() => {
    // apiFetch 处理 401 自动刷新；Refresh 失效时自行跳登录页
    apiFetch("/api/cart")
      .then((res) => res.json())
      .then((data) => {
        if (data?.items) {
          // 部分结算：只展示本次勾选的商品（以服务端最新购物车为准过滤，
          // 已下架/已结算的选中项自然排除；无 ?items= 时回退全量向后兼容）
          const items: CartItem[] =
            selectedProductIds.size > 0
              ? (data.items as CartItem[]).filter((i) =>
                  selectedProductIds.has(i.productId),
                )
              : data.items;
          // 金额只统计本次结算项（订单提交/价格变更比较都以该重算值为基准）
          setCart({ items, totalAmount: sumFen(items.map((i) => i.subtotal)) });
        }
      })
      .catch(() => setError("加载购物车失败"))
      .finally(() => setLoading(false));
  }, [selectedProductIds]);

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
    setPriceChanged(false);
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

      // 服务端按下单时点商品价格快照重算金额（订单快照权威）
      // 与购物车展示金额不一致（可能被调价）→ 提示用户确认后继续，绝不静默改价
      if (typeof order.total === "number" && order.total !== cart!.totalAmount) {
        setFinalTotal(order.total);
        setPendingOrder({ payUrl: order.payUrl, orderId: order.orderId });
        setPriceChanged(true);
        return;
      }

      redirectToPay(order);
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

  /** 跳转支付：有支付 URL 走遮罩过渡 + 支付宝；无 URL 显式提示（订单已创建，不静默跳详情） */
  const redirectToPay = (order: { payUrl: string | null; orderId: string }) => {
    if (order.payUrl) {
      openPayUrl(order.payUrl, order.orderId);
    } else {
      setError("支付服务暂不可用，订单已创建，可稍后到订单详情页继续支付");
    }
  };

  if (loading) {
    return (
      <main className="mx-auto min-h-screen max-w-6xl p-4">
        <div className="mx-auto mt-8 w-full max-w-2xl space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-gray-100" />
          ))}
        </div>
      </main>
    );
  }

  if (!cart || cart.items.length === 0) {
    return (
      <main className="mx-auto min-h-screen max-w-6xl p-4">
        <div className="mx-auto mt-20 w-full max-w-2xl text-center text-gray-400">
          <p className="text-lg">
            {selectedProductIds.size > 0 ? "所选商品已不存在或已结算" : "购物车为空"}
          </p>
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
    <main className="mx-auto min-h-screen max-w-6xl bg-white pb-24">
      {/* 待支付提醒：上次跳转支付宝失败返回时提示续付（点击清除标记） */}
      {lastPayOrderId && (
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between rounded-lg bg-yellow-50 px-3 py-2 text-sm text-yellow-700">
          <span>有一笔待支付订单</span>
          <span className="flex items-center gap-3">
            <button
              onClick={() => {
                dismissLastPay();
                router.push(`/orders/${lastPayOrderId}`);
              }}
              className="font-medium underline"
            >
              去支付
            </button>
            <button onClick={dismissLastPay} className="text-yellow-500" aria-label="关闭提醒">
              ×
            </button>
          </span>
        </div>
      )}

      <div className="sticky top-0 z-10 mx-auto w-full max-w-6xl border-b bg-white/90 px-4 py-3 backdrop-blur">
        <h1 className="text-center text-base font-bold">确认订单</h1>
      </div>

      <div className="mx-auto w-full max-w-2xl p-4 space-y-6">
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

        {priceChanged && pendingOrder ? (
          // 下单时服务端按实时价重算，与购物车展示金额不一致（可能被调价）
          // 订单已创建，金额以服务端快照为准 —— 明确提示后由用户确认继续支付
          <div className="rounded-lg bg-yellow-50 px-3 py-3 text-sm text-yellow-700">
            <p>
              部分商品价格有调整，应付金额以{" "}
              <b className="text-base">¥{fenToYuan(finalTotal)}</b> 为准
            </p>
            <button
              onClick={() => redirectToPay(pendingOrder)}
              className="mt-2 w-full rounded-lg bg-primary py-3 text-sm font-medium text-white transition hover:opacity-90"
            >
              继续支付 ¥{fenToYuan(finalTotal)}
            </button>
          </div>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full rounded-lg bg-primary py-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "提交中..." : "提交订单"}
          </button>
        )}
      </div>

      {payRedirectOverlay}
    </main>
  );
}

// ── 订单列表页 ──

export function OrderListPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // URL ?status= 驱动 Tab（非法 key 归一为「全部」；URL 用 tab key，API 用真实状态逗号串）
  const rawKey = searchParams.get("status") ?? "";
  const activeKey = rawKey in TAB_TO_GROUP ? rawKey : "";

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const group = TAB_TO_GROUP[activeKey];
      const qs = group && group.length > 0 ? `?status=${group.join(",")}` : "";
      const data = await apiCall("GET", `/api/orders${qs}`);
      setOrders(data.orders || []);
    } catch {
      // 静默失败
    } finally {
      setLoading(false);
    }
  }, [activeKey]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  const switchTab = (key: string) => {
    router.push(key ? `/orders?status=${key}` : "/orders");
  };

  return (
    <main className="mx-auto min-h-screen max-w-6xl bg-white">
      <SiteHeader />
      <div className="mx-auto w-full max-w-3xl px-4 pt-4">
        <h1 className="text-center text-xl font-bold text-gray-900">我的订单</h1>
      </div>

      {/* 状态 Tab：与用户中心统计卡 / ORDER_STATUS_GROUPS 同口径，URL 双向同步 */}
      <div className="mx-auto w-full max-w-3xl px-4 pt-3">
        <div className="flex gap-1 rounded-xl bg-gray-100 p-1">
          {ORDER_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => switchTab(tab.key)}
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
                activeKey === tab.key
                  ? "bg-white text-primary shadow-sm"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl p-4">
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl bg-gray-100" />
            ))}
          </div>
        ) : orders.length === 0 ? (
          <div className="mx-auto w-full max-w-3xl py-20 text-center text-gray-400">
            <p className="text-lg">{activeKey ? "该状态下暂无订单" : "暂无订单"}</p>
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
  const router = useRouter();
  const { openPayUrl, payRedirectOverlay } = usePayRedirect();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");

  // 支付回跳自动查询标记：仅本页挂载后首个 PENDING 详情触发一次，避免重复查询
  const autoCheckedPayRef = useRef(false);

  const fetchOrder = useCallback(async () => {
    try {
      const data = await apiCall("GET", `/api/orders/${id}`);
      setOrder(data);
      // 支付回跳：PENDING 订单自动查询一次真实支付状态（本地沙箱异步通知 notifyUrl=localhost
      // 收不到，回跳页立即主动核对，成功后自动变已支付；失败静默，用户仍可手动点「查询支付」）
      if (data.status === "PENDING" && !autoCheckedPayRef.current) {
        autoCheckedPayRef.current = true;
        await apiCall("POST", `/api/orders/${id}/check-paid`).catch(() => null);
        const updated = await apiCall("GET", `/api/orders/${id}`).catch(() => null);
        if (updated) setOrder(updated);
      }
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
      const res = await apiFetch(`/api/pay/${id}`);
      const data = await res.json().catch(() => null);
      if (res.ok && data?.payUrl) {
        openPayUrl(data.payUrl, id);
        return;
      }
      setError(data?.message || "支付功能暂不可用");
    } catch (err: unknown) {
      // apiFetch 在 Refresh Token 失效时已跳转登录页并抛错，这里只提示其他异常
      setError(err instanceof Error ? err.message : "发起支付失败");
    } finally {
      setActing(false);
    }
  };

  if (loading) {
    return (
      <main className="mx-auto min-h-screen max-w-6xl p-4">
        <div className="mx-auto mt-8 w-full max-w-3xl space-y-3">
          <div className="h-40 animate-pulse rounded-xl bg-gray-100" />
          <div className="h-20 animate-pulse rounded-xl bg-gray-100" />
        </div>
      </main>
    );
  }

  if (!order) {
    return (
      <main className="mx-auto min-h-screen max-w-6xl p-4">
        <div className="mx-auto w-full max-w-3xl py-20 text-center text-gray-400">
          <p className="text-lg">{error || "订单不存在"}</p>
          <button
            onClick={() => router.push("/")}
            className="mt-3 rounded-lg bg-primary px-6 py-2 text-sm font-medium text-white"
          >
            返回首页
          </button>
        </div>
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
    <main className="mx-auto min-h-screen max-w-6xl bg-white pb-24">
      <div className="sticky top-0 z-10 mx-auto w-full max-w-6xl border-b bg-white/90 px-4 py-3 backdrop-blur">
        <div className="relative">
          {/* 返回：深链直达时无历史记录则回首页，避免浏览器退出 */}
          <button
            onClick={() =>
              window.history.length > 1 ? router.back() : router.push("/")
            }
            aria-label="返回"
            className="absolute left-0 top-1/2 -translate-y-1/2 text-sm text-gray-500 transition hover:text-gray-900"
          >
            ← 返回
          </button>
          <h1 className="text-center text-base font-bold">订单详情</h1>
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl p-4 space-y-6">
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
            {order.isDestroyed ? (
              <span className="font-bold text-gray-400">已销毁</span>
            ) : (
              <span className="font-bold text-primary">¥{fenToYuan(order.total)}</span>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-400">订单号: {order.id}</p>
          {order.outTradeNo && !order.isDestroyed && (
            <p className="mt-0.5 text-xs text-gray-400">流水号: {order.outTradeNo}</p>
          )}
        </div>

        {/* 收货地址（已销毁则隐藏） */}
        {!order.isDestroyed && order.shippingAddress !== "[DESTROYED]" && (
          <OrderShippingAddress shippingAddress={order.shippingAddress} />
        )}

        {/* 商品列表（已销毁订单不展示任何商品名/单价/数量） */}
        <section>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">商品</h3>
          <div className="space-y-2">
            {order.isDestroyed ? (
              <div className="rounded-lg border border-gray-50 p-4 text-sm text-gray-400">
                订单已销毁，商品信息已清除
              </div>
            ) : order.items.map((item) => (
              <div key={item.id} className="flex justify-between rounded-lg border border-gray-50 p-3">
                <div>
                  <p className="text-sm text-gray-900">{item.productName}</p>
                  {/* OrderItem.price 为行总额（含 ×qty），单价 = 行总额 ÷ 数量，行小计 = 行总额 */}
                  <p className="mt-0.5 text-xs text-gray-400">
                    单价 ¥{fenToYuan(item.price / item.qty)} × {item.qty}
                  </p>
                </div>
                <span className="text-sm font-medium text-gray-900">
                  ¥{fenToYuan(item.price)}
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
          {/* 已销毁订单所有操作按钮隐藏，返回首页是唯一出路（不再依赖浏览器后退） */}
          {order.isDestroyed && (
            <button
              onClick={() => router.push("/")}
              className="w-full rounded-lg bg-primary py-3 text-sm font-medium text-white transition hover:opacity-90"
            >
              返回首页
            </button>
          )}
        </div>
      </div>

      {payRedirectOverlay}
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
