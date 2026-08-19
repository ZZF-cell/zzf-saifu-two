"use client";

// 账号安全子页表单（/account/phone、/account/password、/account/deactivate）
// 每个功能独立成页：AccountPage 只保留入口卡片，点击进入本文件对应组件后展示完整表单
import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { UserProfile } from "./user.types";
import { apiFetch } from "@/shared/api/client";
import { SiteHeader } from "@/shared/ui/SiteHeader";

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

/** 子页通用外壳：顶部导航 + 标题 + 返回个人中心 */
function SubPageShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-screen max-w-6xl bg-white pb-24">
      <SiteHeader />
      <div className="mx-auto w-full max-w-2xl px-4 pt-4">
        <Link
          href="/account"
          className="inline-flex items-center gap-1 text-sm text-gray-500 transition hover:text-gray-900"
        >
          ← 返回个人中心
        </Link>
        <h1 className="mt-2 text-center text-xl font-bold text-gray-900">{title}</h1>
      </div>
      <div className="mx-auto w-full max-w-2xl p-4">{children}</div>
    </main>
  );
}

function useProfile() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    apiCall("GET", "/api/user/profile")
      .then(setProfile)
      .catch(() => {
        // 401 时 apiFetch 已跳转登录页，这里只兜底提示
        setError("个人信息加载失败，请刷新重试");
      })
      .finally(() => setLoading(false));
  }, []);

  return { profile, loading, error };
}

// ── 绑定手机号（/account/phone） ──

export function ChangePhoneForm() {
  const { profile, loading, error } = useProfile();
  const [newPhone, setNewPhone] = useState("");
  const [code, setCode] = useState("");
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState("");
  const [success, setSuccess] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const handleSendCode = async () => {
    if (!/^1[3-9]\d{9}$/.test(newPhone)) {
      setErr("请输入正确的手机号");
      return;
    }
    setErr("");
    setSuccess("");
    try {
      const data = await apiCall("POST", "/api/auth/send-code", { phone: newPhone });
      const demo = (data.demoCode as string | undefined) ?? null;
      if (demo) setDemoCode(demo);
      setCountdown(60);
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) {
            if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
            return 0;
          }
          return c - 1;
        });
      }, 1000);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "发送失败");
    }
  };

  const handleSubmit = async () => {
    if (code.length !== 6) {
      setErr("请输入 6 位验证码");
      return;
    }
    setPending(true);
    setErr("");
    setSuccess("");
    try {
      await apiCall("POST", "/api/user/change-phone", { newPhone, code });
      setSuccess("手机号已更换，下次登录请使用新手机号");
      setNewPhone("");
      setCode("");
      setDemoCode(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "更换失败");
    } finally {
      setPending(false);
    }
  };

  if (loading) {
    return <SubPageShell title="绑定手机号"><div className="h-32 animate-pulse rounded-xl bg-gray-100" /></SubPageShell>;
  }
  if (!profile) {
    return <SubPageShell title="绑定手机号"><p className="py-20 text-center text-gray-400">{error || "个人信息加载失败"}</p></SubPageShell>;
  }

  return (
    <SubPageShell title="绑定手机号">
      <div className="rounded-xl bg-gray-50 p-4">
        <p className="text-sm font-medium text-gray-900">更换绑定手机号</p>
        <p className="mb-4 mt-0.5 text-xs text-gray-400">
          更换后需用新手机号验证，旧手机号不可再登录；验证码 5 分钟内有效
        </p>
        <div className="flex gap-2">
          <input
            type="tel"
            maxLength={11}
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value.replace(/\D/g, ""))}
            placeholder="输入新手机号"
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            onClick={handleSendCode}
            disabled={countdown > 0 || pending || newPhone.length !== 11}
            className="whitespace-nowrap rounded-lg bg-primary px-4 py-2 text-sm text-white transition disabled:opacity-50"
          >
            {countdown > 0 ? `${countdown}s` : "获取验证码"}
          </button>
        </div>
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            maxLength={6}
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="6 位验证码"
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={handleSubmit}
            disabled={pending || code.length !== 6}
            className="whitespace-nowrap rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-100 disabled:opacity-50"
          >
            {pending ? "提交中..." : "确认更换"}
          </button>
        </div>
        {demoCode && (
          <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
            演示模式验证码：
            <span className="font-mono font-bold">{demoCode}</span>
          </p>
        )}
        {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
        {success && <p className="mt-2 text-xs text-green-600">{success}</p>}
      </div>
    </SubPageShell>
  );
}

// ── 设置 / 修改密码（/account/password） ──

