// 全局错误边界（App Router）— 客户端未捕获异常上报 Sentry（E4）。
// 未配置 DSN 时 captureException no-op，界面仍给出可读错误，不影响用户侧。
"use client";

import * as Sentry from "@sentry/nextjs";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  Sentry.captureException(error);
  return (
    <html>
      <body style={{ margin: 0, display: "grid", placeItems: "center", minHeight: "100vh" }}>
        <div style={{ textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
          <h1>页面出错了</h1>
          <p>遇到了一些问题，请稍后重试。</p>
          <button
            onClick={reset}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 1.5rem",
              borderRadius: "9999px",
              border: "1px solid #d1d5db",
              background: "#fff",
              cursor: "pointer",
            }}
          >
            重试
          </button>
        </div>
      </body>
    </html>
  );
}
