"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/shared/api/client";
import { fenToYuan } from "@/shared/utils/money";
import { SiteHeader } from "@/shared/ui/SiteHeader";
import { PRODUCT_CATEGORIES, getSubcategories } from "@/shared/constants/product-categories";

// ── helpers ──

async function apiCall(method: string, url: string, body?: Record<string, unknown>) {
  const res = await apiFetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || "请求失败");
  return data;
}

// ── 类型 ──

interface BrandOverview {
  brand: {
    id: string;
    name: string;
    logo: string | null;
    status: string;
    createdAt: string;
  };
  productCount: number;
  approvedProductCount: number;
  orderCount: number;
  paidRevenue: number;
}

interface BrandProduct {
  id: string;
  name: string;
  category: string;
  subCategory: string | null;
  price: number;
  stock: number;
  status: string;
  sales: number;
}

interface BrandOrder {
  id: string;
  brandSubtotal: number; // 本品牌商品行小计（分），不含其他品牌金额
  status: string;
  createdAt: string;
  firstItemName: string;
  isDestroyed: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: "待审核",
  APPROVED: "已通过",
  REJECTED: "已拒绝",
  PAID: "已支付",
  SHIPPED: "已发货",
  DELIVERED: "已送达",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  REFUND_REQUESTED: "退款中",
  REFUNDED: "已退款",
};

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "APPROVED" || status === "PAID" || status === "COMPLETED"
      ? "bg-green-100 text-green-700"
      : status === "PENDING" || status === "REFUND_REQUESTED"
        ? "bg-yellow-100 text-yellow-700"
        : "bg-gray-100 text-gray-600";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${color}`}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

// ── 品牌概览 ──

function OverviewTab() {
  const [overview, setOverview] = useState<BrandOverview | null>(null);

  useEffect(() => {
    apiFetch("/api/brand/overview")
      .then((r) => r.json())
      .then(setOverview)
      .catch(() => {});
  }, []);

  if (!overview) {
    return <div className="h-32 animate-pulse rounded-xl bg-gray-100" />;
  }

  const cards = [
    { label: "商品总数", value: String(overview.productCount) },
    { label: "在售商品", value: String(overview.approvedProductCount) },
    { label: "订单数", value: String(overview.orderCount) },
    { label: "已支付销售额", value: `¥${fenToYuan(overview.paidRevenue)}`, highlight: true },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-gray-50 p-4">
        <p className="text-base font-medium text-gray-900">{overview.brand.name}</p>
        <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
          <StatusBadge status={overview.brand.status} />
          <span>注册于 {new Date(overview.brand.createdAt).toLocaleDateString("zh-CN")}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className={`rounded-xl p-4 ${c.highlight ? "bg-primary/5" : "bg-gray-50"}`}>
            <p className={`text-xl font-bold ${c.highlight ? "text-primary" : "text-gray-900"}`}>
              {c.value}
            </p>
            <p className="mt-1 text-xs text-gray-500">{c.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 提交商品 ──

function SubmitProductTab() {
  const [form, setForm] = useState({
    name: "",
    category: "",
    subCategory: "",
    price: "",
    stock: "",
    description: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleSubmit = async () => {
    setError("");
    setSuccess("");
    const price = Number(form.price);
    const stock = Number(form.stock);
    if (!form.name.trim()) return setError("请填写商品名称");
    if (!form.category) return setError("请选择大类");
    if (!form.subCategory) return setError("请选择子类");
    if (!price || price <= 0) return setError("请填写正确的价格");
    if (!Number.isInteger(stock) || stock < 0) return setError("请填写正确的库存");

    setSubmitting(true);
    try {
      await apiCall("POST", "/api/brand/products", {
        name: form.name.trim(),
        category: form.category.trim(),
        subCategory: form.subCategory,
        price,
        stock,
        description: form.description.trim() || undefined,
      });
      setSuccess("商品已提交，等待平台质检");
      setForm({ name: "", category: "", subCategory: "", price: "", stock: "", description: "" });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-100 p-4">
        <div className="space-y-3">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="商品名称"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
          <div className="flex gap-3">
            <select
              value={form.category}
              onChange={(e) =>
                setForm({ ...form, category: e.target.value, subCategory: "" })
              }
              className="w-1/2 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            >
              <option value="">请选择大类</option>
              {PRODUCT_CATEGORIES.map((node) => (
                <option key={node.category} value={node.category}>
                  {node.category}
                </option>
              ))}
            </select>
            <select
              value={form.subCategory}
              onChange={(e) => setForm({ ...form, subCategory: e.target.value })}
              disabled={!form.category}
              className="w-1/2 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:bg-gray-50 disabled:text-gray-400"
            >
              <option value="">
                {form.category ? "请选择子类" : "请先选择大类"}
              </option>
              {getSubcategories(form.category).map((sub) => (
                <option key={sub} value={sub}>
                  {sub}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-3">
            <input
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
              placeholder="价格（元）"
              inputMode="decimal"
              className="w-1/2 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
            <input
              value={form.stock}
              onChange={(e) => setForm({ ...form, stock: e.target.value })}
              placeholder="库存"
              inputMode="numeric"
              className="w-1/2 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </div>
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="商品描述（选填）"
            rows={3}
            className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
        </div>
        {error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
        {success && <div className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{success}</div>}
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="mt-4 w-full rounded-lg bg-primary py-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "提交中..." : "提交审核"}
        </button>
      </div>
    </div>
  );
}

// ── 我的商品 ──

function ProductsTab() {
  const [products, setProducts] = useState<BrandProduct[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/api/brand/products?pageSize=50")
      .then((r) => r.json())
      .then((data) => setProducts(data.items || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="h-32 animate-pulse rounded-xl bg-gray-100" />;
  }

  return (
    <div className="space-y-3">
      {products.length === 0 ? (
        <div className="py-12 text-center text-gray-400">暂无商品，请先提交</div>
      ) : (
        products.map((p) => (
          <div key={p.id} className="rounded-xl border border-gray-100 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-gray-900">{p.name}</p>
              <StatusBadge status={p.status} />
            </div>
            <p className="mt-1 text-xs text-gray-400">
              {p.category}
              {p.subCategory ? ` / ${p.subCategory}` : ""} · ¥{fenToYuan(p.price)} · 库存 {p.stock} · 已售 {p.sales}
            </p>
          </div>
        ))
      )}
    </div>
  );
}

// ── 品牌订单 ──

function OrdersTab() {
  const [orders, setOrders] = useState<BrandOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/api/brand/orders?pageSize=50")
      .then((r) => r.json())
      .then((data) => setOrders(data.orders || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="h-32 animate-pulse rounded-xl bg-gray-100" />;
  }

  return (
    <div className="space-y-3">
      {orders.length === 0 ? (
        <div className="py-12 text-center text-gray-400">暂无相关订单</div>
      ) : (
        orders.map((o) => (
          <div key={o.id} className="rounded-xl border border-gray-100 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-gray-900">{o.firstItemName}</p>
              <StatusBadge status={o.status} />
            </div>
            <p className="mt-1 text-xs text-gray-400">
              ¥{fenToYuan(o.brandSubtotal)}
              {o.isDestroyed && <span className="ml-1 text-red-400">已销毁</span>} · 下单于{" "}
              {new Date(o.createdAt).toLocaleDateString("zh-CN")}
            </p>
          </div>
        ))
      )}
    </div>
  );
}

// ── 主页面 ──

type TabKey = "overview" | "submit" | "products" | "orders";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "品牌概览" },
  { key: "submit", label: "提交商品" },
  { key: "products", label: "我的商品" },
  { key: "orders", label: "品牌订单" },
];

export function BrandCenterPage() {
  const [tab, setTab] = useState<TabKey>("overview");

  return (
    <main className="mx-auto min-h-screen max-w-lg bg-white pb-24">
      <SiteHeader />
      <div className="px-4 pt-3">
        <h1 className="text-center text-base font-bold">品牌中心</h1>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`shrink-0 rounded-full px-3 py-1 text-xs transition ${
                tab === t.key
                  ? "bg-primary text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4">
        {tab === "overview" && <OverviewTab />}
        {tab === "submit" && <SubmitProductTab />}
        {tab === "products" && <ProductsTab />}
        {tab === "orders" && <OrdersTab />}
      </div>
    </main>
  );
}
