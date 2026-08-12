"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/shared/api/client";
import { fenToYuan } from "@/shared/utils/money";

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
  price: number;
  stock: number;
  status: string;
  sales: number;
  brandName: string;
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

const STATUS_LABEL: Record<string, string> = {
  PENDING: "待处理",
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

function ProductReviewTab() {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");

  const fetchProducts = useCallback(async () => {
    try {
      const data = await apiCall("GET", "/api/admin/products?status=PENDING&pageSize=50");
      setProducts(data.items || []);
    } catch { /* 静默 */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

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

  if (loading) {
    return <div className="h-32 animate-pulse rounded-xl bg-gray-100" />;
  }

  return (
    <div className="space-y-3">
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
      {products.length === 0 ? (
        <div className="py-12 text-center text-gray-400">暂无待质检商品</div>
      ) : (
        products.map((p) => (
          <div key={p.id} className="flex items-center justify-between rounded-xl border border-gray-100 p-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900">{p.name}</p>
              <p className="mt-0.5 text-xs text-gray-400">
                {p.brandName} · {p.category} · ¥{fenToYuan(p.price)} · 库存 {p.stock}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
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
            </div>
          </div>
        ))
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

// ── 主页面 ──

type TabKey = "dashboard" | "brands" | "products" | "orders" | "users" | "templates";

const TABS: { key: TabKey; label: string }[] = [
  { key: "dashboard", label: "数据看板" },
  { key: "brands", label: "品牌审核" },
  { key: "products", label: "商品质检" },
  { key: "orders", label: "订单管理" },
  { key: "users", label: "用户管理" },
  { key: "templates", label: "质检模板" },
];

export function AdminDashboardPage() {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>("dashboard");

  const handleLogout = async () => {
    try {
      await apiCall("POST", "/api/auth/logout");
    } catch { /* 静默 */ }
    router.push("/login");
  };

  return (
    <main className="mx-auto min-h-screen max-w-lg bg-white pb-24">
      <div className="sticky top-0 z-10 border-b bg-white/90 backdrop-blur px-4 py-3">
        <div className="flex items-center justify-between">
          <h1 className="text-center text-base font-bold">管理后台</h1>
          <div className="flex gap-2">
            <button
              onClick={() => router.push("/")}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50"
            >
              商城首页
            </button>
            <button
              onClick={handleLogout}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50"
            >
              退出登录
            </button>
          </div>
        </div>
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
        {tab === "dashboard" && <DashboardTab />}
        {tab === "brands" && <BrandReviewTab />}
        {tab === "products" && <ProductReviewTab />}
        {tab === "orders" && <OrdersTab />}
        {tab === "users" && <UsersTab />}
        {tab === "templates" && <TemplatesTab />}
      </div>
    </main>
  );
}
