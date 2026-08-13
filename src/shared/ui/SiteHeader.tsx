// 共享顶部导航 — 登录态感知（首页/购物车/个人中心/订单/品牌后台/管理后台统一入口）
// - 挂载时查询 /api/auth/me 拿当前用户角色，按角色渲染导航
// - 未登录：登录/注册/商家入驻；USER：购物车/我的/商家入驻；BRAND：购物车/我的/品牌中心；ADMIN：我的/管理后台
// - 退出登录统一在这里（清 Cookie → 回登录页），替代各页面重复的 handleLogout
//
// ⚠️ me 查询用裸 fetch 而非 apiFetch：apiFetch 对 401 会自动刷新 token 失败后硬跳登录页，
// 会把未登录访客从首页踢走。这里 401 一律视为「未登录」，仅反映当前 Cookie 状态。
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface MeUser {
  id: string;
  nickname: string | null;
  role: "USER" | "BRAND" | "ADMIN";
  ageVerified: boolean;
}

const NAV: Record<string, { href: string; label: string }[]> = {
  USER: [
    { href: "/cart", label: "购物车" },
    { href: "/account", label: "我的" },
    { href: "/invite", label: "商家入驻" },
  ],
  BRAND: [
    { href: "/cart", label: "购物车" },
    { href: "/account", label: "我的" },
    { href: "/brand", label: "品牌中心" },
  ],
  ADMIN: [{ href: "/account", label: "我的" }, { href: "/admin", label: "管理后台" }],
};

const GUEST_NAV = [
  { href: "/invite", label: "商家入驻" },
  { href: "/login", label: "登录" },
  { href: "/register", label: "注册" },
];

export function SiteHeader() {
  const router = useRouter();
  const [user, setUser] = useState<MeUser | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.success) setUser(data.user);
      })
      .catch(() => {
        /* 网络异常视为未登录，不抛未处理 rejection */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      /* 后端 logout 无条件清 Cookie 返回成功，网络异常也继续前端清态 */
    }
    setUser(null);
    router.push("/login");
  };

  // 未返回前只渲染站点名，避免「未登录态」闪跳
  const navItems = !loaded ? [] : user ? NAV[user.role] ?? [] : GUEST_NAV;

  return (
    <header className="sticky top-0 z-10 border-b bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="text-lg font-bold tracking-tight">
          赛夫严选
        </Link>

        <nav className="flex items-center gap-4 text-sm text-gray-600">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="transition hover:text-gray-900"
            >
              {item.label}
            </Link>
          ))}
          {user && (
            <button
              type="button"
              onClick={handleLogout}
              disabled={loggingOut}
              className="rounded-lg border border-gray-200 px-3 py-1.5 transition hover:bg-gray-50 disabled:opacity-50"
            >
              {loggingOut ? "退出中..." : "退出"}
            </button>
          )}
        </nav>
      </div>
    </header>
  );
}
