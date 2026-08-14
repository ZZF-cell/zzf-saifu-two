"use client";

import { useState, useEffect, useRef } from "react";
import { apiFetch } from "@/shared/api/client";
import { fenToYuan } from "@/shared/utils/money";
import { firstFieldError } from "@/shared/utils/api-errors";
import { SiteHeader } from "@/shared/ui/SiteHeader";
import { StatusBadge } from "@/shared/ui/StatusBadge";
import { Image } from "@/shared/ui/Image";
import { PRODUCT_CATEGORIES, getSubcategories } from "@/shared/constants/product-categories";
import {
  MAX_UPLOAD_BYTES,
  ALLOWED_IMAGE_TYPES,
  MAX_PRODUCT_IMAGES,
} from "@/shared/constants/upload";

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
  description: string | null;
  images: string[];
}

interface BrandOrder {
  id: string;
  brandSubtotal: number; // 本品牌商品行小计（分），不含其他品牌金额
  status: string;
  createdAt: string;
  firstItemName: string;
  isDestroyed: boolean;
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

// ── 商品表单（提交页 / 编辑模态复用：字段 + 图片上传） ──

interface ProductFormValues {
  name: string;
  category: string;
  subCategory: string;
  price: number; // 元
  stock: number;
  description: string; // 已 trim，可为空字符串（编辑时传 "" 即清空）
  images: string[];
}

function ProductForm({
  initial,
  submitLabel,
  successMessage,
  resetAfterSuccess,
  onSubmit,
}: {
  initial?: BrandProduct;
  submitLabel: string;
  successMessage?: string;
  /** 提交成功后清空表单（提交页用；编辑模态由父级关闭） */
  resetAfterSuccess?: boolean;
  /** 提交动作；抛错则表单展示错误 */
  onSubmit: (values: ProductFormValues) => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: "",
    category: "",
    subCategory: "",
    price: "",
    stock: "",
    description: "",
  });
  const [images, setImages] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 编辑模态：进入时按初始值预填（price 分为单位 → 元展示）
  useEffect(() => {
    if (initial) {
      setForm({
        name: initial.name,
        category: initial.category,
        subCategory: initial.subCategory ?? "",
        price: String(initial.price / 100),
        stock: String(initial.stock),
        description: initial.description ?? "",
      });
      setImages(initial.images ?? []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅进入时预填一次，父级每次重建本组件
  }, []);

  /** 上传商品图：POST /api/upload（multipart 字段 file + purpose=product）→ 成功后追加 URL，最多 5 张 */
  const handleImageUpload = async (file: File) => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      setError("仅支持 JPG/PNG/WebP 图片");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("图片不能超过 4MB");
      return;
    }
    if (images.length >= MAX_PRODUCT_IMAGES) {
      setError(`最多上传 ${MAX_PRODUCT_IMAGES} 张图片`);
      return;
    }
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("purpose", "product");
      const res = await apiFetch("/api/upload", { method: "POST", body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // 后端 422 带 details（字段 → 具体原因），优先展示具体原因
        throw new Error(firstFieldError(data?.details) || data?.message || "上传失败");
      }
      setImages((prev) => [...prev, data.url]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "上传失败");
    } finally {
      setUploading(false);
    }
  };

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
      await onSubmit({
        name: form.name.trim(),
        category: form.category.trim(),
        subCategory: form.subCategory,
        price,
        stock,
        description: form.description.trim(),
        images,
      });
      setSuccess(successMessage || "已保存");
      if (resetAfterSuccess) {
        setForm({ name: "", category: "", subCategory: "", price: "", stock: "", description: "" });
        setImages([]);
      }
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
          {/* 商品图片：上传（POST /api/upload purpose=product）→ OSS URL 回填，最多 5 张 */}
          <div>
            <p className="text-xs font-medium text-gray-500">
              商品图片（选填，最多 {MAX_PRODUCT_IMAGES} 张）
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {images.map((url, i) => (
                <div key={url} className="relative">
                  <Image
                    src={url}
                    alt={`商品图片 ${i + 1}`}
                    width={64}
                    height={64}
                    className="h-16 w-16 rounded-lg border border-gray-100 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setImages((prev) => prev.filter((_, idx) => idx !== i))
                    }
                    aria-label={`删除第 ${i + 1} 张图片`}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gray-800 text-xs leading-none text-white transition hover:bg-gray-900"
                  >
                    ×
                  </button>
                </div>
              ))}
              {images.length < MAX_PRODUCT_IMAGES && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ALLOWED_IMAGE_TYPES.join(",")}
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleImageUpload(file);
                      e.target.value = ""; // 允许重复选择同一文件
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || submitting}
                    aria-label="上传商品图片"
                    className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-gray-300 text-2xl text-gray-400 transition hover:border-primary hover:text-primary disabled:opacity-50"
                  >
                    {uploading ? "…" : "+"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
        {error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
        {success && <div className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{success}</div>}
        <button
          onClick={handleSubmit}
          disabled={submitting || uploading}
          className="mt-4 w-full rounded-lg bg-primary py-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? (initial ? "保存中..." : "提交中...") : submitLabel}
        </button>
      </div>
    </div>
  );
}

