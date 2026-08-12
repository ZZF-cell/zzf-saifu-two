"use client";

// 品牌入驻激活页（/invite）— 输入邀请码 + 品牌资料 → 创建 PENDING 品牌
// 游客可访问本页（年龄门禁后），提交需登录（apiFetch 401 自动跳登录）
import { useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/shared/api/client";

export function InvitePage() {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [logo, setLogo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const res = await apiFetch("/api/invite/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, name, logo: logo.trim() || undefined }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.message || "激活失败");
      }
      setSubmitted(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "激活失败");
    } finally {
      setSubmitting(false);
    }
  };

  // 成功态：引导「审核通过后重新登录」——因 access_token 15min 内仍携带 USER 角色
  if (submitted) {
    return (
      <main className="mx-auto min-h-screen max-w-lg bg-white px-4 py-10">
        <div className="rounded-xl border border-green-100 bg-green-50 p-6 text-center">
          <p className="text-lg font-bold text-green-700">品牌入驻申请已提交</p>
          <p className="mt-2 text-sm text-green-600">请等待平台审核。</p>
          <p className="mt-4 text-xs leading-relaxed text-gray-500">
            审核通过后请<b>重新登录</b>，即可进入
            <Link href="/brand" className="text-primary">品牌方后台 /brand</Link>。
          </p>
          <Link
            href="/"
            className="mt-6 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
          >
            返回商城首页
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-lg bg-white px-4 py-10">
      <h1 className="text-center text-xl font-bold">品牌方入驻</h1>
      <p className="mt-1 text-center text-xs text-gray-400">凭管理员发放的入驻邀请码激活品牌</p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>
        )}

        <div>
          <label className="text-xs font-medium text-gray-500">入驻邀请码</label>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="如 INVITE-BRAND-101"
            autoComplete="off"
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm uppercase focus:border-primary focus:outline-none"
            required
          />
        </div>

        <div>
          <label className="text-xs font-medium text-gray-500">品牌名称</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="您的品牌名称"
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-primary focus:outline-none"
            required
          />
        </div>

        <div>
          <label className="text-xs font-medium text-gray-500">品牌 Logo URL（可选）</label>
          <input
            value={logo}
            onChange={(e) => setLogo(e.target.value)}
            placeholder="https://…"
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-primary py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "提交中…" : "提交入驻申请"}
        </button>
      </form>

      <p className="mt-6 text-center text-xs text-gray-400">
        还没有账号？{" "}
        <Link href="/register" className="text-primary">先注册</Link>
        {" 或 "}
        <Link href="/login?redirect=/invite" className="text-primary">登录</Link>
      </p>
    </main>
  );
}
