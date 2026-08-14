"use client";

import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/shared/api/client";
import { fenToYuan } from "@/shared/utils/money";
import { SiteHeader } from "@/shared/ui/SiteHeader";
import { StatusBadge, STATUS_LABEL } from "@/shared/ui/StatusBadge";
import { Image } from "@/shared/ui/Image";
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

interface DashboardStats {
  userCount: number;
  brandCount: number;
  pendingBrandCount: number;
  productCount: number;
  pendingProductCount: number;
  orderCount: number;
  pendingRefundCount: number;
  paidRevenue: number;
}

interface AdminBrand {
  id: string;
  name: string;
  logo: string | null;
  status: string;
  inviteCode: string;
  createdAt: string;
  productCount: number;
  ownerNickname: string | null;
}

interface AdminProduct {
  id: string;
  name: string;
  category: string;
  subCategory: string | null;
  price: number;
  stock: number;
  status: string;
  sales: number;
  brandName: string;
}

/** 管理端商品详情（GET /api/admin/products/[id]）：完整信息 + 该品类质检清单 */
interface AdminProductDetail {
  id: string;
  name: string;
  description: string | null;
  category: string;
  subCategory: string | null;
  price: number; // 分
  stock: number;
  status: string;
  sales: number;
  images: string[];
  specs: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
  brand: { id: string; name: string; logo: string | null } | null;
  qcTemplate: { requiredDocs: string[]; checkPoints: string[] } | null;
}

interface AdminOrder {
  id: string;
  userId: string;
  total: number;
  status: string;
  createdAt: string;
  paidAt: string | null;
  firstItemName: string;
  isDestroyed: boolean;
}

interface AdminUser {
  id: string;
  role: string;
  nickname: string | null;
  ageVerified: boolean;
  createdAt: string;
  orderCount: number;
}

interface AuditTemplate {
  categoryId: string;
  requiredDocs: unknown;
  checkPoints: unknown;
}

interface AdminInviteCode {
  id: string;
  code: string;
  status: string; // UNUSED | USED | EXPIRED
  createdBy: string;
  usedBy: string | null;
  createdAt: string;
  usedAt: string | null;
  expiresAt: string | null;
}

// ── 标签页组件 ──

function DashboardTab() {
  const [stats, setStats] = useState<DashboardStats | null>(null);

  useEffect(() => {
    apiFetch("/api/admin/dashboard")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  if (!stats) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-gray-100" />
        ))}
      </div>
    );
  }

  const cards: { label: string; value: string; highlight?: boolean }[] = [
    { label: "用户数", value: String(stats.userCount) },
    { label: "品牌数", value: String(stats.brandCount) },
    { label: "待审品牌", value: String(stats.pendingBrandCount), highlight: true },
    { label: "商品数", value: String(stats.productCount) },
    { label: "待审商品", value: String(stats.pendingProductCount), highlight: true },
    { label: "订单数", value: String(stats.orderCount) },
    { label: "待退款", value: String(stats.pendingRefundCount), highlight: true },
    { label: "已支付销售额", value: `¥${fenToYuan(stats.paidRevenue)}` },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((c) => (
        <div
          key={c.label}
          className={`rounded-xl p-4 ${c.highlight ? "bg-primary/5" : "bg-gray-50"}`}
        >
          <p className={`text-xl font-bold ${c.highlight ? "text-primary" : "text-gray-900"}`}>
            {c.value}
          </p>
          <p className="mt-1 text-xs text-gray-500">{c.label}</p>
        </div>
      ))}
    </div>
  );
}