export function ChangePasswordForm() {
  const { profile, loading, error } = useProfile();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState("");
  const [success, setSuccess] = useState("");

  const handleSubmit = async () => {
    if (newPassword.length < 6) {
      setErr("密码至少 6 位");
      return;
    }
    if (newPassword !== confirmPassword) {
      setErr("两次输入的新密码不一致");
      return;
    }
    if (profile?.hasPassword && oldPassword.length < 6) {
      setErr("请输入原密码");
      return;
    }
    setPending(true);
    setErr("");
    setSuccess("");
    try {
      await apiCall("POST", "/api/auth/change-password", {
        ...(profile?.hasPassword ? { oldPassword } : {}),
        newPassword,
      });
      setSuccess("密码已更新");
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "修改失败");
    } finally {
      setPending(false);
    }
  };

  if (loading) {
    return <SubPageShell title="设置密码"><div className="h-32 animate-pulse rounded-xl bg-gray-100" /></SubPageShell>;
  }
  if (!profile) {
    return <SubPageShell title="设置密码"><p className="py-20 text-center text-gray-400">{error || "个人信息加载失败"}</p></SubPageShell>;
  }

  const hasPassword = profile.hasPassword;

  return (
    <SubPageShell title={hasPassword ? "修改密码" : "设置密码"}>
      <div className="rounded-xl bg-gray-50 p-4">
        <p className="text-sm font-medium text-gray-900">
          {hasPassword ? "修改登录密码" : "设置登录密码"}
        </p>
        <p className="mb-4 mt-0.5 text-xs text-gray-400">
          {hasPassword ? "修改后下次登录需使用新密码" : "设置后可用手机号 + 密码登录"}
        </p>
        <div className="space-y-2">
          {hasPassword && (
            <input
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              placeholder="原密码"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
          )}
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="新密码（至少 6 位）"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="确认新密码"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={handleSubmit}
            disabled={pending}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "提交中..." : "保存密码"}
          </button>
          {err && <p className="text-xs text-red-600">{err}</p>}
          {success && <p className="text-xs text-green-600">{success}</p>}
        </div>
      </div>
    </SubPageShell>
  );
}

// ── 注销账号（/account/deactivate） ──

export function DeactivateSection() {
  const router = useRouter();
  const { profile, loading, error } = useProfile();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState("");

  const handleDeactivate = useCallback(async () => {
    if (profile?.hasPassword && password.length < 6) {
      setErr("请输入登录密码");
      return;
    }
    setPending(true);
    setErr("");
    try {
      await apiCall("POST", "/api/user/deactivate", {
        confirm: true,
        ...(profile?.hasPassword ? { password } : {}),
      });
      // 账号已硬删除：吊销会话 + 清除 cookie，回到登录页
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
      router.push("/login");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "注销失败");
    } finally {
      setPending(false);
    }
  }, [profile?.hasPassword, password, router]);

  if (loading) {
    return <SubPageShell title="注销账号"><div className="h-32 animate-pulse rounded-xl bg-gray-100" /></SubPageShell>;
  }
  if (!profile) {
    return <SubPageShell title="注销账号"><p className="py-20 text-center text-gray-400">{error || "个人信息加载失败"}</p></SubPageShell>;
  }

  const isSuper = profile.role === "SUPER";

  return (
    <SubPageShell title="注销账号">
      <div className="rounded-xl border border-red-100 bg-red-50/60 p-4">
        <p className="text-sm text-gray-700">
          注销后账号数据将被永久删除，且<b>不可恢复</b>。历史订单与咨询工单将匿名保留（不显示您的身份）。
        </p>
        <p className="mt-2 text-xs text-gray-500">
          请确认您已妥善处理未完成的订单、退款与品牌相关事宜。
        </p>
        {isSuper && (
          <p className="mt-2 text-xs text-red-600">最高权限者账号不可注销</p>
        )}
        {!isSuper && (
          <button
            onClick={() => { setConfirmOpen(true); setErr(""); }}
            className="mt-3 rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50"
          >
            注销账号
          </button>
        )}
      </div>

      {/* 注销确认弹窗 */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-bold text-gray-900">确认注销账号？</h3>
            <p className="mt-2 text-sm text-gray-500">
              此操作<b>不可逆</b>：账号将被永久删除，历史订单与咨询工单将匿名保留。
            </p>
            {profile.hasPassword && (
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入登录密码确认"
                className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              />
            )}
            {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
            <div className="mt-4 flex gap-2">
              <button
                onClick={handleDeactivate}
                disabled={pending}
                className="flex-1 rounded-lg bg-red-600 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
              >
                {pending ? "注销中..." : "确认注销"}
              </button>
              <button
                onClick={() => { setConfirmOpen(false); setPassword(""); setErr(""); }}
                className="flex-1 rounded-lg border border-gray-200 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </SubPageShell>
  );
}
