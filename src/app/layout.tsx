import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PwaInstaller } from "@/shared/pwa/pwa";

export const metadata: Metadata = {
  title: "赛夫严选 — 隐私配送 · 正品保障",
  description: "成人用品品牌聚合严选电商平台",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "赛夫严选",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#1a1a2e",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-white text-gray-900 antialiased">
        {children}
        {/* PWA：注册 Service Worker + 构建版本更新提示（仅生产生效） */}
        <PwaInstaller />
      </body>
    </html>
  );
}
