import type { NextConfig } from "next";

// 图片域名白名单（M15）：仅来自 OSS 配置的可信域名可经 /_next/image 被服务端拉取优化。
// 来源 = OSS_PUBLIC_DOMAIN（可逗号分隔，去协议/路径）+ OSS 桶默认域名。
// 未配置任何 OSS env → 空白名单（fail-closed）：任何 https 外链都不被代理。
// 绝不回退通配 `**`——否则任何域名都能经 /_next/image 被服务端拉取 → 开放图片代理/SSRF。
// 与 Image 组件的 oss 源判定配套（组件层不维护 client 白名单，避免双名单漂移）。
function deriveImageHosts(): string[] {
  const hosts = new Set<string>();
  if (process.env.OSS_BUCKET && process.env.OSS_REGION) {
    hosts.add(`${process.env.OSS_BUCKET}.${process.env.OSS_REGION}.aliyuncs.com`);
  }
  for (const raw of (process.env.OSS_PUBLIC_DOMAIN ?? "").split(",")) {
    const host = raw.trim().replace(/^https?:\/\//, "").split("/")[0];
    if (host) hosts.add(host);
  }
  return [...hosts];
}
const imageHosts = deriveImageHosts();

const nextConfig: NextConfig = {
  // 实验性特性声明（明确记录所有开启的特性）
  experimental: {
    serverActions: {
      bodySizeLimit: "5mb",
    },
  },

  // 图片配置 — OSS 域名白名单（fail-closed，见文件头注释 M15）
  images: {
    remotePatterns: imageHosts.map((hostname) => ({ protocol: "https", hostname })),
  },

  // 生产构建优化
  compiler: {
    removeConsole: process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
  },

  // 禁止 X-Powered-By 头
  poweredByHeader: false,

  // L11 安全响应头（防点击劫持/嵌入/嗅探/信息泄露）。
  // CSP 只设 frame-ancestors 'none'（与 X-Frame-Options: DENY 双保险），
  // 不设宽松指令避免误伤内联样式/脚本（Tailwind 内联需要）。
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
