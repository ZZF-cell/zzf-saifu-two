"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { apiFetch } from "@/shared/api/client";
import { fenToYuan } from "@/shared/utils/money";
import { WorkbenchHeader } from "@/shared/ui/WorkbenchHeader";
import { StatusBadge, STATUS_LABEL } from "@/shared/ui/StatusBadge";
import { Image } from "@/shared/ui/Image";
import { ConfirmModal } from "@/shared/ui/ConfirmModal";
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

interface ProductCertificate {
  url: string;
  name: string;
  mime: string;
}

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
  certificates: ProductCertificate[];
  specs: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
  brand: { id: string; name: string; logo: string | null } | null;
  qcTemplate: { requiredDocs: string[]; checkPoints: string[] } | null;
}

interface AuditTemplate {
  categoryId: string;
  requiredDocs: unknown;
  checkPoints: unknown;
}

/** 时间格式容错：无效时间 → 「时间未知」，避免 new Date(...).toLocaleString 抛 RangeError 白屏 */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "时间未知"
    : d.toLocaleString("zh-CN", { hour12: false });
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
  // 脏数据防御：certificates/images 来自品牌方提交，历史/异常数据可能缺 name 等字段，
  // 若结构不符在渲染期抛 TypeError/Invalid Date 会白屏整页（已复现）→ 先滤非对象项再容错取值
  const certList: ProductCertificate[] = Array.isArray(detail.certificates)
    ? detail.certificates.filter((c): c is ProductCertificate => Boolean(c && typeof c === "object"))
    : [];
  const imageList: string[] = Array.isArray(detail.images)
    ? detail.images.filter((u): u is string => typeof u === "string")
    : [];
  const requiredDocs = detail.qcTemplate ? strList(detail.qcTemplate.requiredDocs) : [];
  /** 必交材料是否已交：证书文件名与必交项文本互相包含即视为命中（模糊对照） */
  const certMet = (doc: string) =>
    certList.some(
      (c) => typeof c.name === "string" && (c.name.includes(doc) || doc.includes(c.name)),
    );

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

        {imageList.length > 0 && (
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
            {imageList.map((url, i) => (
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
          <p className="text-sm text-gray-400">
            品牌：{detail.brand?.name || "—"} · {detail.category}
            {detail.subCategory ? ` / ${detail.subCategory}` : ""}
          </p>
          <p className="text-sm text-gray-400">
            价格 ¥{fenToYuan(detail.price)} · 库存 {detail.stock} · 已售 {detail.sales}
          </p>
          <p className="text-sm text-gray-400">
            提交于 {formatDateTime(detail.createdAt)}
          </p>
          {detail.description && (
            <p className="rounded-lg bg-gray-50 px-4 py-3 text-sm leading-relaxed text-gray-600">
              {detail.description}
            </p>
          )}
          {specEntries.length > 0 && (
            <div className="rounded-lg border border-gray-100 p-3">
              <p className="text-sm font-medium text-gray-500">规格参数</p>
              <div className="mt-1 space-y-1">
                {specEntries.map(([k, v]) => (
                  <p key={k} className="text-sm text-gray-600">
                    <span className="text-gray-400">{k}：</span>
                    {v}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 已提交检测证书：PDF 新标签打开 / 图片缩略图 + 必交材料对照 */}
        <div className="mt-3 rounded-lg border border-gray-100 p-3">
          <p className="text-sm font-medium text-gray-500">
            已提交检测证书（{certList.length} 份）
          </p>
          {certList.length === 0 ? (
            <p className="mt-1 text-sm text-gray-400">该商品未提交证书</p>
          ) : (
            <div className="mt-2 space-y-2">
              {certList.map((cert, i) => (
                <div key={cert.url || cert.name || i} className="flex items-center gap-2">
                  {cert.mime === "application/pdf" ? (
                    <a
                      href={cert.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-w-0 flex-1 items-center gap-2 text-sm text-primary hover:underline"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-red-50 text-[10px] font-bold text-red-500">
                        PDF
                      </span>
                      <span className="truncate">{cert.name || "未命名证书"}</span>
                    </a>
                  ) : (
                    <a
                      href={cert.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-w-0 flex-1 items-center gap-2 text-sm text-gray-700 hover:underline"
                    >
                      <Image
                        src={cert.url}
                        alt={cert.name || "证书图片"}
                        width={32}
                        height={32}
                        className="h-8 w-8 shrink-0 rounded border border-gray-100 object-cover"
                      />
                      <span className="truncate">{cert.name || "未命名证书"}</span>
                    </a>
                  )}
                  <span className="shrink-0 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                    {cert.mime === "application/pdf" ? "PDF" : "图片"}
                  </span>
                </div>
              ))}
            </div>
          )}
          {requiredDocs.length > 0 && (
            <div className="mt-2 border-t border-gray-100 pt-2">
              <p className="text-xs font-medium text-gray-500">必交材料对照</p>
              <div className="mt-1 space-y-1">
                {requiredDocs.map((doc) => (
                  <p key={doc} className="flex items-center gap-2 text-xs text-gray-600">
                    <span
                      className={certMet(doc) ? "text-green-600" : "text-red-500"}
                    >
                      {certMet(doc) ? "已交" : "缺"}
                    </span>
                    <span className="truncate">{doc}</span>
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 质检清单：该品类 CategoryAuditTemplate 的必交材料 + 检查项 */}
        <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
          <p className="text-sm font-medium text-primary">质检清单（{detail.category}）</p>
          <div className="mt-1 space-y-1 text-sm text-gray-600">
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

// ── 商品质检 Tab（PENDING→通过/驳回 + 下架/重新上架 + 详情/编辑） ──

function ProductReviewTab({
  statusFilter,
  onStatusFilterChange,
  active,
}: {
  statusFilter: string;
  active?: boolean;
  onStatusFilterChange: (s: string) => void;
}) {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<AdminProductDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editProduct, setEditProduct] = useState<AdminProductDetail | null>(null);
  const [notice, setNotice] = useState("");

  // 客户端过滤：首载一次拉全量，之后切状态药丸即时过滤，零网络往返、零延迟
  const loadedOnce = useRef(false);

  const fetchProducts = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    try {
      // 筛选由客户端完成：一次拉全量（含 PENDING/APPROVED/DELISTED 等在内存过滤）
      const data = await apiCall("GET", "/api/admin/products?pageSize=100");
      setProducts(data.items || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "商品列表加载失败");
    } finally {
      loadedOnce.current = true;
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);
  // 切回本 Tab 时静默刷新（已加载过不重建骨架）
  useEffect(() => {
    if (active && loadedOnce.current) void fetchProducts();
  }, [active, fetchProducts]);

  // 客户端过滤：状态精确匹配
  const filteredProducts = useMemo(
    () => (statusFilter ? products.filter((p) => p.status === statusFilter) : products),
    [products, statusFilter],
  );

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
      // 本地更新上下架状态，列表即时重算，无需重拉全量
      setProducts((prev) =>
        prev.map((p) => (p.id === id ? { ...p, status: action === "delist" ? "DELISTED" : "APPROVED" } : p)),
      );
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
        {["", "PENDING", "APPROVED", "DELISTED", "REJECTED", "WITHDRAWN"].map((s) => (
          <button
            key={s}
            onClick={() => onStatusFilterChange(s)}
            className={`shrink-0 rounded-full px-4 py-2 text-sm transition ${
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
      {/* 列表固定高度 + 内部滚动：切状态药丸时页面永不重排 */}
      <div className="h-[calc(100vh-14rem)] overflow-y-auto rounded-xl">
      {loading ? (
        <div className="h-32 animate-pulse rounded-xl bg-gray-100" />
      ) : filteredProducts.length === 0 ? (
        <div className="flex min-h-[40vh] items-center justify-center text-center text-gray-400">
          {statusFilter ? "该状态下暂无商品" : "暂无商品"}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredProducts.map((p) => {
          const lc = lifecycleAction(p);
          return (
            <div key={p.id} className="rounded-2xl border border-gray-100 p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-base font-semibold text-gray-900">{p.name}</p>
                <StatusBadge status={p.status} />
              </div>
              <p className="mt-0.5 text-sm text-gray-400">
                {p.brandName} · {p.category}
                {p.subCategory ? ` / ${p.subCategory}` : ""} · ¥{fenToYuan(p.price)} · 库存 {p.stock}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {p.status === "PENDING" && (
                  <>
                    <button
                      onClick={() => handleReview(p.id, "APPROVED")}
                      disabled={acting === p.id}
                      className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                    >
                      通过
                    </button>
                    <button
                      onClick={() => handleReview(p.id, "REJECTED")}
                      disabled={acting === p.id}
                      className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
                    >
                      拒绝
                    </button>
                  </>
                )}
                {lc && (
                  <button
                    onClick={() => handleLifecycle(p.id, lc.action)}
                    disabled={acting === p.id}
                    className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition hover:border-primary hover:text-primary disabled:opacity-50"
                  >
                    {acting === p.id ? "处理中..." : lc.label}
                  </button>
                )}
                <button
                  onClick={() => openDetail(p.id)}
                  disabled={detailLoading || acting === p.id}
                  className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-700 disabled:opacity-50"
                >
                  详情
                </button>
                <button
                  onClick={() => openEdit(p.id)}
                  disabled={detailLoading || acting === p.id}
                  className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition hover:border-primary hover:text-primary disabled:opacity-50"
                >
                  编辑
                </button>
              </div>
            </div>
          );
          })}
        </div>
      )}
      </div>

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

// ── 质检模板 Tab（该品类必交材料 + 检查项，品牌方提交商品按此清单要求） ──

function TemplatesTab({ active }: { active?: boolean }) {
  const [templates, setTemplates] = useState<AuditTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [acting, setActing] = useState(false);
  const [editing, setEditing] = useState<AuditTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AuditTemplate | null>(null);

  const fetchTemplates = useCallback(async () => {
    try {
      const data = await apiCall("GET", "/api/admin/audit-templates");
      setTemplates(data.items || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "模板加载失败");
    }
  }, []);

  useEffect(() => {
    fetchTemplates().finally(() => setLoading(false));
  }, [fetchTemplates]);
  // 切回本 Tab 时静默刷新（保留旧列表，无骨架）
  useEffect(() => {
    if (active) void fetchTemplates();
  }, [active, fetchTemplates]);

  const handleSave = async (input: {
    categoryId: string;
    requiredDocs: string[];
    checkPoints: string[];
  }): Promise<boolean> => {
    setError("");
    try {
      const res = await apiFetch("/api/admin/audit-templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "保存失败");
      await fetchTemplates();
      setEditing(null);
      setCreating(false);
      setNotice("模板已保存");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
      return false;
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setActing(true);
    setError("");
    try {
      const res = await apiFetch(
        `/api/admin/audit-templates?categoryId=${encodeURIComponent(deleteTarget.categoryId)}`,
        { method: "DELETE" },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "删除失败");
      setTemplates((prev) => prev.filter((t) => t.categoryId !== deleteTarget.categoryId));
      setNotice("模板已删除");
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setActing(false);
      setDeleteTarget(null);
    }
  };

  if (loading) {
    return <div className="h-32 animate-pulse rounded-xl bg-gray-100" />;
  }

  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : [];

  return (
    <div className="space-y-3">
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
      {notice && (
        <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</div>
      )}

      <div className="flex items-center justify-between pb-1">
        <p className="text-sm text-gray-400">
          共 {templates.length} 个大类已配置（品牌方提交商品时将按此清单要求必交材料）
        </p>
        <button
          onClick={() => setCreating(true)}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
        >
          + 新增模板
        </button>
      </div>

      {/* 列表固定高度 + 内部滚动：与「商品质检」Tab 同高 → 切换 Tab 页面永不重排 */}
      <div className="h-[calc(100vh-14rem)] overflow-y-auto rounded-xl">
      {templates.length === 0 ? (
        <div className="flex min-h-[40vh] items-center justify-center text-center text-gray-400">
          暂无质检模板
        </div>
      ) : (
        <div className="space-y-3">
        {templates.map((t) => (
          <div key={t.categoryId} className="rounded-2xl border border-gray-100 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-semibold text-gray-900">{t.categoryId}</p>
                <div className="mt-2 space-y-1 text-sm text-gray-500">
                  <p>
                    必交材料：{strList(t.requiredDocs).join("、") || "—"}
                  </p>
                  <p>
                    检查项：{strList(t.checkPoints).join("、") || "—"}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => setEditing(t)}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 transition hover:bg-gray-50"
                >
                  编辑
                </button>
                <button
                  onClick={() => setDeleteTarget(t)}
                  className="rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-600 transition hover:bg-red-50"
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        ))}
        </div>
      )}
      </div>

      {(editing || creating) && (
        <TemplateModal
          template={editing}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSave={handleSave}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          title="删除质检模板"
          message={`确认删除「${deleteTarget.categoryId}」的质检模板？删除后该品类商品审核将无质检清单对照。`}
          confirmLabel="删除"
          loading={acting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}

// ── 质检模板编辑/新增弹窗：大类下拉 + 必交材料/检查项多行文本（每行一项） ──

function TemplateModal({
  template,
  onClose,
  onSave,
}: {
  template: AuditTemplate | null; // null = 新增
  onClose: () => void;
  onSave: (input: { categoryId: string; requiredDocs: string[]; checkPoints: string[] }) => Promise<boolean>;
}) {
  const [categoryId, setCategoryId] = useState(template?.categoryId ?? "");
  const [requiredDocs, setRequiredDocs] = useState(
    (Array.isArray(template?.requiredDocs) ? (template!.requiredDocs as unknown[]).map(String) : []).join("\n"),
  );
  const [checkPoints, setCheckPoints] = useState(
    (Array.isArray(template?.checkPoints) ? (template!.checkPoints as unknown[]).map(String) : []).join("\n"),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const splitLines = (s: string): string[] =>
    s
      .split(/\n|，|、|,/)
      .map((x) => x.trim())
      .filter(Boolean);

  const submit = async () => {
    setError("");
    if (!categoryId) {
      setError("请选择大类");
      return;
    }
    setLoading(true);
    const ok = await onSave({
      categoryId,
      requiredDocs: splitLines(requiredDocs),
      checkPoints: splitLines(checkPoints),
    });
    setLoading(false);
    if (!ok) setError("保存失败，请重试");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-bold">{template ? `编辑质检模板（${template.categoryId}）` : "新增质检模板"}</h3>

        <label className="mt-3 block">
          <span className="text-sm text-gray-500">大类</span>
          <select
            value={categoryId}
            disabled={!!template} // 编辑态大类不可改（categoryId 是唯一键）
            onChange={(e) => setCategoryId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-primary disabled:bg-gray-50"
          >
            <option value="">选择大类</option>
            {PRODUCT_CATEGORIES.map((c) => (
              <option key={c.category} value={c.category}>{c.category}</option>
            ))}
          </select>
        </label>

        <label className="mt-3 block">
          <span className="text-sm text-gray-500">必交材料（每行一项，支持逗号/顿号分隔）</span>
          <textarea
            value={requiredDocs}
            onChange={(e) => setRequiredDocs(e.target.value)}
            rows={3}
            placeholder={"例如：\n生产许可证\n第三方检测报告"}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-primary"
          />
        </label>

        <label className="mt-3 block">
          <span className="text-sm text-gray-500">检查项（每行一项）</span>
          <textarea
            value={checkPoints}
            onChange={(e) => setCheckPoints(e.target.value)}
            rows={3}
            placeholder={"例如：\n是否在有效期内\n检测项目覆盖国标"}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-primary"
          />
        </label>

        {error && <p className="mt-2 text-sm text-red-500">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={loading}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 质检中心主页面（/inspect）：商品质检 + 质检模板，与管理后台职责隔离 ──

export function InspectCenterPage() {
  const [tab, setTab] = useState<"products" | "templates">("products");
  const [statusFilter, setStatusFilter] = useState("PENDING");

  return (
    <main className="mx-auto min-h-screen max-w-6xl bg-white pb-24">
      <WorkbenchHeader title="质检中心" />
      <div className="mx-auto w-full max-w-5xl px-4 pt-4">
        <h1 className="text-center text-xl font-bold text-gray-900">质检中心</h1>
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          <button
            onClick={() => setTab("products")}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition ${
              tab === "products"
                ? "bg-linear-to-r from-primary to-accent text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            商品质检
          </button>
          <button
            onClick={() => setTab("templates")}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition ${
              tab === "templates"
                ? "bg-linear-to-r from-primary to-accent text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            质检模板
          </button>
        </div>
      </div>
      <div className="mx-auto w-full max-w-5xl p-4 pt-3">
        {/* 常驻挂载 + hidden 切换：切 Tab 不卸载/重挂 → 不重建骨架、不高度塌缩 */}
        <div className={tab === "products" ? "" : "hidden"}>
          <ProductReviewTab
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            active={tab === "products"}
          />
        </div>
        <div className={tab === "templates" ? "" : "hidden"}>
          <TemplatesTab active={tab === "templates"} />
        </div>
      </div>
    </main>
  );
}
