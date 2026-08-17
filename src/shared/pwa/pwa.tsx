"use client";

// PWA 接线：注册 Service Worker + 构建版本轮询提示刷新
//
// - 缓存策略与离线行为在 public/sw.js（Network Only / SWR / Network First）实现
// - 构建版本号由 prebuild 生成的 public/build-id.json 提供；回到前台时轮询比对，
//   发现新部署 → 弹条提示刷新（README「构建版本校验 + 检测新版本弹条」）
// - 仅生产构建注册 SW：dev 热更新会与缓存冲突（process.env.NODE_ENV 构建时内联替换）
import { useEffect, useRef, useState } from "react";

const BUILD_ID_URL = "/build-id.json";

export function PwaInstaller() {
  const [showUpdate, setShowUpdate] = useState(false);
  const baseline = useRef<string | null>(null);

  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // 注册失败静默：不支持 SW / 沙箱环境不影响使用
      });
    }

    const checkVersion = async () => {
      try {
        // cache: "no-store" 绕过 SW 缓存，确保拿到服务器上的最新版本
        const res = await fetch(`${BUILD_ID_URL}?t=${Date.now()}`, {
          cache: "no-store",
        });
        if (!res.ok) return; // dev 未生成 build-id.json（404）→ 静默
        const data = (await res.json()) as { version?: string };
        if (!data.version) return;
        if (baseline.current === null) {
          baseline.current = data.version; // 首次：记录基准，不弹
          return;
        }
        if (data.version !== baseline.current) {
          baseline.current = data.version;
          setShowUpdate(true);
        }
      } catch {
        // 网络异常 → 静默（下次回前台再试）
      }
    };

    void checkVersion();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void checkVersion();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  if (!showUpdate) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-xl bg-gray-900 px-4 py-3 text-sm text-white shadow-lg">
      <span>发现新版本，刷新后生效</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-gray-900 transition hover:opacity-90"
      >
        立即刷新
      </button>
      <button
        type="button"
        onClick={() => setShowUpdate(false)}
        className="rounded-lg px-2 py-1.5 text-xs text-gray-300 transition hover:text-white"
      >
        稍后
      </button>
    </div>
  );
}
