"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { CodeLoginForm, PasswordLoginForm } from "./auth.components";

async function apiCall(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "请求失败");
  return data;
}

function LoginPageContent() {
  const [mode, setMode] = useState<"code" | "password">("code");
  const router = useRouter();
  const searchParams = useSearchParams();
  // 401 自动刷新失败跳转登录时携带 ?redirect= 原页面；同样防 Open Redirect
  const rawRedirect = searchParams.get("redirect") || "/";
  const redirect =
    rawRedirect.startsWith("/") && !rawRedirect.startsWith("//") ? rawRedirect : "/";
  // 被禁用账号的 access token 过期后刷新被拒 → 携带 ?disabled=1 跳转，这里展示明确提示
  const disabled = searchParams.get("disabled") === "1";

  const handleCodeLogin = async (phone: string, code: string) => {
    await apiCall("/api/auth/verify-code", { phone, code });
    router.push(redirect);
  };

  const handleSendCode = async (phone: string) => {
    const data = await apiCall("/api/auth/send-code", { phone });
    // 演示模式：短信未送达时接口回传 demoCode，供表单页面提示展示
    return (data.demoCode as string | undefined) ?? null;
  };

  const handlePasswordLogin = async (phone: string, password: string) => {
    await apiCall("/api/auth/login", { phone, password });
    router.push(redirect);
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-8 text-center text-2xl font-bold tracking-tight">
          赛夫严选
        </h1>

        <div className="mb-6 flex rounded-lg bg-gray-100 p-1">
          <button
            onClick={() => setMode("code")}
            className={`flex-1 rounded-md py-1.5 text-sm font-medium transition ${
              mode === "code" ? "bg-white shadow-sm" : "text-gray-500"
            }`}
          >
            验证码登录
          </button>
          <button
            onClick={() => setMode("password")}
            className={`flex-1 rounded-md py-1.5 text-sm font-medium transition ${
              mode === "password" ? "bg-white shadow-sm" : "text-gray-500"
            }`}
          >
            密码登录
          </button>
        </div>

        {disabled && (
          <div className="mb-4 rounded-md bg-red-50 p-3 text-center text-sm text-red-600">
            账号已被禁用，请联系管理员
          </div>
        )}

        {mode === "code" ? (
          <CodeLoginForm onSubmit={handleCodeLogin} onSendCode={handleSendCode} />
        ) : (
          <PasswordLoginForm onSubmit={handlePasswordLogin} />
        )}

        <p className="mt-6 text-center text-xs text-gray-400">
          登录即表示您已年满 18 周岁，并同意
          <span className="underline">用户协议</span>和
          <span className="underline">隐私政策</span>
        </p>
      </div>
    </main>
  );
}

export function LoginPage() {
  // useSearchParams 依赖 Suspense 边界（Next.js App Router 静态渲染要求）
  return (
    <Suspense fallback={null}>
      <LoginPageContent />
    </Suspense>
  );
}

export function RegisterPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");

  const handleRegister = async (phone: string, code: string) => {
    await apiCall("/api/auth/register", { phone, code, password });
    router.push("/");
  };

  const handleSendCode = async (phone: string) => {
    const data = await apiCall("/api/auth/send-code", { phone });
    return (data.demoCode as string | undefined) ?? null;
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-2 text-center text-2xl font-bold tracking-tight">
          注册
        </h1>
        <p className="mb-8 text-center text-sm text-gray-500">
          验证手机号并设置密码
        </p>

        <div className="mb-4">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="设置密码（至少 6 位）"
            className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
        </div>

        <CodeLoginForm
          onSubmit={handleRegister}
          onSendCode={handleSendCode}
          submitLabel="注册"
        />

        <p className="mt-6 text-center text-sm text-gray-500">
          已有账号？
          <Link href="/login" className="text-primary underline">
            立即登录
          </Link>
        </p>
      </div>
    </main>
  );
}
