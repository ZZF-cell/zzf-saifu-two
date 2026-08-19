"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { apiFetch } from "@/shared/api/client";
import { WorkbenchHeader } from "@/shared/ui/WorkbenchHeader";
import { StatusBadge, STATUS_LABEL } from "@/shared/ui/StatusBadge";
import { Image } from "@/shared/ui/Image";

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

/** 商家状态筛选：默认「全部」——最高权限者进此页就是要看到所有入驻品牌 */
const BRAND_STATUS_FILTERS = ["", "PENDING", "APPROVED", "REJECTED"];

// ── 商家管理页（/brands，仅 ADMIN | SUPER，中间件守卫） ──
// 最高权限者/管理员的「商家管理」入口：查看所有入驻品牌（全部状态 + LOGO + 入驻时间），
// 并可执行审核（通过/拒绝/重审通过）与删除。数据复用 /api/admin/brands（ADMIN_ROLES 守卫）。
export function BrandManagementPage() {
  const [brands, setBrands] = useState<AdminBrand[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");

  // 客户端过滤：首载一次拉全量，之后切状态药丸即时过滤，零网络往返、零延迟、零塌缩
  const fetchBrands = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiCall("GET", "/api/admin/brands?pageSize=100");
      setBrands(data.items || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "品牌列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchBrands(); }, [fetchBrands]);

  // 客户端过滤：状态精确匹配（与服务端 getAdminBrands 同口径），""=全部
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

  return (
    <main className="mx-auto min-h-screen max-w-6xl bg-white pb-24">
      {/* 独立工作台头部：不带主站购物车等导航，工作台内只有主页面/个人中心/退出 */}
      <WorkbenchHeader title="商家管理" />
      <div className="mx-auto w-full max-w-5xl px-4 pt-4">
        <h1 className="text-center text-xl font-bold text-gray-900">商家管理</h1>
      </div>

      <div className="mx-auto w-full max-w-5xl p-4">
        <div className="space-y-3">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {BRAND_STATUS_FILTERS.map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
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
          {loading ? (
            <div className="h-32 animate-pulse rounded-xl bg-gray-100" />
          ) : (
            /* 列表固定高度 + 内部滚动：切状态药丸时页面永不重排 */
            <div className="h-[calc(100vh-13rem)] overflow-y-auto rounded-xl">
            {filteredBrands.length === 0 ? (
              <div className="flex min-h-[40vh] items-center justify-center text-center text-gray-400">
                {statusFilter ? "该状态下暂无品牌" : "暂无品牌"}
              </div>
            ) : (
              <div className="space-y-3">
              {filteredBrands.map((b) => (
                <div key={b.id} className="flex items-center justify-between rounded-2xl border border-gray-100 p-5">
                  <div className="flex min-w-0 items-center gap-3">
                    {b.logo ? (
                      <Image
                        src={b.logo}
                        alt={b.name}
                        width={48}
                        height={48}
                        className="h-12 w-12 shrink-0 rounded-xl border border-gray-100 object-cover"
                      />
                    ) : (
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-lg font-bold text-gray-400">
                        {b.name.slice(0, 1)}
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-base font-semibold text-gray-900">{b.name}</p>
                        <StatusBadge status={b.status} />
                      </div>
                      <p className="mt-0.5 truncate text-sm text-gray-400">
                        入驻码 {b.inviteCode} · 商品 {b.productCount} 个
                        {b.ownerNickname ? ` · 负责人 ${b.ownerNickname}` : ""}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-300">
                        入驻于 {new Date(b.createdAt).toLocaleDateString("zh-CN")}
                      </p>
                    </div>
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
          )}
        </div>
      </div>
    </main>
  );
}