// ── 提交商品 ──

function SubmitProductTab() {
  return (
    <ProductForm
      submitLabel="提交审核"
      successMessage="商品已提交，等待平台质检"
      resetAfterSuccess
      onSubmit={async (values) => {
        await apiCall("POST", "/api/brand/products", {
          ...values,
          description: values.description || undefined,
        });
      }}
    />
  );
}

// ── 我的商品 ──

function ProductsTab() {
  const [products, setProducts] = useState<BrandProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<BrandProduct | null>(null);
  const [notice, setNotice] = useState("");

  const load = async () => {
    const res = await apiFetch("/api/brand/products?pageSize=50");
    const data = await res.json();
    setProducts(data.items || []);
  };

  useEffect(() => {
    load()
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  /** 撤回/下架/重新上架：POST 成功后刷新列表 */
  const runAction = async (id: string, url: string) => {
    setBusyId(id);
    setError("");
    setNotice("");
    try {
      await apiCall("POST", url);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyId(null);
    }
  };

  const actionFor = (p: BrandProduct): { label: string; url: string }[] => {
    switch (p.status) {
      case "PENDING":
        return [{ label: "撤回", url: `/api/brand/products/${p.id}/withdraw` }];
      case "APPROVED":
        return [{ label: "下架", url: `/api/brand/products/${p.id}/delist` }];
      case "DELISTED":
        return [{ label: "重新上架", url: `/api/brand/products/${p.id}/relist` }];
      default:
        return []; // REJECTED/WITHDRAWN 仅可编辑（重提交）
    }
  };

  const handleEditSaved = async (result: { status?: string }) => {
    await load();
    setNotice(result.status === "PENDING" ? "已保存并重新提交质检" : "已保存");
    setEditing(null);
  };

  if (loading) {
    return <div className="h-32 animate-pulse rounded-xl bg-gray-100" />;
  }

  return (
    <div className="space-y-3">
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
      {notice && !editing && (
        <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</div>
      )}
      {products.length === 0 ? (
        <div className="py-12 text-center text-gray-400">暂无商品，请先提交</div>
      ) : (
        products.map((p) => {
          const actions = actionFor(p);
          return (
            <div key={p.id} className="rounded-xl border border-gray-100 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-gray-900">{p.name}</p>
                <StatusBadge status={p.status} />
              </div>
              <p className="mt-1 text-xs text-gray-400">
                {p.category}
                {p.subCategory ? ` / ${p.subCategory}` : ""} · ¥{fenToYuan(p.price)} · 库存 {p.stock} · 已售 {p.sales}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {actions.map((a) => (
                  <button
                    key={a.label}
                    onClick={() => runAction(p.id, a.url)}
                    disabled={busyId === p.id}
                    className="rounded-lg border border-gray-200 px-3 py-1 text-xs text-gray-600 transition hover:border-primary hover:text-primary disabled:opacity-50"
                  >
                    {busyId === p.id ? "处理中..." : a.label}
                  </button>
                ))}
                <button
                  onClick={() => setEditing(p)}
                  disabled={busyId === p.id}
                  className="rounded-lg bg-primary px-3 py-1 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  编辑
                </button>
              </div>
            </div>
          );
        })
      )}

      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setEditing(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-bold">编辑商品</h2>
              <button
                onClick={() => setEditing(null)}
                className="text-2xl leading-none text-gray-400 hover:text-gray-600"
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <ProductForm
              initial={editing}
              submitLabel="保存修改"
              onSubmit={async (values) => {
                const res = await apiCall("PATCH", `/api/brand/products/${editing.id}`, {
                  ...values,
                });
                await handleEditSaved(res as { status?: string });
              }}
            />
          </div>
        </div>
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
    <main className="mx-auto min-h-screen max-w-6xl bg-white pb-24">
      <SiteHeader />
      <div className="mx-auto w-full max-w-3xl px-4 pt-4">
        <h1 className="text-center text-xl font-bold text-gray-900">品牌中心</h1>
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition ${
                tab === t.key
                  ? "bg-linear-to-r from-primary to-accent text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl p-4 pt-3">
        {tab === "overview" && <OverviewTab />}
        {tab === "submit" && <SubmitProductTab />}
        {tab === "products" && <ProductsTab />}
        {tab === "orders" && <OrdersTab />}
      </div>
    </main>
  );
}
