"use client";

// 品牌入驻激活页（/invite）— 输入邀请码 + 品牌资料 → 创建 PENDING 品牌
// 游客可访问本页（年龄门禁后），提交需登录（apiFetch 401 自动跳登录）
//
// 品牌 Logo：支持「上传本地图片」（调 POST /api/upload → OSS URL 自动填入）或
// 直接粘贴已有 OSS URL。上传限制与后端 uploadFormSchema 保持一致（前端预检，避免无效请求）。
import { useState, useRef } from "react";
import Link from "next/link";
import { apiFetch } from "@/shared/api/client";
import { Image } from "@/shared/ui/Image";

// 与 src/features/upload/upload.api.ts 的校验一致
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

export function InvitePage() {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [logo, setLogo] = useState("");
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 上传品牌 Logo：POST /api/upload（multipart，字段 file + purpose=brand）→ 成功回填 URL */
  const handleLogoUpload = async (file: File) => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError("仅支持 JPG/PNG/WebP 图片");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("图片不能超过 4MB");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("purpose", "brand");
      const res = await apiFetch("/api/upload", { method: "POST", body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // 后端 422 带 details（字段 → 具体原因），优先展示具体原因而非笼统的"请求参数不符合预期"
        const firstDetail = data?.details
          ? (Object.values(data.details as Record<string, string[]>) as string[][]).flat()[0]
          : null;
        throw new Error(firstDetail || data?.message || "上传失败");
      }
      setLogo(data.url);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "上传失败");
    } finally {
      setUploading(false);
    }
  };

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
          <label className="text-xs font-medium text-gray-500">品牌 Logo（可选）</label>
          <div className="mt-1 flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleLogoUpload(file);
                e.target.value = ""; // 允许重复选择同一文件
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="shrink-0 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
            >
              {uploading ? "上传中…" : "上传 Logo"}
            </button>
            <input
              value={logo}
              onChange={(e) => setLogo(e.target.value)}
              placeholder="https://…"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
          </div>
          {logo && (
            <div className="mt-2 flex items-center gap-2">
              <Image
                src={logo}
                alt="品牌 Logo 预览"
                width={64}
                height={64}
                className="h-16 w-16 rounded-lg border border-gray-100 object-cover"
              />
              <span className="max-w-[16rem] truncate text-xs text-gray-400">{logo}</span>
            </div>
          )}
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
