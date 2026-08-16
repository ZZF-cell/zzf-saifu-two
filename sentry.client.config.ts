// Sentry 客户端初始化（E4）— 仅在配置 NEXT_PUBLIC_SENTRY_DSN 时启用。
// NEXT_PUBLIC_ 前缀用于客户端 bundle 内联；未配置时 SDK 不初始化，运行时 no-op。
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 0,
  });
}
