// Sentry 接线（E4）：register() 按运行时加载对应 config；onRequestError 捕获
// 逃出 Route Handler 的未处理异常（Next 15 App Router）。
// 未配置 DSN 时 SDK 不初始化 → 捕获为 no-op，不依赖任何 Sentry env 也能 build/run。
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
