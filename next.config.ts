import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 实验性特性声明（明确记录所有开启的特性）
  experimental: {
    serverActions: {
      bodySizeLimit: "5mb",
    },
  },

  // 图片配置（本地存储为主，后续切 OSS）
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },

  // 生产构建优化
  compiler: {
    removeConsole: process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
  },

  // 禁止 X-Powered-By 头
  poweredByHeader: false,
};

export default nextConfig;
