"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CodeLoginForm, PasswordLoginForm } from "./auth.components";

// ── API helpers ──

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

// ── 登录页 ──

export function LoginPage() {
  const [mode, setMode] = useState<"code" | "password">("code");
  const router = useRouter();

  const handleCodeLogin = async (phone: string, code: string) => {
    await apiCall("/api/auth/verify-code", { phone, code });
    router.push("/");
  };

  const handleSendCode = async (phone: string) => {
    await apiCall("/api/auth/send-code", { phone });
  };

  const handlePasswordLogin = async (phone: string, password: string) => {
    await apiCall("/api/auth/login", { phone, password });
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-8 text-center text-2xl font-bold tracking-tight">
          赛夫严选
        </h1>

        {/* 切换 Tab */}
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

// ── 注册页 ──

export function RegisterPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");

  const handleRegister = async (phone: string, code: string) => {
    await apiCall("/api/auth/register", { phone, code, password });
    router.push("/");
  };

  const handleSendCode = async (phone: string) => {
    await apiCall("/api/auth/send-code", { phone });
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

        <CodeLoginForm onSubmit={handleRegister} onSendCode={handleSendCode} />

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
