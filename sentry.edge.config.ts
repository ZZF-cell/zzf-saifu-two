// Sentry Edge 运行时初始化（E4）— middleware/edge route 用，同 server 判定。
// 未配置 SENTRY_DSN 时 SDK 不初始化，运行时 no-op。
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 0,
  });
}
