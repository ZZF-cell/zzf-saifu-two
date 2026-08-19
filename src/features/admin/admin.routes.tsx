"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { apiFetch } from "@/shared/api/client";
import { fenToYuan } from "@/shared/utils/money";
import { SiteHeader } from "@/shared/ui/SiteHeader";
import { StatusBadge, STATUS_LABEL } from "@/shared/ui/StatusBadge";
import { ConfirmModal } from "@/shared/ui/ConfirmModal";

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

/** 售后动作 → 目标状态：动作成功后本地更新订单状态，避免整表重拉（保持零抖动切换） */
const ACTION_STATUS: Record<string, string> = {
  ship: "SHIPPED",
  deliver: "DELIVERED",
  complete: "COMPLETED",
  "refund-confirm": "REFUNDED",
};

// ── 类型 ──

interface DashboardStats {
  userCount: number;
  brandCount: number;
  pendingBrandCount: number;
  approvedProductCount: number; // 在售商品（仅 APPROVED）
  delistedProductCount: number; // 已下架商品（DELISTED）
  pendingProductCount: number;
  orderCount: number;
  pendingRefundCount: number;
  paidRevenue: number;
  toShipCount: number; // 待发货
  todayNewUsers: number; // 今日新增用户
  todayNewOrders: number; // 今日新增订单
  last7DaysRevenue: number[]; // 近 7 天每日销售额（分），下标 0 = 最早
  orderStatusDist: { status: string; count: number }[];
  categoryDist: { category: string; count: number }[];
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

interface AdminOrder {
  id: string;
  userId: string;
  buyerNickname: string | null;
  recipient: { name: string; phone: string; city: string } | null;
  total: number;
  status: string;
  createdAt: string;
  paidAt: string | null;
  firstItemName: string;
  itemCount: number;
  isDestroyed: boolean;
}

interface AdminUser {
  id: string;
  role: string;
  status: string; // ACTIVE | DISABLED
  nickname: string | null;
  ageVerified: boolean;
  lockUntil: string | null;
  createdAt: string;
  orderCount: number;
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

/** 看板导航预设：跳转到目标 Tab 时携带的预置筛选（与各 Tab 的计数口径对齐） */
type DashboardNav = {
  tab: TabKey;
  preset?: { orderStatus?: string; brandStatus?: string };
};

function DashboardTab({
  onNavigate,
  active,
}: {
  onNavigate: (nav: DashboardNav) => void;
  active?: boolean;
}) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const loadedOnce = useRef(false);

