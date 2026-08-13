"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import type { UserProfile } from "./user.queries";
import { apiFetch } from "@/shared/api/client";
import { SiteHeader } from "@/shared/ui/SiteHeader";

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

// ── 个人中心页（/account） ──

const ROLE_LABEL: Record<string, string> = {
  USER: "普通用户",
  ADMIN: "管理员",
};

export function AccountPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 昵称编辑
  const [editing, setEditing] = useState(false);
  const [nickname, setNickname] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const fetchProfile = useCallback(async () => {
    try {
      const data = await apiCall("GET", "/api/user/profile");
      setProfile(data);
      setNickname(data.nickname ?? "");
    } catch {
      // 401 时 apiFetch 已跳转登录页，这里只兜底提示
      setError("个人信息加载失败，请刷新重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProfile(); }, [fetchProfile]);

  const handleSaveNickname = async () => {
    const trimmed = nickname.trim();
    if (!trimmed) {
      setSaveError("昵称不能为空");
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      const result = await apiCall("PATCH", "/api/user/profile", { nickname: trimmed });
      setProfile((prev) => (prev ? { ...prev, nickname: result.nickname } : prev));
      setNickname(result.nickname);
      setEditing(false);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <main className="mx-auto min-h-screen max-w-lg p-4">
        <div className="mt-8 space-y-3">
          <div className="h-24 animate-pulse rounded-xl bg-gray-100" />
          <div className="h-24 animate-pulse rounded-xl bg-gray-100" />
          <div className="h-32 animate-pulse rounded-xl bg-gray-100" />
        </div>
      </main>
    );
  }

  if (!profile) {
    return (
      <main className="mx-auto min-h-screen max-w-lg p-4">
        <div className="py-20 text-center text-gray-400">{error || "个人信息加载失败"}</div>
      </main>
    );
  }

  const stats: { label: string; value: number; highlight?: boolean }[] = [
    { label: "全部订单", value: profile.stats.totalOrders },
    { label: "待付款", value: profile.stats.pendingPayment },
    { label: "已支付", value: profile.stats.paidOrders, highlight: true },
    { label: "已取消/退款", value: profile.stats.cancelledOrders },
  ];

  return (
    <main className="mx-auto min-h-screen max-w-lg bg-white pb-24">
      <SiteHeader />
      <div className="px-4 pt-4">
        <h1 className="text-center text-base font-bold">个人中心</h1>
      </div>

      <div className="p-4 space-y-6">
        {/* 账户信息 */}
        <section>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">账户信息</h3>
          <div className="space-y-3 rounded-xl bg-gray-50 p-4">
            {editing ? (
              <div className="space-y-2">
                <input
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  maxLength={30}
                  placeholder="请输入昵称"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                />
                {saveError && (
                  <p className="text-xs text-red-600">{saveError}</p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={handleSaveNickname}
                    disabled={saving}
                    className="flex-1 rounded-lg bg-primary py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                  >
                    {saving ? "保存中..." : "保存"}
                  </button>
                  <button
                    onClick={() => { setEditing(false); setNickname(profile.nickname ?? ""); setSaveError(""); }}
                    className="flex-1 rounded-lg border border-gray-200 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <p className="truncate text-base font-medium text-gray-900">
                    {profile.nickname || "未设置昵称"}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-400">
                    {ROLE_LABEL[profile.role] || profile.role}
                    {profile.ageVerified && " · 已通过年龄验证"}
                  </p>
                </div>
                <button
                  onClick={() => setEditing(true)}
                  className="shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50"
                >
                  修改昵称
                </button>
              </div>
            )}
          </div>
        </section>

        {/* 订单统计 */}
        <section>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">订单统计</h3>
          <div className="grid grid-cols-4 gap-2">
            {stats.map((s) => (
              <div
                key={s.label}
                className={`rounded-xl p-3 text-center ${
                  s.highlight ? "bg-primary/5" : "bg-gray-50"
                }`}
              >
                <p className={`text-xl font-bold ${s.highlight ? "text-primary" : "text-gray-900"}`}>
                  {s.value}
                </p>
                <p className="mt-0.5 text-[11px] text-gray-500">{s.label}</p>
              </div>
            ))}
          </div>
        </section>

        {/* 快捷入口 */}
        <section>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">常用功能</h3>
          <div className="divide-y divide-gray-100 rounded-xl border border-gray-100">
            <Link href="/orders" className="flex items-center justify-between px-4 py-3 text-sm text-gray-700 transition hover:bg-gray-50">
              我的订单
              <span className="text-gray-300">›</span>
            </Link>
            <Link href="/cart" className="flex items-center justify-between px-4 py-3 text-sm text-gray-700 transition hover:bg-gray-50">
              我的购物车
              <span className="text-gray-300">›</span>
            </Link>
            <Link href="/" className="flex items-center justify-between px-4 py-3 text-sm text-gray-700 transition hover:bg-gray-50">
              返回商城首页
              <span className="text-gray-300">›</span>
            </Link>
          </div>
        </section>

        {/* 注册时间 */}
        <p className="text-center text-xs text-gray-400">
          注册于 {new Date(profile.createdAt).toLocaleDateString("zh-CN")}
        </p>
      </div>
    </main>
  );
}
