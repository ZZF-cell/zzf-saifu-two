"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function AgeGateContent() {
  const [confirmed, setConfirmed] = useState(false);
  const [showContent, setShowContent] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawRedirect = searchParams.get("redirect") || "/";
  // 防止 Open Redirect 攻击：只允许站内相对路径
  const redirect = rawRedirect.startsWith("/") ? rawRedirect : "/";

  const handleConfirm = () => {
    // 设置年龄验证 Cookie（1 年有效），生产环境加 Secure 标志
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `age_verified=1; path=/; max-age=${365 * 24 * 60 * 60}; SameSite=Strict${secure}`;
    // 如果已登录，同步更新 DB 中的 ageVerified（best-effort，不阻塞跳转）
    fetch("/api/user/age-verify", { method: "POST", credentials: "include" }).catch(() => {});
    setConfirmed(true);
    setTimeout(() => router.push(redirect), 600);
  };

  const handleReject = () => {
    setShowContent(false);
    window.close();
    // 如果 close 失败，显示无法离开的提示
    setTimeout(() => setShowContent(true), 500);
  };

  return (
    <main className="age-gate-overlay fixed inset-0 z-50 flex items-center justify-center bg-primary/95 p-6">
      <div className="flex max-w-sm flex-col items-center text-center text-white">
        {!showContent ? (
          // 第一步：确认年满 18 周岁
          <>
            <h1 className="text-2xl font-bold tracking-tight">年龄确认</h1>
            <p className="mt-4 text-sm leading-relaxed text-white/80">
              本平台仅面向年满 18 周岁的成年人开放。
              <br />
              您已年满 18 周岁吗？
            </p>
            <div className="mt-8 flex w-full gap-3">
              <button
                onClick={handleReject}
                className="flex-1 rounded-lg border border-white/20 py-2.5 text-sm font-medium transition hover:bg-white/10"
              >
                未满 18 岁
              </button>
              <button
                onClick={() => setShowContent(true)}
                className="flex-1 rounded-lg bg-white py-2.5 text-sm font-medium text-primary transition hover:opacity-90"
              >
                已满 18 岁
              </button>
            </div>
          </>
        ) : confirmed ? (
          // 确认后过渡
          <div className="flex flex-col items-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white border-t-transparent" />
            <p className="mt-4 text-sm text-white/80">正在进入...</p>
          </div>
        ) : (
          // 第二步：隐私承诺
          <>
            <h2 className="text-xl font-bold tracking-tight">隐私承诺</h2>
            <ul className="mt-4 space-y-2 text-left text-sm text-white/80">
              <li>🔒 您的手机号仅存储不可逆哈希值</li>
              <li>📦 所有订单默认匿名包装配送</li>
              <li>🗑️ 订单可一键不可逆销毁</li>
              <li>🤫 我们不会向任何第三方泄露您的信息</li>
            </ul>
            <div className="mt-8 flex w-full gap-3">
              <button
                onClick={() => setShowContent(false)}
                className="flex-1 rounded-lg border border-white/20 py-2.5 text-sm font-medium transition hover:bg-white/10"
              >
                返回
              </button>
              <button
                onClick={handleConfirm}
                className="flex-1 rounded-lg bg-white py-2.5 text-sm font-medium text-primary transition hover:opacity-90"
              >
                确认进入
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export default function AgeGatePage() {
  return (
    <Suspense fallback={null}>
      <AgeGateContent />
    </Suspense>
  );
}
