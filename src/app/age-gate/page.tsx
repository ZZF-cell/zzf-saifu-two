"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function AgeGateContent() {
  const [confirmed, setConfirmed] = useState(false);
  const [showContent, setShowContent] = useState(false);
  const [rejected, setRejected] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawRedirect = searchParams.get("redirect") || "/";
  // 防止 Open Redirect：只允许站内路径，阻止 //evil.com 协议相对 URL 和 https:// 绝对 URL
  const redirect =
    rawRedirect.startsWith("/") && !rawRedirect.startsWith("//") ? rawRedirect : "/";

  const handleConfirm = async () => {
    // L4：签名 cookie 只能由服务端签发（/api/user/age-verify 返回 Set-Cookie，
    // HMAC 验签由中间件完成）。修复前客户端 document.cookie 直接写 age_verified=1
    // 一行 JS 即可伪造绕过门禁；现在客户端不写任何可伪造的 age_verified。
    // 同步失败 → fail-closed 停留门禁，不给无签名入口。
    try {
      await fetch("/api/user/age-verify", { method: "POST", credentials: "include" });
    } catch {
      return;
    }
    setConfirmed(true);
    setTimeout(() => router.push(redirect), 600);
  };

  const handleReject = () => {
    // 拒绝 → 直接进入硬性阻止态，绝不回到确认界面（防止「确认-拒绝-再确认」绕过）
    setRejected(true);
    window.close();
    // window.close() 仅对脚本打开的窗口生效；普通标签页会失败，此时停留在阻止页
  };

  return (
    <main className="age-gate-overlay fixed inset-0 z-50 flex items-center justify-center bg-primary/95 p-6">
      <div className="flex max-w-sm flex-col items-center text-center text-white">
        {rejected ? (
          // 拒绝后的硬性阻止页：无任何继续入口
          <div className="flex flex-col items-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/10 text-2xl">🚫</div>
            <h1 className="mt-4 text-xl font-bold tracking-tight">无法访问</h1>
            <p className="mt-3 text-sm leading-relaxed text-white/80">
              本平台仅面向年满 18 周岁的成年人开放。
              <br />
              感谢您的理解。
            </p>
          </div>
        ) : !showContent ? (
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
