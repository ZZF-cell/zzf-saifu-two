import type { NextConfig } from "next";

// 图片域名白名单：从 OSS_PUBLIC_DOMAIN 推导（可逗号分隔多域名，去协议/路径）
// ⚠️ 未配置时回退通配 **（不破 build）；生产部署务必设置 OSS_PUBLIC_DOMAIN 收紧白名单，
// 否则 next/image 会渲染任意外链。与 Image 组件的 oss 源判定配套（组件层不维护 client 白名单）。
const OSS_PUBLIC_DOMAIN = process.env.OSS_PUBLIC_DOMAIN ?? "";
const ossHosts = OSS_PUBLIC_DOMAIN.split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.replace(/^https?:\/\//, "").split("/")[0]);

const nextConfig: NextConfig = {
  // 实验性特性声明（明确记录所有开启的特性）
  experimental: {
    serverActions: {
      bodySizeLimit: "5mb",
    },
  },

  // 图片配置 — OSS 域名白名单（未配置 OSS_PUBLIC_DOMAIN 时回退通配，见文件头注释）
  images: {
    remotePatterns:
      ossHosts.length > 0
        ? ossHosts.map((hostname) => ({ protocol: "https", hostname }))
        : [{ protocol: "https", hostname: "**" }],
  },

  // 生产构建优化
  compiler: {
    removeConsole: process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
  },

  // 禁止 X-Powered-By 头
  poweredByHeader: false,
};

export default nextConfig;