function BrandReviewTab() {
  const [brands, setBrands] = useState<AdminBrand[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");

  const fetchBrands = useCallback(async () => {
    try {
      const data = await apiCall("GET", "/api/admin/brands?status=PENDING");
      setBrands(data.items || []);
    } catch { /* 静默 */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchBrands(); }, [fetchBrands]);

  const handleReview = async (id: string, decision: "APPROVED" | "REJECTED") => {
    setActing(id);
    setError("");
    try {
      await apiCall("POST", `/api/admin/brands/${id}/review`, { decision });
      setBrands((prev) => prev.filter((b) => b.id !== id));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setActing(null);
    }
  };

  if (loading) {
    return <div className="h-32 animate-pulse rounded-xl bg-gray-100" />;
  }

  return (
    <div className="space-y-3">
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
      {brands.length === 0 ? (
        <div className="py-12 text-center text-gray-400">暂无待审核品牌</div>
      ) : (
        brands.map((b) => (
          <div key={b.id} className="flex items-center justify-between rounded-xl border border-gray-100 p-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900">{b.name}</p>
              <p className="mt-0.5 text-xs text-gray-400">
                入驻码 {b.inviteCode} · 商品 {b.productCount} 个
                {b.ownerNickname ? ` · 负责人 ${b.ownerNickname}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                onClick={() => handleReview(b.id, "APPROVED")}
                disabled={acting === b.id}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
              >
                通过
              </button>
              <button
                onClick={() => handleReview(b.id, "REJECTED")}
                disabled={acting === b.id}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
              >
                拒绝
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ── 商品详情模态（完整信息 + 该品类质检清单，审核决策闭环） ──

function ProductDetailModal({
  detail,
  onClose,
}: {
  detail: AdminProductDetail;
  onClose: () => void;
}) {
  const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const specEntries = detail.specs ? Object.entries(detail.specs) : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold">商品详情</h2>
          <button
            onClick={onClose}
            className="text-2xl leading-none text-gray-400 hover:text-gray-600"
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        {detail.images.length > 0 && (
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
            {detail.images.map((url, i) => (
              <Image
                key={url}
                src={url}
                alt={`${detail.name} 图 ${i + 1}`}
                width={80}
                height={80}
                className="h-20 w-20 shrink-0 rounded-lg border border-gray-100 object-cover"
              />
            ))}
          </div>
        )}

        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <p className="font-medium text-gray-900">{detail.name}</p>
            <StatusBadge status={detail.status} />
          </div>
          <p className="text-xs text-gray-400">
            品牌：{detail.brand?.name || "—"} · {detail.category}
            {detail.subCategory ? ` / ${detail.subCategory}` : ""}
          </p>
          <p className="text-xs text-gray-400">
            价格 ¥{fenToYuan(detail.price)} · 库存 {detail.stock} · 已售 {detail.sales}
          </p>
          <p className="text-xs text-gray-400">
            提交于 {new Date(detail.createdAt).toLocaleString("zh-CN", { hour12: false })}
          </p>
          {detail.description && (
            <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-600">
              {detail.description}
            </p>
          )}
          {specEntries.length > 0 && (
            <div className="rounded-lg border border-gray-100 p-3">
              <p className="text-xs font-medium text-gray-500">规格参数</p>
              <div className="mt-1 space-y-1">
                {specEntries.map(([k, v]) => (
                  <p key={k} className="text-xs text-gray-600">
                    <span className="text-gray-400">{k}：</span>
                    {v}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 质检清单：该品类 CategoryAuditTemplate 的必交材料 + 检查项 */}
        <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
          <p className="text-xs font-medium text-primary">质检清单（{detail.category}）</p>
          <div className="mt-1 space-y-1 text-xs text-gray-600">
            <p>
              必交材料：{detail.qcTemplate ? strList(detail.qcTemplate.requiredDocs).join("、") || "—" : "暂无该品类质检模板"}
            </p>
            <p>
              检查项：{detail.qcTemplate ? strList(detail.qcTemplate.checkPoints).join("、") || "—" : "暂无该品类质检模板"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 管理端编辑模态（紧凑表单，字段集与品牌一致但独立实现，不跨模块 import） ──

function AdminProductEditForm({
  product,
  onSaved,
}: {
  product: AdminProductDetail;
  onSaved: (result: { status?: string }) => void;
}) {
  const [form, setForm] = useState({
    name: product.name,
    category: product.category,
    subCategory: product.subCategory ?? "",
    price: String(product.price / 100),
    stock: String(product.stock),
    description: product.description ?? "",
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
      const res = await apiCall("PATCH", `/api/admin/products/${product.id}`, {
        name: form.name.trim(),
        category: form.category.trim(),
        subCategory: form.subCategory,
        price,
        stock,
        description: form.description.trim(),
      });
      setSuccess("已保存");
      onSaved(res as { status?: string });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
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
            onChange={(e) => setForm({ ...form, category: e.target.value, subCategory: "" })}
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
            <option value="">{form.category ? "请选择子类" : "请先选择大类"}</option>
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
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
      {success && <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{success}</div>}
      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full rounded-lg bg-primary py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
      >
        {submitting ? "保存中..." : "保存修改"}
      </button>
    </div>
  );
}

function ProductReviewTab() {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [statusFilter, setStatusFilter] = useState("PENDING");
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<AdminProductDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editProduct, setEditProduct] = useState<AdminProductDetail | null>(null);
  const [notice, setNotice] = useState("");

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const url = `/api/admin/products?pageSize=50${statusFilter ? `&status=${statusFilter}` : ""}`;
      const data = await apiCall("GET", url);
      setProducts(data.items || []);
    } catch { /* 静默 */ } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  /** 拉取商品详情（详情/编辑模态共用；详情接口含质检清单） */
  const fetchDetail = async (id: string): Promise<AdminProductDetail> => {
    setDetailLoading(true);
    try {
      return await apiCall("GET", `/api/admin/products/${id}`);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleReview = async (id: string, decision: "APPROVED" | "REJECTED") => {
    setActing(id);
    setError("");
    try {
      await apiCall("POST", `/api/admin/products/${id}/review`, { decision });
      setProducts((prev) => prev.filter((p) => p.id !== id));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setActing(null);
    }
  };

  const handleLifecycle = async (id: string, action: "delist" | "relist") => {
    setActing(id);
    setError("");
    try {
      await apiCall("POST", `/api/admin/products/${id}/${action}`);
      await fetchProducts();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setActing(null);
    }
  };

  const openDetail = async (id: string) => {
    setError("");
    try {
      const d = await fetchDetail(id);
      setDetail(d);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "加载详情失败");
    }
  };

  const openEdit = async (id: string) => {
    setError("");
    try {
      const d = await fetchDetail(id);
      setEditProduct(d);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "加载商品失败");
    }
  };

  const handleEditSaved = async (result: { status?: string }) => {
    await fetchProducts();
    setNotice(result.status === "PENDING" ? "已保存并回到待审（改动了基本信息）" : "已保存");
    setEditProduct(null);
  };

  const lifecycleAction = (p: AdminProduct): { label: string; action: "delist" | "relist" } | null => {
    if (p.status === "APPROVED") return { label: "下架", action: "delist" };
    if (p.status === "DELISTED") return { label: "重新上架", action: "relist" };
    return null;
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {["PENDING", "APPROVED", "DELISTED", "REJECTED", "WITHDRAWN", ""].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`shrink-0 rounded-full px-3 py-1 text-xs transition ${
              statusFilter === s
                ? "bg-primary text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {STATUS_LABEL[s] || "全部"}
          </button>
        ))}
      </div>
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
      {notice && !editProduct && (
        <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</div>
      )}
      {loading ? (
        <div className="h-32 animate-pulse rounded-xl bg-gray-100" />
      ) : products.length === 0 ? (
        <div className="py-12 text-center text-gray-400">
          {statusFilter ? "该状态下暂无商品" : "暂无商品"}
        </div>
      ) : (
        products.map((p) => {
          const lc = lifecycleAction(p);
          return (
            <div key={p.id} className="rounded-xl border border-gray-100 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-gray-900">{p.name}</p>
                <StatusBadge status={p.status} />
              </div>
              <p className="mt-0.5 text-xs text-gray-400">
                {p.brandName} · {p.category}
                {p.subCategory ? ` / ${p.subCategory}` : ""} · ¥{fenToYuan(p.price)} · 库存 {p.stock}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {p.status === "PENDING" && (
                  <>
                    <button
                      onClick={() => handleReview(p.id, "APPROVED")}
                      disabled={acting === p.id}
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                    >
                      通过
                    </button>
                    <button
                      onClick={() => handleReview(p.id, "REJECTED")}
                      disabled={acting === p.id}
                      className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
                    >
                      拒绝
                    </button>
                  </>
                )}
                {lc && (
                  <button
                    onClick={() => handleLifecycle(p.id, lc.action)}
                    disabled={acting === p.id}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:border-primary hover:text-primary disabled:opacity-50"
                  >
                    {acting === p.id ? "处理中..." : lc.label}
                  </button>
                )}
                <button
                  onClick={() => openDetail(p.id)}
                  disabled={detailLoading || acting === p.id}
                  className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-gray-700 disabled:opacity-50"
                >
                  详情
                </button>
                <button
                  onClick={() => openEdit(p.id)}
                  disabled={detailLoading || acting === p.id}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:border-primary hover:text-primary disabled:opacity-50"
                >
                  编辑
                </button>
              </div>
            </div>
          );
        })
      )}

      {detail && (
        <ProductDetailModal detail={detail} onClose={() => setDetail(null)} />
      )}

      {editProduct && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setEditProduct(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-bold">编辑商品</h2>
              <button
                onClick={() => setEditProduct(null)}
                className="text-2xl leading-none text-gray-400 hover:text-gray-600"
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <AdminProductEditForm
              product={editProduct}
              onSaved={handleEditSaved}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function OrdersTab() {
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const url = `/api/admin/orders?pageSize=50${statusFilter ? `&status=${statusFilter}` : ""}`;
      const data = await apiCall("GET", url);
      setOrders(data.orders || []);
    } catch { /* 静默 */ } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  const handleAction = async (orderId: string, action: string) => {
    setActing(orderId);
    setError("");
    try {
      await apiCall("POST", `/api/admin/orders/${orderId}/${action}`);
      await fetchOrders();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {["", "PENDING", "PAID", "SHIPPED", "REFUND_REQUESTED", "COMPLETED", "CANCELLED"].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`shrink-0 rounded-full px-3 py-1 text-xs transition ${
              statusFilter === s
                ? "bg-primary text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {STATUS_LABEL[s] || "全部"}
          </button>
        ))}
      </div>
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
      {loading ? (
        <div className="h-32 animate-pulse rounded-xl bg-gray-100" />
      ) : orders.length === 0 ? (
        <div className="py-12 text-center text-gray-400">暂无订单</div>
      ) : (
        orders.map((o) => (
          <div key={o.id} className="flex items-center justify-between rounded-xl border border-gray-100 p-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900">{o.firstItemName}</p>
              <p className="mt-0.5 text-xs text-gray-400">
                <StatusBadge status={o.status} /> · ¥{fenToYuan(o.total)}
                {o.isDestroyed && <span className="ml-1 text-red-400">已销毁</span>}
              </p>
              <p className="mt-0.5 truncate text-xs text-gray-400">订单号 {o.id}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              {o.status === "PAID" && (
                <button
                  onClick={() => handleAction(o.id, "ship")}
                  disabled={acting === o.id}
                  className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  发货
                </button>
              )}
              {o.status === "SHIPPED" && (
                <button
                  onClick={() => handleAction(o.id, "deliver")}
                  disabled={acting === o.id}
                  className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  标记送达
                </button>
              )}
              {o.status === "DELIVERED" && (
                <button
                  onClick={() => handleAction(o.id, "complete")}
                  disabled={acting === o.id}
                  className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  完成
                </button>
              )}
              {o.status === "REFUND_REQUESTED" && (
                <button
                  onClick={() => handleAction(o.id, "refund-confirm")}
                  disabled={acting === o.id}
                  className="rounded-lg border border-orange-200 px-3 py-1.5 text-xs font-medium text-orange-600 transition hover:bg-orange-50 disabled:opacity-50"
                >
                  确认退款
                </button>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/api/admin/users?pageSize=50")
      .then((r) => r.json())
      .then((data) => setUsers(data.items || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="h-32 animate-pulse rounded-xl bg-gray-100" />;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-100">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-gray-50 text-left text-xs text-gray-500">
            <th className="px-3 py-2 font-medium">ID</th>
            <th className="px-3 py-2 font-medium">角色</th>
            <th className="px-3 py-2 font-medium">昵称</th>
            <th className="px-3 py-2 font-medium">年龄验证</th>
            <th className="px-3 py-2 font-medium">订单数</th>
            <th className="px-3 py-2 font-medium">注册时间</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b border-gray-50 last:border-0">
              <td className="max-w-[120px] truncate px-3 py-2 text-xs text-gray-400">{u.id}</td>
              <td className="px-3 py-2 text-xs">{u.role}</td>
              <td className="px-3 py-2 text-xs text-gray-900">{u.nickname || "—"}</td>
              <td className="px-3 py-2 text-xs">{u.ageVerified ? "✓" : "—"}</td>
              <td className="px-3 py-2 text-xs">{u.orderCount}</td>
              <td className="px-3 py-2 text-xs text-gray-400">
                {new Date(u.createdAt).toLocaleDateString("zh-CN")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TemplatesTab() {
  const [templates, setTemplates] = useState<AuditTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/api/admin/audit-templates")
      .then((r) => r.json())
      .then((data) => setTemplates(data.items || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="h-32 animate-pulse rounded-xl bg-gray-100" />;
  }

  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : [];

  return (
    <div className="space-y-3">
      {templates.length === 0 ? (
        <div className="py-12 text-center text-gray-400">暂无质检模板</div>
      ) : (
        templates.map((t) => (
          <div key={t.categoryId} className="rounded-xl border border-gray-100 p-4">
            <p className="text-sm font-medium text-gray-900">{t.categoryId}</p>
            <div className="mt-2 space-y-1 text-xs text-gray-500">
              <p>必交材料：{strList(t.requiredDocs).join("、") || "—"}</p>
              <p>检查项：{strList(t.checkPoints).join("、") || "—"}</p>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function InviteCodesTab() {
  const [codes, setCodes] = useState<AdminInviteCode[]>([]);
  const [count, setCount] = useState(5);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  const fetchCodes = useCallback(async () => {
    try {
      const data = await apiCall("GET", "/api/admin/invite-codes?pageSize=50");
      setCodes(data.items || []);
    } catch { /* 静默 */ }
  }, []);

  useEffect(() => { fetchCodes(); }, [fetchCodes]);

  const handleGenerate = async () => {
    setGenerating(true);
    setError("");
    try {
      await apiCall("POST", "/api/admin/invite-codes", { count });
      await fetchCodes();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setGenerating(false);
    }
  };

  const fmtTime = (v: string | null) =>
    v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "—";

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-gray-100 p-4">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900">生成入驻邀请码</p>
            <p className="mt-0.5 text-xs text-gray-400">格式 INV-XXXX-XXXX，发放给意向品牌方</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <input
              type="number"
              min={1}
              max={100}
              value={count}
              onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
              className="w-20 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {generating ? "生成中…" : "生成"}
            </button>
          </div>
        </div>
        {error && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
      </div>

      {codes.length === 0 ? (
        <div className="py-12 text-center text-gray-400">暂无邀请码</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-100">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-xs text-gray-500">
                <th className="px-3 py-2 font-medium">邀请码</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">使用人</th>
                <th className="px-3 py-2 font-medium">过期时间</th>
                <th className="px-3 py-2 font-medium">使用时间</th>
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.id} className="border-b border-gray-50 last:border-0">
                  <td className="px-3 py-2 font-mono text-xs text-gray-900">{c.code}</td>
                  <td className="px-3 py-2 text-xs">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="max-w-[120px] truncate px-3 py-2 text-xs text-gray-400">
                    {c.usedBy ? (
                      <>
                        {c.usedBy.slice(0, 12)}…
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-400">{fmtTime(c.expiresAt)}</td>
                  <td className="px-3 py-2 text-xs text-gray-400">{fmtTime(c.usedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── 主页面 ──

type TabKey = "dashboard" | "brands" | "products" | "orders" | "users" | "templates" | "invites";

const TABS: { key: TabKey; label: string }[] = [
  { key: "dashboard", label: "数据看板" },
  { key: "brands", label: "品牌审核" },
  { key: "products", label: "商品质检" },
  { key: "orders", label: "订单管理" },
  { key: "users", label: "用户管理" },
  { key: "templates", label: "质检模板" },
  { key: "invites", label: "邀请码" },
];

export function AdminDashboardPage() {
  const [tab, setTab] = useState<TabKey>("dashboard");

  return (
    <main className="mx-auto min-h-screen max-w-6xl bg-white pb-24">
      <SiteHeader />
      <div className="mx-auto w-full max-w-lg px-4 pt-3">
        <h1 className="text-center text-base font-bold">管理后台</h1>
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

      <div className="mx-auto w-full max-w-lg p-4">
        {tab === "dashboard" && <DashboardTab />}
        {tab === "brands" && <BrandReviewTab />}
        {tab === "products" && <ProductReviewTab />}
        {tab === "orders" && <OrdersTab />}
        {tab === "users" && <UsersTab />}
        {tab === "templates" && <TemplatesTab />}
        {tab === "invites" && <InviteCodesTab />}
      </div>
    </main>
  );
}