  useEffect(() => {
    apiFetch("/api/admin/dashboard")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  // 首载完成后标记已加载；切回本 Tab 时静默刷新（不再重建骨架）
  useEffect(() => {
    if (stats) loadedOnce.current = true;
  }, [stats]);
  useEffect(() => {
    if (active && loadedOnce.current) {
      apiFetch("/api/admin/dashboard")
        .then((r) => r.json())
        .then(setStats)
        .catch(() => {});
    }
  }, [active]);

  if (!stats) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-gray-100" />
        ))}
      </div>
    );
  }

  // 统计卡：label/value + 点击跳转目标（tab + 预置筛选）
  const cards: {
    label: string;
    value: string;
    highlight?: boolean;
    nav: DashboardNav;
  }[] = [
    { label: "用户数", value: String(stats.userCount), nav: { tab: "users" } },
    { label: "品牌数", value: String(stats.brandCount), nav: { tab: "brands", preset: { brandStatus: "" } } },
    { label: "待审品牌", value: String(stats.pendingBrandCount), highlight: true, nav: { tab: "brands", preset: { brandStatus: "PENDING" } } },
    // 商品质检已移入 /inspect 质检中心（职责隔离）：管理员不再看到商品统计跳转卡片
    { label: "订单数", value: String(stats.orderCount), nav: { tab: "orders", preset: { orderStatus: "" } } },
    { label: "待退款", value: String(stats.pendingRefundCount), highlight: true, nav: { tab: "orders", preset: { orderStatus: "REFUND_REQUESTED" } } },
    { label: "待发货", value: String(stats.toShipCount), highlight: true, nav: { tab: "orders", preset: { orderStatus: "TO_SHIP" } } },
    { label: "今日新增订单", value: String(stats.todayNewOrders), nav: { tab: "orders" } },
    { label: "今日新增用户", value: String(stats.todayNewUsers), nav: { tab: "users" } },
    { label: "已支付销售额", value: `¥${fenToYuan(stats.paidRevenue)}`, nav: { tab: "orders" } },
  ];

  // 近 7 天销售柱状图：按最大值归一化高度
  const maxRevenue = Math.max(...stats.last7DaysRevenue, 1);
  const dayLabels = ["6天前", "5天前", "4天前", "3天前", "2天前", "昨天", "今天"];

  // 订单状态分布条：STATUS_LABEL 缺省回退原始值
  const statusTotal = Math.max(
    stats.orderStatusDist.reduce((s, d) => s + d.count, 0),
    1,
  );

  return (
    <div className="space-y-4">
      {/* 统计卡网格 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map((c) => (
          <button
            key={c.label}
            onClick={() => onNavigate(c.nav)}
            className={`rounded-2xl p-5 text-left transition hover:shadow-md active:scale-[0.98] ${c.highlight ? "bg-primary/5" : "bg-gray-50"}`}
          >
            <p className={`text-3xl font-bold tracking-tight ${c.highlight ? "text-primary" : "text-gray-900"}`}>
              {c.value}
            </p>
            <p className="mt-1.5 flex items-center gap-1 text-sm text-gray-500">
              {c.label}
              <span className="text-xs text-gray-300">→</span>
            </p>
          </button>
        ))}
      </div>

      {/* 近 7 天销售（纯 CSS 柱状条） */}
      <div className="rounded-2xl border border-gray-100 p-5">
        <div className="flex items-center justify-between">
          <p className="text-base font-semibold text-gray-900">近 7 天销售</p>
          <p className="text-sm text-gray-400">共 ¥{fenToYuan(stats.last7DaysRevenue.reduce((s, v) => s + v, 0))}</p>
        </div>
        <div className="mt-4 flex h-32 items-end gap-2">
          {stats.last7DaysRevenue.map((v, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1">
              <div className="flex h-28 w-full items-end rounded-t-md bg-primary/5">
                <div
                  className="w-full rounded-t-md bg-linear-to-t from-primary to-accent"
                  style={{ height: `${Math.max((v / maxRevenue) * 100, v > 0 ? 4 : 1)}%` }}
                />
              </div>
              <p className="text-xs text-gray-400">{dayLabels[i]}</p>
              <p className="text-xs font-medium text-gray-600">¥{fenToYuan(v)}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 订单状态分布 */}
        <div className="rounded-2xl border border-gray-100 p-5">
          <p className="text-base font-semibold text-gray-900">订单状态分布</p>
          {stats.orderStatusDist.length === 0 ? (
            <p className="mt-4 text-sm text-gray-400">暂无订单数据</p>
          ) : (
            <div className="mt-4 space-y-2.5">
              {stats.orderStatusDist.map((d) => (
                <div key={d.status}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">{STATUS_LABEL[d.status] || d.status}</span>
                    <span className="text-gray-400">{d.count} 笔</span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-gray-100">
                    <div
                      className="h-2 rounded-full bg-linear-to-r from-primary to-accent"
                      style={{ width: `${(d.count / statusTotal) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 品类商品数分布 */}
        <div className="rounded-2xl border border-gray-100 p-5">
          <p className="text-base font-semibold text-gray-900">品类商品数分布</p>
          {stats.categoryDist.length === 0 ? (
            <p className="mt-4 text-sm text-gray-400">暂无商品数据</p>
          ) : (
            <div className="mt-4 space-y-2.5">
              {stats.categoryDist.map((d) => (
                <div key={d.category}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">{d.category}</span>
                    <span className="text-gray-400">{d.count} 个</span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-gray-100">
                    <div
                      className="h-2 rounded-full bg-linear-to-r from-primary to-accent"
                      style={{ width: `${(d.count / Math.max(stats.categoryDist[0]?.count, 1)) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BrandReviewTab({
  statusFilter,
  onStatusFilterChange,
  active,
}: {
  statusFilter: string;
  onStatusFilterChange: (s: string) => void;
  active?: boolean;
}) {
  const [brands, setBrands] = useState<AdminBrand[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");

  // 客户端过滤：首载一次拉全量，之后切状态药丸即时过滤，零网络往返、零延迟
  const loadedOnce = useRef(false);

  const fetchBrands = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    try {
      // 筛选由客户端完成：一次拉全量（含 PENDING/REJECTED 在内存过滤）
      const data = await apiCall("GET", "/api/admin/brands?pageSize=100");
      setBrands(data.items || []);
    } catch { /* 静默 */ } finally {
      loadedOnce.current = true;
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchBrands(); }, [fetchBrands]);
  // 切回本 Tab 时静默刷新（已加载过不重建骨架）
  useEffect(() => {
    if (active && loadedOnce.current) void fetchBrands();
  }, [active, fetchBrands]);

  // 客户端过滤：状态精确匹配
  const filteredBrands = useMemo(
    () => (statusFilter ? brands.filter((b) => b.status === statusFilter) : brands),
    [brands, statusFilter],
  );

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

  const handleDelete = async (id: string) => {
    if (!window.confirm("删除后该品牌方可用新邀请码重新入驻，确认删除？")) return;
    setActing(id);
    setError("");
    try {
      await apiCall("DELETE", `/api/admin/brands/${id}`);
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
      <div className="flex gap-2 overflow-x-auto pb-1">
        {["", "PENDING", "REJECTED"].map((s) => (
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
      {/* 列表固定高度 + 内部滚动：切状态药丸时页面永不重排 */}
      <div className="h-[calc(100vh-13rem)] overflow-y-auto rounded-xl">
      {filteredBrands.length === 0 ? (
        <div className="flex min-h-[40vh] items-center justify-center text-center text-gray-400">
          {statusFilter ? "该状态下暂无品牌" : "暂无品牌"}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredBrands.map((b) => (
          <div key={b.id} className="flex items-center justify-between rounded-2xl border border-gray-100 p-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-base font-semibold text-gray-900">{b.name}</p>
                <StatusBadge status={b.status} />
              </div>
              <p className="mt-0.5 text-sm text-gray-400">
                入驻码 {b.inviteCode} · 商品 {b.productCount} 个
                {b.ownerNickname ? ` · 负责人 ${b.ownerNickname}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              {b.status === "REJECTED" ? (
                <>
                  <button
                    onClick={() => handleReview(b.id, "APPROVED")}
                    disabled={acting === b.id}
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                  >
                    重审通过
                  </button>
                  <button
                    onClick={() => handleDelete(b.id)}
                    disabled={acting === b.id}
                    className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                  >
                    删除品牌
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => handleReview(b.id, "APPROVED")}
                    disabled={acting === b.id}
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                  >
                    通过
                  </button>
                  <button
                    onClick={() => handleReview(b.id, "REJECTED")}
                    disabled={acting === b.id}
                    className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
                  >
                    拒绝
                  </button>
                </>
              )}
            </div>
          </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

function OrdersTab({
  statusFilter,
  onStatusFilterChange,
  active,
}: {
  statusFilter: string;
  onStatusFilterChange: (s: string) => void;
  active?: boolean;
}) {
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");

  // 客户端过滤：首载一次拉全量，之后切状态药丸即时过滤，零网络往返、零延迟
  const loadedOnce = useRef(false);

  const fetchOrders = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    try {
      // 筛选由客户端完成：一次拉全量（含 TO_SHIP=PAID+SHIPPED 合并口径在客户端重算）
      const data = await apiCall("GET", "/api/admin/orders?pageSize=100");
      setOrders(data.orders || []);
    } catch { /* 静默 */ } finally {
      loadedOnce.current = true;
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);
  // 切回本 Tab 时静默刷新（已加载过不重建骨架）
  useEffect(() => {
    if (active && loadedOnce.current) void fetchOrders();
  }, [active, fetchOrders]);

  // 客户端过滤：TO_SHIP = PAID + SHIPPED（与服务端 getAdminOrders 同口径），其余精确匹配
  const filteredOrders = useMemo(() => {
    if (!statusFilter) return orders;
    if (statusFilter === "TO_SHIP") return orders.filter((o) => o.status === "PAID" || o.status === "SHIPPED");
    return orders.filter((o) => o.status === statusFilter);
  }, [orders, statusFilter]);

  // 动作成功 → 本地更新订单状态（发货/送达/完成/退款），列表即时重算，无需重拉全量
  const applyStatus = (orderId: string, next: string) => {
    setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, status: next } : o)));
  };

  const handleAction = async (orderId: string, action: string) => {
    setActing(orderId);
    setError("");
    const next = ACTION_STATUS[action];
    try {
      await apiCall("POST", `/api/admin/orders/${orderId}/${action}`);
      if (next) applyStatus(orderId, next);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {["", "TO_SHIP", "PENDING", "PAID", "SHIPPED", "DELIVERED", "REFUND_REQUESTED", "REFUNDED", "COMPLETED", "CANCELLED"].map((s) => (
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
      {/* 列表固定高度 + 内部滚动：切状态药丸时页面永不重排 */}
      <div className="h-[calc(100vh-13rem)] overflow-y-auto rounded-xl">
      {loading ? (
        <div className="h-32 animate-pulse rounded-xl bg-gray-100" />
      ) : filteredOrders.length === 0 ? (
        <div className="flex min-h-[40vh] items-center justify-center text-center text-gray-400">
          {statusFilter ? "该状态下暂无订单" : "暂无订单"}
        </div>
      ) : (
        <div className="space-y-3">
          {filteredOrders.map((o) => (
          <div key={o.id} className="rounded-2xl border border-gray-100 p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-semibold text-gray-900">
                  {o.firstItemName}
                  {o.itemCount > 1 && (
                    <span className="ml-1.5 text-sm font-normal text-gray-400">
                      等 {o.itemCount} 件
                    </span>
                  )}
                </p>
                <p className="mt-1 text-sm text-gray-400">
                  <StatusBadge status={o.status} /> · ¥{fenToYuan(o.total)}
                  {o.isDestroyed && <span className="ml-1 text-red-400">已销毁</span>}
                </p>
              </div>
              <div className="shrink-0 text-right text-sm text-gray-400">
                <p>{new Date(o.createdAt).toLocaleString("zh-CN", { hour12: false })}</p>
                <p className="mt-0.5 truncate font-mono text-xs">{o.id}</p>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-gray-50 pt-2 text-sm text-gray-500">
              <span>买家：{o.buyerNickname || "—"}</span>
              {o.recipient && (
                <>
                  <span>收货人：{o.recipient.name}</span>
                  <span>{o.recipient.phone}</span>
                  {o.recipient.city && <span>{o.recipient.city}</span>}
                </>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {o.status === "PAID" && (
                <button
                  onClick={() => handleAction(o.id, "ship")}
                  disabled={acting === o.id}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  发货
                </button>
              )}
              {o.status === "SHIPPED" && (
                <button
                  onClick={() => handleAction(o.id, "deliver")}
                  disabled={acting === o.id}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  标记送达
                </button>
              )}
              {o.status === "DELIVERED" && (
                <button
                  onClick={() => handleAction(o.id, "complete")}
                  disabled={acting === o.id}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  完成
                </button>
              )}
              {o.status === "REFUND_REQUESTED" && (
                <button
                  onClick={() => handleAction(o.id, "refund-confirm")}
                  disabled={acting === o.id}
                  className="rounded-lg border border-orange-200 px-4 py-2 text-sm font-medium text-orange-600 transition hover:bg-orange-50 disabled:opacity-50"
                >
                  确认退款
                </button>
              )}
            </div>
          </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

/** 用户操作确认弹窗（禁用/启用/清除年龄验证等一次性操作） */

/** 重置密码弹窗：输入临时密码 → 提交 → 展示一次临时密码（管理员转达用户） */
function ResetPasswordModal({
  user,
  onClose,
  onReset,
}: {
  user: AdminUser;
  onClose: () => void;
  onReset: (tempPassword: string) => Promise<{ success: boolean; tempPassword?: string; message?: string }>;
}) {
  const [tempPassword, setTempPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const submit = async () => {
    setError("");
    if (tempPassword.length < 6 || tempPassword.length > 20) {
      setError("临时密码需 6-20 位");
      return;
    }
    setLoading(true);
    const r = await onReset(tempPassword);
    setLoading(false);
    if (r.success) {
      setResult(r.tempPassword || tempPassword);
    } else {
      setError(r.message || "重置失败");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-bold">重置密码</h3>
        <p className="mt-1 text-sm text-gray-400">
          用户 {user.nickname || user.id.slice(-6)}
        </p>

        {result ? (
          <div className="mt-3 rounded-lg bg-green-50 p-3 text-sm text-green-700">
            <p>重置成功，请将以下临时密码转达用户：</p>
            <p className="mt-1 font-mono text-lg font-bold">{result}</p>
            <p className="mt-1 text-xs text-green-600">请提醒用户尽快登录并修改密码</p>
          </div>
        ) : (
          <>
            <input
              value={tempPassword}
              onChange={(e) => setTempPassword(e.target.value)}
              placeholder="输入 6-20 位临时密码"
              className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-primary"
            />
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
                {loading ? "提交中..." : "确认重置"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function UsersTab({ active }: { active?: boolean }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [actingId, setActingId] = useState<string | null>(null);
  // 当前管理员 id：自己所在行隐藏操作（后端 403 兜底，前端不给入口）
  const [meId, setMeId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    user: AdminUser;
    action: "disable" | "enable" | "clearAge";
  } | null>(null);
  const [resetFor, setResetFor] = useState<AdminUser | null>(null);

  // 仅首载显示骨架，切回本 Tab 时保留旧列表静默刷新
  const loadedOnce = useRef(false);

  const fetchUsers = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    setRefreshing(true);
    try {
      const res = await apiFetch("/api/admin/users?pageSize=50");
      const data = await res.json();
      setUsers(data.items || []);
    } catch { /* 静默 */ } finally {
      loadedOnce.current = true;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers()
      .then(() => apiFetch("/api/auth/me").then((r) => r.json()).then((m) => setMeId(m?.user?.id ?? null)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [fetchUsers]);
  // 切回本 Tab 时静默刷新
  useEffect(() => {
    if (active && loadedOnce.current) void fetchUsers();
  }, [active, fetchUsers]);

  /** 通用 PATCH 操作：成功后刷新列表 + 提示 */
  const runAction = async (
    user: AdminUser,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> => {
    setActingId(user.id);
    setError("");
    try {
      const res = await apiFetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "操作失败");
      await fetchUsers();
      setNotice("操作成功");
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
      return null;
    } finally {
      setActingId(null);
    }
  };

  const handleRoleChange = async (user: AdminUser, role: string) => {
    if (role === user.role) return;
    await runAction(user, { action: "setRole", role });
  };

  const handleConfirm = async () => {
    if (!confirm) return;
    if (confirm.action === "disable") {
      await runAction(confirm.user, { action: "setStatus", status: "DISABLED" });
    } else if (confirm.action === "enable") {
      await runAction(confirm.user, { action: "setStatus", status: "ACTIVE" });
    } else {
      await runAction(confirm.user, { action: "clearAgeVerification" });
    }
    setConfirm(null);
  };

  const handleUnlock = async (user: AdminUser) => {
    await runAction(user, { action: "unlock" });
  };

  const handleReset = async (tempPassword: string) => {
    const data = await runAction(resetFor!, { action: "resetPassword", tempPassword });
    if (!data) return { success: false, message: "重置失败" };
    return { success: true, tempPassword: data.tempPassword as string };
  };

  if (loading) {
    return <div className="h-32 animate-pulse rounded-xl bg-gray-100" />;
  }

  const isLocked = (u: AdminUser) =>
    !!u.lockUntil && new Date(u.lockUntil).getTime() > Date.now();

  return (
    <div className="space-y-3">
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
      {notice && (
        <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</div>
      )}

      <div className={`overflow-x-auto rounded-xl border border-gray-100 transition-opacity duration-200 ${refreshing ? "opacity-60" : ""}`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left text-sm text-gray-500">
              <th className="px-4 py-3 font-medium">ID</th>
              <th className="px-4 py-3 font-medium">角色</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 font-medium">昵称</th>
              <th className="px-4 py-3 font-medium">年龄验证</th>
              <th className="px-4 py-3 font-medium">订单数</th>
              <th className="px-4 py-3 font-medium">注册时间</th>
              <th className="px-4 py-3 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = u.id === meId;
              return (
                <tr key={u.id} className="border-b border-gray-50 last:border-0">
                  <td className="max-w-[110px] truncate px-3 py-2 text-xs text-gray-400">{u.id}</td>
                  <td className="px-4 py-3">
                    {isSelf || u.role === "SUPER" ? (
                      // SUPER 最高权限者只读（不可被其他账号改角色）；自己不可改
                      <span className="text-sm">
                        {u.role === "SUPER" ? "SUPER（最高权限者）" : u.role}
                      </span>
                    ) : (
                      <select
                        value={u.role}
                        disabled={actingId === u.id}
                        onChange={(e) => handleRoleChange(u, e.target.value)}
                        className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm outline-none focus:border-primary disabled:opacity-50"
                      >
                        {["USER", "BRAND", "CUSTOMER_SERVICE", "QUALITY_INSPECTOR", "ADMIN"].map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                        u.status === "DISABLED"
                          ? "bg-red-50 text-red-600"
                          : "bg-green-50 text-green-600"
                      }`}
                    >
                      {u.status === "DISABLED" ? "已禁用" : "正常"}
                    </span>
                    {isLocked(u) && (
                      <span className="ml-1.5 rounded-full bg-orange-50 px-2.5 py-1 text-xs font-medium text-orange-600">
                        已锁定
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">{u.nickname || "—"}</td>
                  <td className="px-4 py-3 text-sm">{u.ageVerified ? "✓" : "—"}</td>
                  <td className="px-4 py-3 text-sm">{u.orderCount}</td>
                  <td className="px-4 py-3 text-sm text-gray-400">
                    {new Date(u.createdAt).toLocaleDateString("zh-CN")}
                  </td>
                  <td className="px-4 py-3">
                    {!isSelf && (
                      <div className="flex flex-wrap gap-1.5">
                        {u.status === "ACTIVE" ? (
                          <button
                            onClick={() => setConfirm({ user: u, action: "disable" })}
                            disabled={actingId === u.id}
                            className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                          >
                            禁用
                          </button>
                        ) : (
                          <button
                            onClick={() => setConfirm({ user: u, action: "enable" })}
                            disabled={actingId === u.id}
                            className="rounded-lg border border-green-200 px-2.5 py-1 text-xs font-medium text-green-600 transition hover:bg-green-50 disabled:opacity-50"
                          >
                            启用
                          </button>
                        )}
                        {isLocked(u) && (
                          <button
                            onClick={() => handleUnlock(u)}
                            disabled={actingId === u.id}
                            className="rounded-lg border border-orange-200 px-2.5 py-1 text-xs font-medium text-orange-600 transition hover:bg-orange-50 disabled:opacity-50"
                          >
                            解锁
                          </button>
                        )}
                        <button
                          onClick={() => setResetFor(u)}
                          disabled={actingId === u.id}
                          className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
                        >
                          重置密码
                        </button>
                        {u.ageVerified && (
                          <button
                            onClick={() => setConfirm({ user: u, action: "clearAge" })}
                            disabled={actingId === u.id}
                            className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
                          >
                            清除年龄验证
                          </button>
                        )}
                      </div>
                    )}
                    {isSelf && <span className="text-xs text-gray-300">当前账号</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {confirm && (
        <ConfirmModal
          title={
            confirm.action === "clearAge" ? "清除年龄验证" : confirm.action === "disable" ? "禁用账号" : "启用账号"
          }
          message={
            confirm.action === "clearAge"
              ? `将清除 ${confirm.user.nickname || "该用户"} 的年龄验证状态，该用户下次需重新完成年龄确认。`
              : confirm.action === "disable"
                ? `禁用后 ${confirm.user.nickname || "该用户"} 将无法登录（商品/订单数据保留）。确认禁用？`
                : `确认重新启用 ${confirm.user.nickname || "该用户"} 的登录权限？`
          }
          confirmLabel={confirm.action === "clearAge" ? "清除" : confirm.action === "disable" ? "禁用" : "启用"}
          loading={actingId === confirm.user.id}
          onCancel={() => setConfirm(null)}
          onConfirm={handleConfirm}
        />
      )}

      {resetFor && (
        <ResetPasswordModal
          user={resetFor}
          onClose={() => setResetFor(null)}
          onReset={handleReset}
        />
      )}
    </div>
  );
}

function InviteCodesTab({ active }: { active?: boolean }) {
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
  // 切回本 Tab 时静默刷新（保留旧列表，无骨架）
  useEffect(() => {
    if (active) void fetchCodes();
  }, [active, fetchCodes]);

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

  // L6：作废邀请码（仅待使用/已过期可作废；作废后不可再激活）
  const handleRevoke = async (code: string) => {
    if (!window.confirm(`确认作废邀请码 ${code}？作废后该码不可再激活。`)) return;
    setError("");
    try {
      await apiCall("POST", `/api/admin/invite-codes/${encodeURIComponent(code)}/revoke`);
      await fetchCodes();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "作废失败");
    }
  };

  const fmtTime = (v: string | null) =>
    v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "—";

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-gray-100 p-5">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-base font-semibold text-gray-900">生成入驻邀请码</p>
            <p className="mt-0.5 text-sm text-gray-400">格式 INV-XXXX-XXXX，发放给意向品牌方</p>
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
              className="rounded-lg bg-primary px-4 py-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
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
              <tr className="border-b bg-gray-50 text-left text-sm text-gray-500">
                <th className="px-4 py-3 font-medium">邀请码</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">使用人</th>
                <th className="px-4 py-3 font-medium">过期时间</th>
                <th className="px-4 py-3 font-medium">使用时间</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.id} className="border-b border-gray-50 last:border-0">
                  <td className="px-4 py-3 font-mono text-sm text-gray-900">{c.code}</td>
                  <td className="px-4 py-3 text-sm">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="max-w-[120px] truncate px-3 py-2 text-sm text-gray-400">
                    {c.usedBy ? (
                      <>
                        {c.usedBy.slice(0, 12)}…
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-400">{fmtTime(c.expiresAt)}</td>
                  <td className="px-3 py-2 text-sm text-gray-400">{fmtTime(c.usedAt)}</td>
                  <td className="px-3 py-2 text-sm">
                    {c.status === "UNUSED" || c.status === "EXPIRED" ? (
                      <button
                        onClick={() => handleRevoke(c.code)}
                        className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-600 transition hover:bg-red-50"
                      >
                        作废
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
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

type TabKey = "dashboard" | "brands" | "orders" | "users" | "invites";

const TABS: { key: TabKey; label: string }[] = [
  { key: "dashboard", label: "数据看板" },
  { key: "brands", label: "品牌审核" },
  { key: "orders", label: "订单管理" },
  { key: "users", label: "用户管理" },
  { key: "invites", label: "邀请码" },
];

export function AdminDashboardPage() {
  const [tab, setTab] = useState<TabKey>("dashboard");
  // 筛选状态上提：看板卡片跳转时携带预置筛选（订单状态/品牌状态）
  const [orderStatusFilter, setOrderStatusFilter] = useState("");
  const [brandStatusFilter, setBrandStatusFilter] = useState("PENDING");

  /** 看板卡片跳转：切 Tab + 预置筛选（与各 Tab 计数口径一致，见 DashboardTab cards 注释） */
  const handleNavigate = (nav: DashboardNav) => {
    if (nav.preset?.orderStatus !== undefined) setOrderStatusFilter(nav.preset.orderStatus);
    if (nav.preset?.brandStatus !== undefined) setBrandStatusFilter(nav.preset.brandStatus);
    setTab(nav.tab);
  };

  return (
    <main className="mx-auto min-h-screen max-w-6xl bg-white pb-24">
      <SiteHeader />
      <div className="mx-auto w-full max-w-5xl px-4 pt-4">
        <h1 className="text-center text-xl font-bold text-gray-900">管理后台</h1>
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

      <div className="mx-auto w-full max-w-5xl p-4 pt-3">
        {/* 常驻挂载 + hidden 切换：切 Tab 不卸载/重挂组件 → 不重建骨架、不高度塌缩 */}
        <div className={tab === "dashboard" ? "" : "hidden"}>
          <DashboardTab onNavigate={handleNavigate} active={tab === "dashboard"} />
        </div>
        <div className={tab === "brands" ? "" : "hidden"}>
          <BrandReviewTab
            statusFilter={brandStatusFilter}
            onStatusFilterChange={setBrandStatusFilter}
            active={tab === "brands"}
          />
        </div>
        <div className={tab === "orders" ? "" : "hidden"}>
          <OrdersTab
            statusFilter={orderStatusFilter}
            onStatusFilterChange={setOrderStatusFilter}
            active={tab === "orders"}
          />
        </div>
        <div className={tab === "users" ? "" : "hidden"}>
          <UsersTab active={tab === "users"} />
        </div>
        <div className={tab === "invites" ? "" : "hidden"}>
          <InviteCodesTab active={tab === "invites"} />
        </div>
      </div>
    </main>
  );
}
