// Sentry 服务端初始化（E4）— 仅在配置 SENTRY_DSN 时启用。
// 未配置（本地 dev / CI）时 SDK 不初始化，captureException/captureMessage 为 no-op，
// build 与运行均不依赖任何 Sentry env。生产 Vercel env 配 SENTRY_DSN 后自动生效。
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    // 正式环境抽样 10% trace；dev 不采样
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 0,
  });
}
