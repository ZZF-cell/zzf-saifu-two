// 工作台顶部栏 — 客服中心 /service、质检中心 /inspect 等独立工作台使用
// 与主站 SiteHeader 的区别：不带购物车/商家入驻等主站导航，只有「品牌 + 工作台名」+ 个人中心/退出
// 满足「客服工作台只有客服页面，不跟主页面混在一起」：工作台内只能回主页面/个人中心，无其他职责入口
"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";

export function WorkbenchHeader({ title }: { title: string }) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      /* 后端 logout 无条件清 Cookie 返回成功，网络异常也继续前端清态 */
    }
    router.push("/login");
  };

  return (
    <header className="sticky top-0 z-10 border-b bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <Link href="/" className="flex items-center gap-2">
            <Image
              src="/icons/icon-192x192.png"
              alt="赛夫严选"
              width={32}
              height={32}
              className="h-8 w-8 rounded-lg"
              priority
            />
            <span className="text-lg font-bold tracking-tight">赛夫严选</span>
          </Link>
          <span className="text-gray-300">/</span>
          <span className="text-sm font-medium text-gray-600">{title}</span>
        </div>
        <nav className="flex items-center gap-4 text-sm text-gray-600">
          <Link href="/" className="transition hover:text-gray-900">
            主页面
          </Link>
          <Link href="/account" className="transition hover:text-gray-900">
            个人中心
          </Link>
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="rounded-lg border border-gray-200 px-3 py-1.5 transition hover:bg-gray-50 disabled:opacity-50"
          >
            {loggingOut ? "退出中..." : "退出"}
          </button>
        </nav>
      </div>
    </header>
  );
}
