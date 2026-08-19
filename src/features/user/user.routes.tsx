"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import type { UserProfile } from "./user.types";
import { apiFetch } from "@/shared/api/client";
import { SiteHeader } from "@/shared/ui/SiteHeader";
import { Image } from "@/shared/ui/Image";
import { firstFieldError } from "@/shared/utils/api-errors";
import { MAX_UPLOAD_BYTES, ALLOWED_IMAGE_TYPES } from "@/shared/constants/upload";

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
  BRAND: "商家",
  CUSTOMER_SERVICE: "客服",
  QUALITY_INSPECTOR: "质检员",
  ADMIN: "管理员",
  SUPER: "最高权限者",
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

  // 头像
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState("");

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

  const handleAvatarUpload = async (file: File) => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      setAvatarError("仅支持 JPG/PNG/WebP 图片");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setAvatarError("图片不能超过 4MB");
      return;
    }
    setAvatarUploading(true);
    setAvatarError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("purpose", "avatar");
      const res = await apiFetch("/api/upload", { method: "POST", body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // 后端 422 带 details（字段 → 具体原因），优先展示具体原因
        throw new Error(firstFieldError(data?.details) || data?.message || "上传失败");
      }
      // 上传成功后回写头像 URL（服务端 isOssUrlOwnedBy 校验归属）
      const profile = await apiCall("PATCH", "/api/user/profile", { avatarUrl: data.url });
      setProfile((prev) => (prev ? { ...prev, avatarUrl: profile.avatarUrl } : prev));
    } catch (err: unknown) {
      setAvatarError(err instanceof Error ? err.message : "上传失败");
    } finally {
      setAvatarUploading(false);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  };

  const handleRemoveAvatar = async () => {
    setAvatarError("");
    try {
      const profile = await apiCall("PATCH", "/api/user/profile", { avatarUrl: "" });
      setProfile((prev) => (prev ? { ...prev, avatarUrl: profile.avatarUrl } : prev));
    } catch (err: unknown) {
      setAvatarError(err instanceof Error ? err.message : "操作失败");
    }
  };

  if (loading) {
    return (
      <main className="mx-auto min-h-screen max-w-6xl p-4">
        <div className="mx-auto mt-8 w-full max-w-2xl space-y-3">
          <div className="h-24 animate-pulse rounded-xl bg-gray-100" />
          <div className="h-24 animate-pulse rounded-xl bg-gray-100" />
          <div className="h-32 animate-pulse rounded-xl bg-gray-100" />
        </div>
      </main>
    );
  }

  if (!profile) {
    return (
      <main className="mx-auto min-h-screen max-w-6xl p-4">
        <div className="mx-auto w-full max-w-2xl py-20 text-center text-gray-400">
          {error || "个人信息加载失败"}
        </div>
      </main>
    );
  }

  // 点击卡片直达对应状态的订单列表（Tab key 与 ORDER_STATUS_GROUPS 同口径）
  const stats: { label: string; value: number; highlight?: boolean; href: string }[] = [
    { label: "全部订单", value: profile.stats.totalOrders, href: "/orders" },
    { label: "待付款", value: profile.stats.pendingPayment, href: "/orders?status=pending" },
    { label: "已支付", value: profile.stats.paidOrders, highlight: true, href: "/orders?status=paid" },
    { label: "已取消/退款", value: profile.stats.cancelledOrders, href: "/orders?status=cancelled" },
  ];

  return (
    <main className="mx-auto min-h-screen max-w-6xl bg-white pb-24">
      <SiteHeader />
      <div className="mx-auto w-full max-w-2xl px-4 pt-4">
        <h1 className="text-center text-xl font-bold text-gray-900">个人中心</h1>
      </div>

      <div className="mx-auto w-full max-w-2xl p-4 space-y-6">
        {/* 账户信息（头像 + 昵称） */}
        <section>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">账户信息</h3>
          <div className="space-y-4 rounded-xl bg-gray-50 p-4">
            {/* 头像 */}
            <div className="flex items-center gap-4">
              <Image
                src={profile.avatarUrl}
                alt="我的头像"
                width={64}
                height={64}
                className="h-16 w-16 shrink-0 rounded-full border border-gray-200 object-cover"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={avatarUploading}
                  className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  {avatarUploading ? "上传中..." : "更换头像"}
                </button>
                {profile.avatarUrl && (
                  <button
                    onClick={handleRemoveAvatar}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-100"
                  >
                    移除
                  </button>
                )}
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept={ALLOWED_IMAGE_TYPES.join(",")}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleAvatarUpload(file);
                  }}
                />
              </div>
            </div>
            {avatarError && <p className="text-xs text-red-600">{avatarError}</p>}

            {/* 昵称 */}
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

        {/* 账号安全（改手机号 / 密码 / 注销 — 子页入口） */}
        <section>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">账号安全</h3>
          <div className="divide-y divide-gray-100 rounded-xl border border-gray-100">
            <Link href="/account/phone" className="flex items-center justify-between px-4 py-3 text-sm text-gray-700 transition hover:bg-gray-50">
              <span>更换手机号</span>
              <span className="text-xs text-gray-400">更换后需用新手机号验证</span>
              <span className="text-gray-300">›</span>
            </Link>
            <Link href="/account/password" className="flex items-center justify-between px-4 py-3 text-sm text-gray-700 transition hover:bg-gray-50">
              <span>{profile.hasPassword ? "修改密码" : "设置密码"}</span>
              <span className="text-xs text-gray-400">
                {profile.hasPassword ? "修改后下次登录需使用新密码" : "设置后可用手机号 + 密码登录"}
              </span>
              <span className="text-gray-300">›</span>
            </Link>
            <Link href="/account/deactivate" className="flex items-center justify-between px-4 py-3 text-sm text-gray-700 transition hover:bg-gray-50">
              <span className="text-red-600">注销账号</span>
              <span className="text-xs text-gray-400">
                {profile.role === "SUPER" ? "最高权限者不可注销" : "删除后不可恢复"}
              </span>
              <span className="text-gray-300">›</span>
            </Link>
          </div>
        </section>

        {/* 订单统计 */}
        <section>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">订单统计</h3>
          <div className="grid grid-cols-4 gap-2">
            {stats.map((s) => (
              <Link
                key={s.label}
                href={s.href}
                className={`group block rounded-xl p-3 text-center transition hover:shadow-sm ${
                  s.highlight ? "bg-primary/5" : "bg-gray-50"
                }`}
              >
                <p className={`text-xl font-bold ${s.highlight ? "text-primary" : "text-gray-900"}`}>
                  {s.value}
                </p>
                <p className="mt-0.5 text-[11px] text-gray-500 transition group-hover:text-primary">
                  {s.label} ›
                </p>
              </Link>
            ))}
          </div>
        </section>

        {/* 快捷入口 */}
        <section>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">常用功能</h3>
          <div className="divide-y divide-gray-100 rounded-xl border border-gray-100">
            <Link href="/cart" className="flex items-center justify-between px-4 py-3 text-sm text-gray-700 transition hover:bg-gray-50">
              我的购物车
              <span className="text-gray-300">›</span>
            </Link>
            <Link href="/tickets" className="flex items-center justify-between px-4 py-3 text-sm text-gray-700 transition hover:bg-gray-50">
              联系客服
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
